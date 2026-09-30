import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { criticalStoreLoadFailure } from "./store-diagnostics";
import { parseDataUrl } from "../image";
import type {
  CodexContentPart,
  CodexParsedRequest,
  CodexToolResultMessage,
} from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import { MAX_COMPACTION_EXECUTION_STALL_MS } from "./concurrency";
import type { CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";


/**
 * Durable, idempotent record of committed compaction handoffs.
 *
 * The summary lifetime must not be tied to the HTTP request that started the compaction: a
 * Codex client timeout can orphan an otherwise successful handoff, and a retry must receive the
 * SAME committed summary instead of replaying the transport. Keys are stored hashed; summaries
 * are stored whole so a retry can be answered without any browser work.
 */
export class ChatGptCompactionHandoffStore {
  private readonly entries = new Map<string, { summary: string; committedAt: string; traceId: string }>();
  private loaded = false;

  constructor(private readonly path?: string) {}

  lookup(executionKey: string): { summary: string; committedAt: string; traceId: string } | undefined {
    this.load();
    return this.entries.get(this.key(executionKey));
  }

  /**
   * Commit the compacted summary for this turn. Idempotent: committing the identical summary
   * again reports `duplicate: true`; committing a DIFFERENT summary for the same turn is a
   * handoff conflict and fails closed rather than creating two competing compacted histories.
   */
  commit(executionKey: string, summary: string, traceId: string): { duplicate: boolean } {
    this.load();
    const key = this.key(executionKey);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.summary !== summary) {
        throw new Error("ChatGPT compaction handoff conflict: a different summary was already committed for this turn");
      }
      return { duplicate: true };
    }
    this.entries.set(key, { summary, committedAt: new Date().toISOString(), traceId });
    this.persist();
    return { duplicate: false };
  }

  private key(executionKey: string): string {
    return createHash("sha256").update(executionKey).digest("hex");
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (!this.path || !existsSync(this.path)) {
        this.loaded = true;
        return;
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as {
        version?: number;
        entries?: Record<string, { summary?: unknown; committedAt?: unknown; traceId?: unknown }>;
      };
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
        throw new Error(`Invalid ChatGPT compaction handoff store: ${this.path}`);
      }
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (typeof value?.summary !== "string" || typeof value.committedAt !== "string" || typeof value.traceId !== "string") {
          throw new Error(`Invalid ChatGPT compaction handoff entry: ${this.path}`);
        }
        this.entries.set(key, { summary: value.summary, committedAt: value.committedAt, traceId: value.traceId });
      }
      // Only a fully validated load marks the store as loaded; corruption keeps failing closed.
      this.loaded = true;
    } catch (error) {
      throw criticalStoreLoadFailure("CompactionHandoff", this.path, error);
    }
  }

  private persist(): void {
    if (!this.path) return;
    const payload = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}
`);
  }
}

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function withZeroRiskCompactionInstruction(result: BrokerToolResult): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(true),
      },
    ],
  };
}

function interruptedByZeroRiskCompaction(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: zeroRiskActiveCompactionToolResultInstruction(false),
    }],
    isError: true,
  };
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset < 0) return `${normalized}\n\n${appendix}`;
  if (normalized.slice(markerOffset + 1).trimEnd() !== appendix) {
    throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
  }
  return normalized;
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

/**
 * Execution/settlement budget for an admitted compaction: the maximum time without meaningful
 * progress after a browser slot has been granted. It must never measure queue wait — a queued
 * compaction has not begun executing (see MAX_COMPACTION_EXECUTION_STALL_MS). Retained name kept
 * for the handoff-scoped deadline this module arms at admission.
 */
export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = MAX_COMPACTION_EXECUTION_STALL_MS;

function boundedCompactionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(
          token,
          request.callId,
          toolResult(result),
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      // The one structured checkpoint message reuses this exact retained tab. It must not race the
      // helper's /turn/end handshake for the response that consumed the canonical tool results.
      // `requestCompaction` leaves those results untouched and only intercepts a later tool call, so
      // a zero delivery count proves that this is an ordinary publishable terminal response.
      await withCompactionAbort(source.physicalSettlement, signal);
      return {
        answer: browserOutcome.answer,
        compactionInstructionDelivered,
      };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function settleActiveZeroRiskCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBrokerOwner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.runtime.manualControl) {
      throw new Error("The active Zero Risk compaction source has no manual MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for Zero Risk compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      const interruptedQueued = await broker.requestCompaction(
        token,
        interruptedByZeroRiskCompaction(),
      );
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId)!;
        const canonical = toolResult(result);
        await broker.completeTool(
          token,
          request.callId,
          interruptedQueued === 0 && index === outstanding.length - 1
            ? withZeroRiskCompactionInstruction(canonical)
            : canonical,
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      await withCompactionAbort(source.physicalSettlement, signal);
      const instructionDelivered = outstanding.length > 0
        || await broker.compactionDeliveryCount(token) > 0;
      if (!instructionDelivered) return undefined;
      const summary = browserOutcome.answer.trim();
      if (!summary) throw new Error("The active Zero Risk response returned an empty compaction summary");
      return summary;
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export interface RetainedCompactionHandoffLifecycle {
  /** The checkpoint browser turn was accepted into the logical queue (queue phase began). */
  onQueued?: () => void;
  /** The scheduler granted the checkpoint turn a browser slot (execution phase began). */
  onAdmitted?: () => void;
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  lifecycle?: RetainedCompactionHandoffLifecycle,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = boundedCompactionTimeout(timeoutMs);
  const deadline = new AbortController();
  const handoffTimeoutError = new ChatGptWebAdapterError(
    `ChatGPT compaction handoff did not complete within ${operationTimeoutMs}ms after browser admission`,
    { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_timeout", retryable: false },
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  // The handoff deadline covers only the admitted execution of the checkpoint message. While
  // that turn is queued there is no handoff execution to time out, so arming waits for the
  // browser slot instead of starting at request time.
  const armHandoffDeadline = (): void => {
    if (deadline.signal.aborted) return;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(
      () => deadline.abort(handoffTimeoutError),
      operationTimeoutMs,
    );
    deadlineTimer.unref?.();
  };
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: CompactionTransactionHandle | undefined;
  let transactionPromise: Promise<CompactionTransactionHandle> | undefined;
  let handoffWaiter: Promise<string> | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  // Admission gate: every broker binding below waits for the browser slot. The one-shot control
  // capability is created only at admission — binding it while the checkpoint turn is queued
  // would let its bounded TTL expire before any handoff could begin.
  let resolveAdmission!: () => void;
  const admissionPromise = new Promise<void>(resolve => { resolveAdmission = resolve; });
  const beginTransactionAtAdmission = (): Promise<CompactionTransactionHandle> => {
    transactionPromise ??= admissionPromise.then(() =>
      broker.beginCompactionTransaction(traceId, operationTimeoutMs)
    ).then(lateTransaction => {
      if (operationSignal.aborted) {
        broker.abortCompactionTransaction(lateTransaction.token);
        throw operationSignal.reason instanceof Error
          ? operationSignal.reason
          : new Error("ChatGPT compaction handoff aborted before admission");
      }
      transaction = lateTransaction;
      return lateTransaction;
    });
    return transactionPromise;
  };
  // The waiter must register the moment the control capability exists and before the browser
  // turn can settle, so an immediate terminal response can never outrun the handoff race.
  // Admission itself waits only for the capability, never for the summary.
  try {
    const instructionAtAdmission = async () => structuredCompactionHandoffInstruction(
      await beginTransactionAtAdmission(),
    );
    const prepare = async () => ({ text: await instructionAtAdmission(), images: [], release: () => {} });
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      // The retained connector exposes only the one-shot control token embedded above. It does
      // not receive an ordinary Codex tool environment for this checkpoint message.
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      compaction: true,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
      ...(lifecycle?.onQueued ? { onQueued: lifecycle.onQueued } : {}),
      onSlotGranted: async () => {
        armHandoffDeadline();
        lifecycle?.onAdmitted?.();
        resolveAdmission();
        await beginTransactionAtAdmission();
        handoffWaiter ??= broker.waitForCompactionHandoff(transaction!.token, operationSignal);
      },
    });
    // The waiter registration is chained onto the admission settlement BEFORE the check
    // continuation below: in production the worker defers onSlotGranted through the microtask
    // queue, so a check attached ahead of registration would always observe handoffWaiter as
    // undefined and fail every retained handoff. The ??= keeps registration idempotent when the
    // slot-grant callback wins the race instead.
    const handoffRegistered = beginTransactionAtAdmission().then(adoptedTransaction => {
      handoffWaiter ??= broker.waitForCompactionHandoff(adoptedTransaction.token, operationSignal);
    });
    const handoff = handoffRegistered.then(() => {
      if (!handoffWaiter) throw new Error("ChatGPT compaction handoff waiter was not registered at admission");
      return handoffWaiter;
    });
    const browserWithoutHandoff = browser.then<never>(() => {
      // The control handler accepts the summary before replying to ChatGPT. A fully
      // settled response without that receipt cannot become a successful checkpoint.
      throw new ChatGptWebAdapterError(
        "ChatGPT finished without sending the context summary to Codex. Check its response for a refusal or tool error.",
        { status: 409, errorType: "invalid_request_error", code: "compaction_handoff_missing", retryable: false },
      );
    });
    const summary = await withCompactionAbort(
      Promise.race([
        handoff,
        browserWithoutHandoff,
      ]),
      operationSignal,
    );
    // The one-shot control submission is the terminal event for this purpose-built response.
    // ChatGPT may render no assistant text after a tool-only response, and therefore no Copy
    // action. End our owned turn explicitly and wait for the launcher/helper cleanup handshake.
    browserAbort.abort(new ChatGptCompactionHandoffAccepted());
    await withCompactionAbort(
      browser.then(() => undefined, () => undefined),
      operationSignal,
    );
    return summary;
  } finally {
    browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    if (browser) {
      // Logical cancellation is not physical retirement. The retained-session owner tracks
      // physical settlement separately, so this helper must not turn its own deadline into an
      // unbounded wait when the worker does not acknowledge abort immediately.
      await withCompactionAbort(
        browser.then(() => undefined, () => undefined),
        operationSignal,
      ).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

interface CachedCompactionRun {
  createdAt: number;
  ownerKey: string;
  traceIds: ReadonlySet<string>;
  nativeThreadId?: string;
  nativeTurnId?: string;
  abort: AbortController;
  active: boolean;
  promise: Promise<string>;
  settlement: Promise<void>;
}

interface StructuredCompactionInterruption {
  createdAt: number;
  reason: Error;
}

export interface StructuredCompactionOwner {
  ownerKey: string;
  /** Every externally addressable browser trace owned by this structured compaction. */
  traceIds: readonly string[];
  /** Exact native Codex owner, when supplied by the current Responses request. */
  nativeThreadId?: string;
  nativeTurnId?: string;
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const structuredCompactionOwners = new Map<string, Promise<void>>();
const structuredCompactionInterruptions = new Map<string, StructuredCompactionInterruption>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

function nativeTurnIdentityKey(threadId: string, turnId: string): string {
  if (!threadId.trim() || !turnId.trim()) {
    throw new Error("Structured compaction requires non-empty native thread and turn ids");
  }
  return JSON.stringify([threadId, turnId]);
}

function rememberStructuredCompactionInterruption(threadId: string, turnId: string, reason: Error): void {
  const identity = nativeTurnIdentityKey(threadId, turnId);
  const now = Date.now();
  pruneStructuredCompactionInterruptions(now);
  const existing = structuredCompactionInterruptions.get(identity);
  if (existing) {
    existing.createdAt = now;
    return;
  }
  structuredCompactionInterruptions.set(identity, { createdAt: now, reason });
}

function structuredCompactionInterruption(owner: StructuredCompactionOwner): Error | undefined {
  if (owner.nativeThreadId === undefined && owner.nativeTurnId === undefined) return undefined;
  pruneStructuredCompactionInterruptions();
  return structuredCompactionInterruptions.get(
    nativeTurnIdentityKey(owner.nativeThreadId ?? "", owner.nativeTurnId ?? ""),
  )?.reason;
}

function pruneStructuredCompactionInterruptions(now = Date.now()): void {
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [identity, interruption] of structuredCompactionInterruptions) {
    if (interruption.createdAt < cutoff) structuredCompactionInterruptions.delete(identity);
  }
}

function pruneStructuredCompactionRuns(): void {
  const now = Date.now();
  const cutoff = now - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [candidate, run] of structuredCompactionRuns) {
    if (!run.active && run.createdAt < cutoff) structuredCompactionRuns.delete(candidate);
  }
  pruneStructuredCompactionInterruptions(now);
}

/** Return the canonical result of an exact compact request, even after its source was retired. */
export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(
  key: string,
  owner: StructuredCompactionOwner,
  start: (operatorSignal: AbortSignal, retainOwnershipUntil: (settlement: Promise<void>) => void) => Promise<string>,
): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  const interrupted = structuredCompactionInterruption(owner);
  if (interrupted) return Promise.reject(interrupted);
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const physicalSettlements: Promise<void>[] = previousOwner ? [previousOwner] : [];
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal, settlement => { physicalSettlements.push(settlement); });
  });
  // Return a deadline failure promptly, while its physical browser owner still blocks retries
  // and cancel-all completion. A cancelled queued run must also retain its predecessor's gate.
  const ownerSettlement = promise.then(() => false, () => true).then(async failed => {
    await Promise.allSettled(physicalSettlements);
    run.active = false;
    if (structuredCompactionOwners.get(owner.ownerKey) === ownerSettlement) {
      structuredCompactionOwners.delete(owner.ownerKey);
    }
    if (failed && structuredCompactionRuns.get(key) === run) structuredCompactionRuns.delete(key);
  });
  const run: CachedCompactionRun = {
    createdAt: Date.now(),
    ownerKey: owner.ownerKey,
    traceIds: new Set(owner.traceIds),
    ...(owner.nativeThreadId ? { nativeThreadId: owner.nativeThreadId } : {}),
    ...(owner.nativeTurnId ? { nativeTurnId: owner.nativeTurnId } : {}),
    abort,
    active: true,
    promise,
    settlement: ownerSettlement,
  };
  structuredCompactionRuns.set(key, run);
  structuredCompactionOwners.set(owner.ownerKey, ownerSettlement);
  return promise;
}

function beginCancelStructuredCompactionRuns(
  matches: (run: CachedCompactionRun) => boolean,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  const runs = [...structuredCompactionRuns.values()].filter(run => run.active && matches(run));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return { cancelled: runs.length, settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined) };
}

/** Begin cancelling the structured compaction owned by one exact native Codex turn. */
export function cancelStructuredCompactionNativeTurn(
  threadId: string,
  turnId: string,
  reason: Error,
): { cancelled: number; settlement: Promise<void> } {
  // Record before scanning active owners. Registration and cancellation share this synchronous
  // boundary, so either registration wins and is aborted below, or interruption wins and the later
  // registration rejects without invoking its detached work.
  rememberStructuredCompactionInterruption(threadId, turnId, reason);
  const runs = [...structuredCompactionRuns.values()].filter(run => (
    run.active
    && run.nativeThreadId === threadId
    && run.nativeTurnId === turnId
  ));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  return {
    cancelled: runs.length,
    settlement: Promise.allSettled(runs.map(run => run.settlement)).then(() => undefined),
  };
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function beginCancelStructuredCompactionTrace(traceId: string, reason: Error): { cancelled: number; settlement: Promise<void> } {
  return beginCancelStructuredCompactionRuns(run => run.traceIds.has(traceId), reason);
}

export async function cancelStructuredCompactionTrace(traceId: string, reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionTrace(traceId, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}

/** Cancel every active compaction owner and wait for its browser/helper cleanup. */
export async function cancelAllStructuredCompactions(reason: Error): Promise<number> {
  const cancellation = beginCancelStructuredCompactionRuns(() => true, reason);
  await cancellation.settlement;
  return cancellation.cancelled;
}
