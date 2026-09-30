import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { defaultBrokerEndpoint, expandUserPath, resolveBrokerEndpoint } from "../../config";
import {
  cancelLauncherManualTurn,
  endLauncherManualTurn,
  LauncherBrowserTurnCancelledError,
  LauncherManualTurnFailedError,
  LauncherManualTurnTimedOutError,
  markLauncherManualTurnStarted,
  releaseLauncherRetainedConversation,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
  type LauncherManualTurnEnd,
  type LauncherManualTurnOwner,
  type LauncherManualTurnStart,
} from "../../launcher-browser-host";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import type { ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptRecoveryExhaustedError, ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserWorker } from "./browser-worker";
import {
  CHATGPT_CONTINUATION_CREDIT_REASONS,
  grantChatGptContinuationCredit,
  takeChatGptContinuationCredit,
} from "./continuation-credits";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity, priorChatGptAbortedTurnIds } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { createChatGptStructuredOutputValidator } from "./output-validation";
import { classifyChatGptRecovery } from "./recovery-classification";
import { chatGptWebTurnRetryPolicy } from "./retry-policy";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult, type TurnBrokerOwner, type TurnReferenceFailureCode } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnLifecycleProgress, chatGptCompactionSourceExecutionKey, chatGptInstructionLineage, chatGptThreadOwnershipKey, chatGptTurnExecutionKey, chatGptTurnRetryKey, chatGptTurnRoundKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { preemptCompactionSource } from "./compaction-preemption";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "./usage";
import { ChatGptThreadEnvironmentStore } from "./thread-environment";
import {
  ChatGptLunaCheckpointStore,
  ChatGptResumeCheckpointStore,
  type CapturedChatGptLunaCheckpoint,
  type CapturedChatGptResumeCheckpoint,
} from "./rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "./turn-progress";
import { ChatGptTurnJournal } from "./turn-journal";
import { buildChatGptWebContextDiagnostics, buildChatGptWebStructuredTraceContext } from "./context-diagnostics";
import { chatGptWebTraceHash, emitChatGptWebStructuredTrace } from "./structured-trace";
import { CHATGPT_TURN_REFERENCE_RECOVERY_MARKER, TurnReferenceRecoveryMachine, isTurnReferenceRecoveryAnswer } from "./reference-recovery";
import {
  canonicalizeCompactionHandoff,
  ChatGptCompactionHandoffStore,
  existingStructuredCompactionRun,
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "./compaction-handoff";
import {
  CHATGPT_WEB_MCP_CONTEXT_UNAVAILABLE_SENTINEL,
  ChatGptWebMcpContextIncompleteError,
  type ChatGptWebMcpContextTransportSummary,
} from "./context-transport";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "./conversation-key";

class FreshTurnRecoveryRequested extends Error {
  constructor(readonly reason: TurnReferenceFailureCode) {
    super("Fenced fresh browser continuation requested");
  }
}

// The HTTP server constructs a fresh adapter for every native turn. Keep persistent state stores
// process-local per state file so normal turns do not synchronously re-read and re-validate the
// same files and concurrent adapters cannot overwrite each other's in-process updates. Persistence
// remains the authority across process restarts; an omitted path still gets an isolated ephemeral
// store.
const threadEnvironmentStores = new Map<string, ChatGptThreadEnvironmentStore>();
const lunaCheckpointStores = new Map<string, ChatGptLunaCheckpointStore>();
const resumeCheckpointStores = new Map<string, ChatGptResumeCheckpointStore>();
const turnJournals = new Map<string, ChatGptTurnJournal>();

function threadEnvironmentStoreFor(path?: string): ChatGptThreadEnvironmentStore {
  if (!path) return new ChatGptThreadEnvironmentStore();
  const existing = threadEnvironmentStores.get(path);
  if (existing) return existing;
  const created = new ChatGptThreadEnvironmentStore(path);
  threadEnvironmentStores.set(path, created);
  return created;
}

function lunaCheckpointStoreFor(path?: string): ChatGptLunaCheckpointStore {
  if (!path) return new ChatGptLunaCheckpointStore();
  const existing = lunaCheckpointStores.get(path);
  if (existing) return existing;
  const created = new ChatGptLunaCheckpointStore(path);
  lunaCheckpointStores.set(path, created);
  return created;
}

function resumeCheckpointStoreFor(path?: string): ChatGptResumeCheckpointStore {
  if (!path) return new ChatGptResumeCheckpointStore();
  const existing = resumeCheckpointStores.get(path);
  if (existing) return existing;
  const created = new ChatGptResumeCheckpointStore(path);
  resumeCheckpointStores.set(path, created);
  return created;
}

function turnJournalFor(path?: string): ChatGptTurnJournal {
  if (!path) return new ChatGptTurnJournal();
  const existing = turnJournals.get(path);
  if (existing) return existing;
  const created = new ChatGptTurnJournal(path);
  turnJournals.set(path, created);
  return created;
}

function brokerSocketPath(provider: CodexProviderConfig): string {
  const configured = provider.chatgptWeb?.brokerSocketPath?.trim();
  return resolveBrokerEndpoint(configured || defaultBrokerEndpoint());
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ChatGptWebAdapterError) return signal.reason;
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function cancellableBrowserTurn(
  run: Promise<string>,
  controller: AbortController,
): { browser: Promise<string>; physicalSettlement: Promise<void>; cancel: (reason?: Error) => void } {
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRejected = false;
  return {
    // Cancellation wins immediately even while the detached Playwright helper is still unwinding.
    // The helper keeps the same abort signal and remains responsible for its normal end/cleanup
    // handshake, but the Codex Responses turn no longer waits on that process cleanup.
    browser: Promise.race([run, cancellation]),
    // `browser` is the fast client-facing result. Replacement ownership must wait for the actual
    // worker promise, whose finally block completes the launcher /turn/end handshake.
    physicalSettlement: run.then(() => undefined, () => undefined),
    cancel(reason?: Error) {
      if (!controller.signal.aborted) controller.abort(reason);
      // Explicit targeted cancellation ends the Codex Responses turn immediately. Generic
      // retirement (client disconnect or compaction replacement) still waits for the helper's
      // cleanup handshake before a replacement browser may start.
      if (reason && !cancellationRejected) {
        cancellationRejected = true;
        rejectCancellation(reason);
      }
    },
  };
}

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

const launcherZeroRiskManualControl: ChatGptZeroRiskManualControl = {
  start: startLauncherManualTurn,
  waitSent: waitForLauncherManualSent,
  waitTerminal: waitForLauncherManualTerminal,
  markStarted: markLauncherManualTurnStarted,
  end: endLauncherManualTurn,
  cancel: cancelLauncherManualTurn,
};

function safeManualAdapterError(error: unknown): Error {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (error instanceof ChatGptWebAdapterError) return error;
  if (error instanceof LauncherManualTurnTimedOutError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 408,
      errorType: "invalid_request_error",
      code: "manual_handoff_timeout",
      retryable: false,
    });
  }
  if (error instanceof LauncherBrowserTurnCancelledError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  if (error instanceof LauncherManualTurnFailedError) {
    return new ChatGptWebAdapterError(error.message, {
      status: 502,
      errorType: "server_error",
      code: "manual_launcher_failed",
      retryable: false,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeManualTerminalError(status: "cancelled" | "failed"): ChatGptWebAdapterError {
  if (status === "cancelled") {
    return new ChatGptWebAdapterError("The Zero Risk browser turn was cancelled in the Launcher", {
      status: 409,
      errorType: "invalid_request_error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
  }
  return new ChatGptWebAdapterError("The Zero Risk browser tab failed before ChatGPT completed the turn", {
    status: 502,
    errorType: "server_error",
    code: "manual_launcher_failed",
    retryable: false,
  });
}

export function chatGptWebExecutionNamespace(provider: CodexProviderConfig): string {
  return createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
}

export function chatGptWebTraceId(provider: CodexProviderConfig, parsed: CodexParsedRequest): string {
  const namespace = chatGptWebExecutionNamespace(provider);
  // The logical response key survives compaction so a final answer that won the handoff race
  // can still be replayed. A new physical browser owner must instead belong to the new context
  // epoch; otherwise Zero Risk correctly rejects it against the previous owner's completion.
  const conversation = parsed._compactionRequest ? undefined : chatGptConversationKey(parsed, namespace);
  return createHash("sha256")
    .update(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)
    .update(conversation ? `:${conversation}` : "")
    .digest("hex")
    .slice(0, 12);
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
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

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: event.text });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

/** Fail-closed execution-safety proof for the one safe multipart transaction restart. The journal
 * may only forget INERT stage records: the final part was never activated, no tool request was
 * observed, and no completion fence exists. Any violation refuses the reset. */
export function assertMultipartRestartSafety(info: {
  finalWasSent: boolean;
  toolsDelivered: number;
  completionCommitted: boolean;
}): void {
  if (info.finalWasSent !== false || info.toolsDelivered !== 0 || info.completionCommitted !== false) {
    throw new Error(
      "multipart transaction journal reset refused: execution safety proof violated"
      + ` (finalWasSent=${info.finalWasSent}, toolsDelivered=${info.toolsDelivered}, completionCommitted=${info.completionCommitted})`,
    );
  }
}

export function submittedTurnFailure(session: ChatGptTurnSession, error: unknown): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const phase = session.runtime.submission?.phase;
  const lastAcknowledgedMultipartStage = session.runtime.submission?.lastAcknowledgedMultipartStage ?? 0;
  // Deterministic physical-capacity verdicts surface as themselves even mid-multipart: they are
  // nonretryable and submissionRejected, so every journal barrier still applies unchanged, while
  // Codex receives the precise cause instead of the generic partial-failure wrapper.
  if (normalized instanceof ChatGptWebAdapterError && normalized.code === "chatgpt_message_too_long") {
    return normalized;
  }
  if (lastAcknowledgedMultipartStage > 0) {
    return new ChatGptWebAdapterError(
      `ChatGPT failed after acknowledging Bigger Context stage ${lastAcknowledgedMultipartStage}. The bridge will not replay earlier acknowledged stages automatically.`,
      {
        status: normalized instanceof ChatGptWebAdapterError ? normalized.status : 502,
        errorType: normalized instanceof ChatGptWebAdapterError ? normalized.errorType : "server_error",
        code: "chatgpt_multipart_partial_failure",
        retryable: false,
        cause: normalized,
      },
    );
  }
  // Submission phase is authoritative for resend safety. A retryable provider error observed
  // after Send activation cannot prove that ChatGPT rejected the prompt, so retrying it could
  // duplicate side effects. Preserve only explicitly terminal provider classifications.
  if (!phase || phase === "prepared") return normalized;
  // The browser worker emits this only after bounded same-owner recovery has already been
  // exhausted. Keep the structured classification intact so the outer lifecycle retires the
  // unrecoverable owner/tools explicitly instead of misreporting them as preservable.
  if (normalized instanceof ChatGptRecoveryExhaustedError) return normalized;
  if (normalized instanceof ChatGptWebAdapterError) {
    if (normalized.submissionRejected || !normalized.retryable) return normalized;
    if (normalized.status === 429 || normalized.code === "rate_limit_exceeded") {
      return new ChatGptWebAdapterError(normalized.message, {
        status: normalized.status,
        errorType: normalized.errorType,
        code: normalized.code,
        retryable: false,
        ...(normalized.retryAfterMs !== undefined ? { retryAfterMs: normalized.retryAfterMs } : {}),
        cause: normalized,
      });
    }
  }
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? "ChatGPT did not confirm that the prompt was sent. Check the ChatGPT tab before continuing."
      : "ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
      cause: normalized,
    },
  );
}

function currentToolResults(parsed: CodexParsedRequest, session: ChatGptTurnSession): CodexToolResultMessage[] {
  const byId = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (byId.has(message.toolCallId)) throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    byId.set(message.toolCallId, message);
  }
  return [...byId.values()];
}

function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;

export function createChatGptWebAdapter(
  provider: CodexProviderConfig,
  dependencies: {
    broker?: TurnBrokerOwner;
    zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  } = {},
): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = dependencies.broker ?? TurnBroker.forSocket(brokerSocketPath(provider));
  const zeroRiskManualControl = dependencies.zeroRiskManualControl ?? launcherZeroRiskManualControl;
  const structuredBroker = broker instanceof TurnBroker ? broker : undefined;
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs;
  const experimentalSkillAttachments = provider.chatgptWeb?.experimentalSkillAttachments;
  if (experimentalSkillAttachments !== undefined && typeof experimentalSkillAttachments !== "boolean") {
    throw new Error("ChatGPT skill attachments preference must be a boolean");
  }
  if (experimentalSkillAttachments && provider.chatgptWeb?.browserInteractionMode === "manual") {
    throw new Error("Skills as files is unavailable in Zero Risk mode");
  }
  const experimentalBiggerContext = provider.chatgptWeb?.experimentalBiggerContext;
  if (experimentalBiggerContext !== undefined && typeof experimentalBiggerContext !== "boolean") {
    throw new Error("ChatGPT Bigger Context preference must be a boolean");
  }
  const configuredCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const manualInteraction = provider.chatgptWeb?.browserInteractionMode === "manual";
  const useSavedChats = provider.chatgptWeb?.useSavedChats === true;
  const freshConversationPerTurn = provider.chatgptWeb?.experimentalFreshConversationPerTurn === true;
  if (provider.chatgptWeb?.experimentalFreshConversationPerTurn !== undefined
    && typeof provider.chatgptWeb.experimentalFreshConversationPerTurn !== "boolean") {
    throw new Error("ChatGPT fresh conversation preference must be a boolean");
  }
  if (freshConversationPerTurn && manualInteraction) {
    throw new Error("Fresh browser conversations per turn is available only in automatic mode");
  }
  const executionNamespace = chatGptWebExecutionNamespace(provider);
  const retainedLauncherDescriptor = provider.chatgptWeb?.browserHost === "launcher"
    && provider.chatgptWeb.browserHostDescriptorPath
      ? resolve(expandUserPath(provider.chatgptWeb.browserHostDescriptorPath))
      : undefined;
  if (manualInteraction) {
    if (!configuredCapabilities.localToolsEnabled) {
      throw new Error("ChatGPT Zero Risk requires the Full Codex harness");
    }
    if (!retainedLauncherDescriptor) {
      throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
    }
  }
  const threadEnvironmentStatePath = provider.chatgptWeb?.threadEnvironmentStatePath
    ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
    : undefined;
  const lunaCheckpointStatePath = provider.chatgptWeb?.lunaCheckpointStatePath
    ? resolve(expandUserPath(provider.chatgptWeb.lunaCheckpointStatePath))
    : undefined;
  const environmentStore = threadEnvironmentStoreFor(threadEnvironmentStatePath);
  const lunaCheckpointStore = lunaCheckpointStoreFor(lunaCheckpointStatePath);
  const resumeCheckpointStore = resumeCheckpointStoreFor(
    provider.chatgptWeb?.resumeCheckpointStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.resumeCheckpointStatePath))
      : undefined,
  );
  const turnJournalStatePath = provider.chatgptWeb?.turnJournalStatePath
    ? resolve(expandUserPath(provider.chatgptWeb.turnJournalStatePath))
    : undefined;
  const turnJournal = turnJournalFor(turnJournalStatePath);
  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
    turnCapabilities: ChatGptWebCapabilities,
    hooks: {
      onCompactionProgress?: () => void;
      /** The runtime's browser turn was accepted into the logical browser queue. */
      onBrowserTurnQueued?: () => void;
      /** The scheduler granted the runtime's browser turn a slot; compaction execution may begin. */
      onBrowserTurnSlotGranted?: () => void;
      onSubmissionActivated?: (conversationKey?: string) => void;
      onSendDispatchAttempted?: () => void;
      onSubmissionAccepted?: (conversationKey?: string) => void;
      onMultipartStageSendActivated?: (stageIndex: number, conversationKey?: string) => void;
      onMultipartStageAcknowledged?: (stageIndex: number, conversationKey?: string) => void;
      onMultipartTransactionRestart?: (info: {
        attempt: number;
        failedStage: number;
        failureCategory: string;
        finalWasSent: false;
        toolsDelivered: number;
        completionCommitted: false;
      }, conversationKey?: string) => void;
      beforePhysicalSubmission?: () => void | Promise<void>;
      onRateLimitPressure?: (error: ChatGptWebAdapterError) => void | Promise<void>;
      recoveryContinuation?: boolean;
      onRecoveryRegistered?: () => void;
    } = {},
  ): ChatGptTurnRuntime => {
    const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (manualRequest !== manualInteraction) {
      throw new Error(
        manualInteraction
          ? "ChatGPT Zero Risk requires the Zero Risk Web model route"
          : "The Zero Risk Web model route requires ChatGPT Zero Risk interaction mode",
      );
    }
    const mode = manualRequest
      ? { localTools: true }
      : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
    const identity = extractChatGptTurnIdentity(parsed);
    // One-shot continuation admission: interrupt-steered children (Codex Interrupt / send_input)
    // and threads whose compaction handoff just committed resume work that was already running,
    // so their next turn must not re-enter the browser queue at the FIFO tail behind turns
    // enqueued after them (live: 34-minute steered-child starvation, 2026-09-29 incident).
    const continuationCredit = identity.threadId && !parsed._compactionRequest
      ? takeChatGptContinuationCredit(identity.threadId)
      : undefined;
    if (continuationCredit && identity.threadId) {
      emitChatGptWebStructuredTrace("continuation_credit_consumed", {
        traceId,
        nativeThreadHash: chatGptWebTraceHash(identity.threadId),
        reason: continuationCredit.reason,
        ageMs: continuationCredit.ageMs,
      });
    }
    const captureLunaCheckpoint = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    const resumeCheckpointEligible = !manualRequest
      && !useSavedChats
      && experimentalBiggerContext === true
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && !parsed._compactionRequest
      && Boolean(identity.threadId && identity.turnId);
    let checkpointInput: { parsed: CodexParsedRequest; applied: boolean; reason?: string } = captureLunaCheckpoint
      ? lunaCheckpointStore.apply(parsed)
      : { parsed, applied: false };
    const resumeCheckpointCandidate = resumeCheckpointEligible
      && resumeCheckpointStore.hasCandidate(parsed);
    let resumeCheckpointResolved = false;
    let rawMultipartPartsResolved = resumeCheckpointEligible && !resumeCheckpointCandidate;
    let rawMultipartParts = rawMultipartPartsResolved
      ? resolveBiggerContextMultipartParts(parsed, turnCapabilities, experimentalSkillAttachments)
      : undefined;
    const resolveFreshCheckpointInput = () => {
      if (!resumeCheckpointCandidate || resumeCheckpointResolved) return checkpointInput;
      checkpointInput = resumeCheckpointStore.apply(parsed);
      resumeCheckpointResolved = true;
      if (!checkpointInput.applied && !rawMultipartPartsResolved) {
        rawMultipartParts = resolveBiggerContextMultipartParts(
          parsed,
          turnCapabilities,
          experimentalSkillAttachments,
        );
        rawMultipartPartsResolved = true;
      }
      return checkpointInput;
    };
    const captureResumeCheckpoint = resumeCheckpointEligible
      && (resumeCheckpointCandidate || rawMultipartParts !== undefined);
    const conversationKey = !parsed._compactionRequest
      && !hooks.recoveryContinuation
      && !freshConversationPerTurn
      && parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
      && mode.localTools
      && retainedLauncherDescriptor
      ? chatGptConversationKey(parsed, executionNamespace)
      : undefined;
    const resumeInput = conversationKey
      ? retainedConversationResumeRequest(parsed)
      : undefined;
    const retainConversation = conversationKey !== undefined;
    const releaseRetainedConversation = conversationKey && retainedLauncherDescriptor
      ? async () => {
        await releaseLauncherRetainedConversation(retainedLauncherDescriptor, conversationKey);
      }
      : undefined;
    const compileOptionsFor = (input: CodexParsedRequest, allowResumeCheckpointCapture = true) => {
      if (manualRequest) return {};
      const experimentalMultipartParts = experimentalBiggerContext
        ? input === parsed && rawMultipartPartsResolved
          ? rawMultipartParts
          : resolveBiggerContextMultipartParts(input, turnCapabilities, experimentalSkillAttachments)
        : undefined;
      return {
        captureLunaCheckpoint,
        captureResumeCheckpoint: captureResumeCheckpoint && allowResumeCheckpointCapture,
        recoveryContinuation: hooks.recoveryContinuation === true,
        experimentalSkillAttachments,
        ...(experimentalMultipartParts !== undefined
          ? { experimentalMultipartParts }
          : {}),
      };
    };
    const emitContextDiagnostics = (
      input: CodexParsedRequest,
      compiled: ReturnType<typeof compileChatGptWebPrompt>,
    ): void => {
      try {
        emitChatGptWebStructuredTrace("context_planned", {
          ...buildChatGptWebStructuredTraceContext(traceId, parsed, input, compiled),
          nativeThreadHash: chatGptWebTraceHash(identity.threadId),
          nativeTurnHash: chatGptWebTraceHash(identity.turnId),
          provider: "chatgpt-web",
        });
        if (process.env.CODEX_CHATGPT_WEB_CONTEXT_DIAGNOSTICS === "1") {
          console.info(`[chatgpt-web] context_metrics ${JSON.stringify(
            buildChatGptWebContextDiagnostics(traceId, parsed, input, compiled),
          )}`);
        }
      } catch {
        // Diagnostics must never affect prompt preparation or physical submission.
        console.warn(`[chatgpt-web] context_metrics_unavailable trace=${traceId}`);
      }
    };
    if (captureLunaCheckpoint) {
      console.info(
        `[chatgpt-web] Luna rolling checkpoint applied=${checkpointInput.applied}${checkpointInput.reason ? ` reason=${checkpointInput.reason}` : ""}`,
      );
    }
    if (resumeCheckpointEligible) {
      console.info(
        `[chatgpt-web] temporary_chat_resume checkpoint_candidate=${resumeCheckpointCandidate}`
        + ` raw_multipart_parts=${rawMultipartParts ?? 1}`
        + ` capture=${captureResumeCheckpoint}`,
      );
    }
    let capturedCheckpoint: CapturedChatGptLunaCheckpoint | undefined;
    let capturedResumeCheckpoint: CapturedChatGptResumeCheckpoint | undefined;
    let checkpointCaptureError: Error | undefined;
    const captureCheckpoint = (captured: CapturedChatGptLunaCheckpoint): void => {
      if (capturedCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT Luna emitted more than one rolling checkpoint");
        return;
      }
      capturedCheckpoint = captured;
    };
    const captureResume = (captured: CapturedChatGptResumeCheckpoint): void => {
      if (capturedResumeCheckpoint) {
        checkpointCaptureError = new Error("ChatGPT emitted more than one resume checkpoint");
        return;
      }
      capturedResumeCheckpoint = captured;
    };
    const finalizeCheckpoint = (browser: Promise<string>): Promise<string> => browser.then(answer => {
      if (!captureLunaCheckpoint && !captureResumeCheckpoint) return answer;
      if (checkpointCaptureError) throw checkpointCaptureError;
      if (capturedCheckpoint) lunaCheckpointStore.commit(parsed, capturedCheckpoint, answer);
      if (capturedResumeCheckpoint) resumeCheckpointStore.commit(parsed, capturedResumeCheckpoint, answer);
      return answer;
    });
    const recordResumePath = (reused: boolean): void => {
      if (!reused) resolveFreshCheckpointInput();
      const path = reused
        ? "LIVE_TEMPORARY_CHAT_RESUME"
        : checkpointInput.applied
          ? "LOCAL_CHECKPOINT_PLUS_DELTA"
          : rawMultipartParts === 6
            ? "FULL_MULTIPART_REPLAY"
            : rawMultipartParts === 2
              ? "PARTIAL_MULTIPART_REPLAY"
              : "FRESH_TEMPORARY_CHAT_CANONICAL";
      console.info(`[chatgpt-web] temporary_chat_resume_path=${path} trace=${traceId}`);
    };
    const browserAbort = new AbortController();
    let browserOwnerSettled = false;
    const trackBrowserOwner = (browser: Promise<string>): Promise<string> => browser.finally(() => {
      browserOwnerSettled = true;
    });
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    const lifecycleProgress = new ChatGptTurnLifecycleProgress();
    const recordBrowserProgress = () => lifecycleProgress.record("browser");
    const recordRecovery = () => lifecycleProgress.record("recovery");
    const pushReasoning = (value: string, continuation?: boolean) => {
      lifecycleProgress.record("response");
      trace.push({ kind: "reasoning", text: value, ...(continuation ? { continuation: true } : {}) });
    };
    const pushCommentary = (value: string, continuation?: boolean) => {
      lifecycleProgress.record("response");
      trace.push({ kind: "commentary", text: value, ...(continuation ? { continuation: true } : {}) });
    };
    const pushText = (delta: string) => {
      lifecycleProgress.record("response");
      text.push(delta);
    };
    const observedCapabilityTokens = new Set<string>();
    const observeCapabilityRetirement = (
      turnToken: string,
      externalProgress: ChatGptExternalTurnProgress,
    ): void => {
      if (observedCapabilityTokens.has(turnToken)) return;
      observedCapabilityTokens.add(turnToken);
      void broker.waitForRetirement(turnToken).then(
        () => {
          const retirement = new Error("Codex Native retired the turn binding before its tool work completed");
          externalProgress.retire(retirement);
          if (!browserOwnerSettled && !browserAbort.signal.aborted) browserAbort.abort(retirement);
        },
        error => {
          const failure = new Error("ChatGPT could not observe Codex Native turn retirement", {
            cause: error,
          });
          externalProgress.retire(failure);
          if (!browserAbort.signal.aborted) browserAbort.abort(failure);
        },
      );
    };
    const submission: NonNullable<ChatGptTurnRuntime["submission"]> = { phase: "prepared" };
    // A canonical compaction request is side-effect free and remains safe to rebuild after an
    // ambiguous browser send. Normal task prompts must never be replayed after Send activation.
    const submissionLifecycle = {
      ...(!parsed._compactionRequest ? {
        onSendActivated: () => {
          hooks.onSubmissionActivated?.(conversationKey);
          submission.phase = "send_activated" as const;
        },
        onSendDispatchAttempted: () => hooks.onSendDispatchAttempted?.(),
      } : {}),
      onSubmitted: () => {
        if (!parsed._compactionRequest) submission.phase = "accepted";
        hooks.onSubmissionAccepted?.(conversationKey);
        hooks.onCompactionProgress?.();
      },
    };
    const multipartProgressLifecycle = {
      onMultipartStageSendActivated: (stageIndex: number) => {
        hooks.onMultipartStageSendActivated?.(stageIndex, conversationKey);
        submission.phase = "send_activated";
        submission.lastSentMultipartStage = Math.max(
          submission.lastSentMultipartStage ?? 0,
          stageIndex,
        );
      },
      onMultipartStageAcknowledged: (stageIndex: number) => {
        submission.lastAcknowledgedMultipartStage = Math.max(
          submission.lastAcknowledgedMultipartStage ?? 0,
          stageIndex,
        );
        hooks.onMultipartStageAcknowledged?.(stageIndex, conversationKey);
        hooks.onCompactionProgress?.();
      },
      onMultipartTransactionRestart: (info: {
        attempt: number;
        failedStage: number;
        failureCategory: string;
        finalWasSent: false;
        toolsDelivered: number;
        completionCommitted: false;
      }) => {
        // One safe transaction restart: every physical Send so far was an inert stage, the final
        // part was never activated, and no tool request was delivered. The failed conversation's
        // stage records are abandoned with it and the fresh transaction records from part one.
        // The execution-safety proof is ASSERTED, not assumed — violation fails closed.
        assertMultipartRestartSafety(info);
        submission.phase = "prepared";
        submission.lastSentMultipartStage = 0;
        submission.lastAcknowledgedMultipartStage = 0;
        hooks.onMultipartTransactionRestart?.(info, conversationKey);
        hooks.onCompactionProgress?.();
      },
    };
    if (manualRequest) {
      if (!environment) throw new Error("ChatGPT Zero Risk requires a trusted Codex environment");
      if (!retainedLauncherDescriptor) throw new Error("ChatGPT Zero Risk requires the Launcher browser host");
      const token = deferred<string>();
      const externalProgress = new ChatGptExternalTurnProgress();
      const surfaceNonce = randomBytes(32).toString("base64url");
      const owner: LauncherManualTurnOwner = { traceId, helperPid: process.pid };
      let tokenSettled = false;
      let activeToken: string | undefined;
      let launcherStarted = false;
      let launcherEnded = false;
      const finishLauncher = async (status: LauncherManualTurnEnd["status"]): Promise<void> => {
        if (!launcherStarted || launcherEnded) return;
        await zeroRiskManualControl.end(retainedLauncherDescriptor, {
          ...owner,
          status,
          ...(status === "completed" && retainConversation ? { retain: true } : {}),
        });
        launcherEnded = true;
      };
      const runManual = async (): Promise<string> => {
        try {
          activeToken = await broker.registerSafe(environment, surfaceNonce, undefined, traceId);
          observeCapabilityRetirement(activeToken, externalProgress);
          const compiled = compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            activeToken,
            { manualControl: true },
          );
          const resumeCompiled = resumeInput
            ? compileChatGptWebPrompt(
              resumeInput,
              turnCapabilities,
              activeToken,
              { manualControl: true },
            )
            : undefined;
          for (const candidate of [compiled, resumeCompiled]) {
            if (!candidate) continue;
            if (candidate.multipart) {
              throw new ChatGptWebAdapterError("ChatGPT Zero Risk does not support multipart browser transport", {
                status: 409,
                errorType: "invalid_request_error",
                code: "manual_multipart_unsupported",
                retryable: false,
              });
            }
          }
          tokenSettled = true;
          token.resolve(activeToken);
          if (!parsed._compactionRequest) {
            trace.push({
              kind: "commentary",
              text: "> **Action required in Zero Risk**\n>\n> Open the launcher, copy and paste the prompt into ChatGPT, add any images yourself because Zero Risk cannot transfer them, select the `Codex Zero Risk` plugin and the model you want, send the prompt, then confirm it was sent in the launcher.",
            });
          }
          await zeroRiskManualControl.start(retainedLauncherDescriptor, {
            ...owner,
            prompt: compiled.text,
            ...(resumeCompiled ? { resumePrompt: resumeCompiled.text } : {}),
            ...(conversationKey ? { conversationKey } : {}),
            ...(parsed._compactionRequest ? { compaction: true as const } : {}),
          });
          launcherStarted = true;
          await zeroRiskManualControl.waitSent(retainedLauncherDescriptor, owner, {
            abortSignal: browserAbort.signal,
          });
          await broker.confirmSafeTurnSent(activeToken, surfaceNonce);
          submission.phase = "accepted";
          hooks.onSubmissionAccepted?.();
          if (!parsed._compactionRequest) trace.push({
            kind: "commentary",
            text: "> **Waiting for ChatGPT**\n>\n> The prompt is marked `Sent`. Waiting for `Codex Zero Risk` to bind this turn through the selected ChatGPT connector.",
          });
          const terminalAbort = new AbortController();
          const abortTerminal = () => terminalAbort.abort();
          browserAbort.signal.addEventListener("abort", abortTerminal, { once: true });
          const terminalFailure = zeroRiskManualControl.waitTerminal(
            retainedLauncherDescriptor,
            owner,
            { abortSignal: terminalAbort.signal },
          ).then(observed => Promise.reject(safeManualTerminalError(observed.status)))
            .catch(error => terminalAbort.signal.aborted
              ? new Promise<never>(() => {})
              : Promise.reject(error));
          let answer: string;
          try {
            await Promise.race([
              broker.waitForSafeStart(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
            await zeroRiskManualControl.markStarted(retainedLauncherDescriptor, owner);
            if (!parsed._compactionRequest) trace.push({
              kind: "commentary",
              text: "> **Zero Risk connected**\n>\n> `Codex Zero Risk` is connected. ChatGPT is now working through the native Codex harness; progress remains visible in the launcher.",
            });
            answer = await Promise.race([
              broker.waitForSafeCompletion(activeToken, browserAbort.signal),
              terminalFailure,
            ]);
          } finally {
            terminalAbort.abort();
            browserAbort.signal.removeEventListener("abort", abortTerminal);
          }
          text.push(answer);
          try {
            await finishLauncher("completed");
          } catch (controlError) {
            // The broker result is already authoritative. A launcher acknowledgement failure may
            // leave UI cleanup pending, but it must not replace a completed Codex answer with an
            // error or trigger a contradictory failed terminal mutation.
            console.error(
              `[chatgpt-web] completed Zero Risk turn but could not confirm launcher cleanup: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          return answer;
        } catch (error) {
          const normalized = safeManualAdapterError(error);
          // Capture the causal state before our own cleanup revokes the broker capability. The
          // retirement observer also aborts browserAbort, but that self-induced abort must not turn
          // an ordinary launcher/runtime failure into a user cancellation.
          const externallyAborted = browserAbort.signal.aborted;
          if (activeToken) await Promise.resolve(broker.revoke(activeToken, normalized)).catch(() => {});
          try {
            await finishLauncher(externallyAborted ? "aborted" : "failed");
          } catch (controlError) {
            console.error(
              `[chatgpt-web] failed to release Zero Risk launcher turn: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
            );
          }
          throw normalized;
        }
      };
      const browserTurn = cancellableBrowserTurn(trackBrowserOwner(runManual()), browserAbort);
      void browserTurn.browser.catch(error => {
        if (tokenSettled) return;
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      });
      return {
        mode: "tools",
        token: token.promise,
        externalProgress,
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        usageInput: parsed,
        manualControl: { surfaceNonce },
        ...(conversationKey ? { conversationKey } : {}),
        ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
        retireCapability: async () => {
          if (activeToken) await broker.revoke(activeToken);
        },
        submission,
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (activeToken) {
            void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
              console.error(`[chatgpt-web] failed to revoke cancelled Zero Risk request: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
      };
    }
    if (!mode.localTools) {
      // v6.1.9 MCP_CONTEXT_COMPACTION: a large structured compaction rides the proven MCP context
      // primitive. The compaction turn registers a broker token purely for the reserved read-only
      // context reader; ordinary execution stays locked broker-side for the whole turn.
      if (parsed._compactionRequest) {
        console.info(`[chatgpt-web] MCP context compaction availability: biggerContext=${experimentalBiggerContext === true} manualRequest=${manualRequest} structuredBroker=${structuredBroker !== undefined} multipartEnabled=${experimentalBiggerContext === true && resolveBiggerContextMultipartParts !== undefined}`);
      }
      const compactionMcp = parsed._compactionRequest === true
        && experimentalBiggerContext === true
        && !manualRequest
        && structuredBroker !== undefined;
      let mcpToken: string | undefined;
      const mcpInstalled = deferred<{ token: string; summary: ChatGptWebMcpContextTransportSummary } | undefined>();
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
        capabilities: turnCapabilities,
        prepare: async () => {
          const input = resolveFreshCheckpointInput().parsed;
          let turnToken: string | undefined;
          if (compactionMcp) {
            try {
              const mcpEnvironment = environmentStore.resolve(input);
              mcpToken = await broker.register(mcpEnvironment, 10 * 60_000, traceId);
              turnToken = mcpToken;
            } catch (error) {
              // No trusted environment for the reserved reader: degrade to the previous
              // compaction transport instead of failing the compaction.
              mcpToken = undefined;
              console.warn(`[chatgpt-web] MCP context compaction unavailable, falling back to multipart: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          const compiled = compileChatGptWebPrompt(
            input,
            turnCapabilities,
            turnToken,
            compileOptionsFor(input),
          );
          emitContextDiagnostics(input, compiled);
          if (compiled.contextTransport && mcpToken) {
            await structuredBroker!.setContextTransport(mcpToken, compiled.contextTransport, {
              modelId: parsed.modelId,
              reasoning: parsed.options.reasoning,
              purpose: "compaction",
              // Authoritative MCP context progress re-arms the compaction execution stall
              // window: each unique contiguous frontier advance refreshes the ingestion
              // budget, and the completion transition starts a fresh generation/settlement
              // budget. The broker delivers nothing for duplicate or out-of-order reads, so
              // stalled reconstruction can never extend the window.
              onContextProgress: info => {
                hooks.onCompactionProgress?.();
                emitChatGptWebStructuredTrace("compaction_execution_progress", {
                  traceId,
                  kind: info.kind,
                  phase: info.kind === "complete" ? "generation_settlement" : "context_ingestion",
                  ...(info.contiguousThrough !== undefined ? { contiguousThrough: info.contiguousThrough } : {}),
                  ...(info.totalChunks !== undefined ? { totalChunks: info.totalChunks } : {}),
                });
              },
            });
            mcpInstalled.resolve({ token: mcpToken, summary: compiled.contextTransportSummary! });
          } else {
            mcpInstalled.resolve(undefined);
          }
          return { ...compiled, release: () => {} };
        },
        onPreparedSelected: recordResumePath,
        abortSignal: browserAbort.signal,
        ...hooks.beforePhysicalSubmission ? { beforePhysicalSubmission: hooks.beforePhysicalSubmission } : {},
        ...hooks.onRateLimitPressure ? { onRateLimitPressure: hooks.onRateLimitPressure } : {},
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...(continuationCredit ? { continuation: true } : {}),
        ...hooks.onBrowserTurnQueued ? { onQueued: hooks.onBrowserTurnQueued } : {},
        ...hooks.onBrowserTurnSlotGranted ? { onSlotGranted: hooks.onBrowserTurnSlotGranted } : {},
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onHeartbeat: recordBrowserProgress,
        onRecovery: recordRecovery,
        onReasoningSummary: pushReasoning,
        onCommentary: pushCommentary,
        onTextDelta: pushText,
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
        ...(captureResumeCheckpoint ? {
          captureResumeCheckpoint: true,
          onResumeCheckpoint: captureResume,
        } : {}),
      })), browserAbort);
      return {
        mode: "read-only",
        browser: browserTurn.browser,
        physicalSettlement: browserTurn.physicalSettlement,
        trace,
        text,
        lifecycleProgress,
        usageInput: parsed,
        submission,
        ...(compactionMcp ? {
          mcpContext: { installed: mcpInstalled.promise },
        } : {}),
        cancel: (reason?: Error) => {
          browserTurn.cancel(reason);
          if (mcpToken) {
            void Promise.resolve(broker.revoke(mcpToken, reason)).catch(() => {});
          }
        },
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    const externalProgress = new ChatGptExternalTurnProgress();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const prepareWith = async (input: CodexParsedRequest, allowResumeCheckpointCapture = true) => {
      const registeringNewToken = activeToken === undefined;
      const turnToken = activeToken ?? await broker.register(
        environment,
        timeoutMs === undefined ? undefined : timeoutMs + 60_000,
        traceId,
      );
      activeToken = turnToken;
        if (hooks.recoveryContinuation && registeringNewToken) {
          hooks.onRecoveryRegistered?.();
          emitChatGptWebStructuredTrace("fresh_turn_registered", {
            traceId, recoveryGeneration: 1, tokenHash: chatGptWebTraceHash(turnToken),
          });
        }
      try {
        const compiled = compileChatGptWebPrompt(
          input,
          turnCapabilities,
          turnToken,
          compileOptionsFor(input, allowResumeCheckpointCapture),
        );
        emitContextDiagnostics(input, compiled);
        if (compiled.contextTransport) {
          if (!broker.setContextTransport) {
            throw new Error("The active Codex turn broker does not support MCP context transport");
          }
          await broker.setContextTransport(turnToken, compiled.contextTransport, {
            modelId: parsed.modelId,
            reasoning: parsed.options.reasoning,
          });
        }
        // Publish only after preparation succeeds: otherwise its failure revokes the token
        // before the response observer uses it and masks the cause as an expired capability.
        observeCapabilityRetirement(turnToken, externalProgress);
        if (!tokenSettled) {
          tokenSettled = true;
          token.resolve(turnToken);
        }
        return { ...compiled, release: () => {} };
      } catch (error) {
        await broker.revoke(turnToken);
        activeToken = undefined;
        throw error;
      }
    };
    const browserTurn = cancellableBrowserTurn(trackBrowserOwner(finalizeCheckpoint(worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      ...(parsed._chatgptModelFamily ? { modelFamily: parsed._chatgptModelFamily } : {}),
      capabilities: turnCapabilities,
      prepare: () => prepareWith(resolveFreshCheckpointInput().parsed),
      ...(resumeInput ? { prepareResume: () => prepareWith(resumeInput, false) } : {}),
      ...(retainConversation ? { retainConversation: true, conversationKey } : {}),
      onPreparedSelected: recordResumePath,
      abortSignal: browserAbort.signal,
      ...hooks.beforePhysicalSubmission ? { beforePhysicalSubmission: hooks.beforePhysicalSubmission } : {},
      ...hooks.onRateLimitPressure ? { onRateLimitPressure: hooks.onRateLimitPressure } : {},
      ...(parsed._compactionRequest ? { compaction: true } : {}),
      ...(continuationCredit ? { continuation: true } : {}),
      ...hooks.onBrowserTurnQueued ? { onQueued: hooks.onBrowserTurnQueued } : {},
      ...hooks.onBrowserTurnSlotGranted ? { onSlotGranted: hooks.onBrowserTurnSlotGranted } : {},
      ...submissionLifecycle,
      ...multipartProgressLifecycle,
      onHeartbeat: recordBrowserProgress,
      onRecovery: recordRecovery,
      onReasoningSummary: pushReasoning,
      onCommentary: pushCommentary,
      onTextDelta: pushText,
      externalProgress,
      completionFence: {
        begin: async () => broker.beginCompletionFence(await token.promise),
        commit: async revision => broker.commitCompletionFence(await token.promise, revision),
      },
      ...(captureLunaCheckpoint ? {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: captureCheckpoint,
      } : {}),
      ...(captureResumeCheckpoint ? {
        captureResumeCheckpoint: true,
        onResumeCheckpoint: captureResume,
      } : {}),
    }))), browserAbort);
    void browserTurn.browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      externalProgress,
      browser: browserTurn.browser,
      physicalSettlement: browserTurn.physicalSettlement,
      trace,
      text,
      lifecycleProgress,
      usageInput: parsed,
      ...(conversationKey ? { conversationKey } : {}),
      ...(releaseRetainedConversation ? { releaseRetainedConversation } : {}),
      retireCapability: async () => {
        if (activeToken) await broker.revoke(activeToken);
      },
      submission,
      cancel: (reason?: Error) => {
        browserTurn.cancel(reason);
        if (activeToken) {
          void Promise.resolve(broker.revoke(activeToken, reason)).catch(error => {
            console.error(`[chatgpt-web] failed to revoke cancelled turn token: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      },
    };
  };

  return {
    name: "chatgpt-web",
    async runTurn(parsed, incoming, emit) {
      const initialSourceExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      const initialRecoveryExecutionKey = `${initialSourceExecutionKey}:reference-recovery-1`;
      // A recovery generation can emit a native tool round and remain alive while Codex executes
      // that tool. The next Responses request must rejoin that exact in-memory recovery execution,
      // derived from the same native thread/turn/user revision, instead of falling back to the
      // source execution whose journal was intentionally closed as turn_reference_recovered.
      // Absence of the exact recovery session preserves the normal journal fail-closed behavior;
      // no "current/latest" turn lookup or capability substitution is involved.
      const initialRecoveryAttempt = chatGptTurnSessions.find(initialRecoveryExecutionKey) ? 1 : 0;
      let recoveryGenerationFailed = false;
      const referenceRecovery = new TurnReferenceRecoveryMachine(
        initialRecoveryAttempt === 1 ? "continuation_active" : "active_browser_turn",
      );
      const runChatGptWebTurn = async (recoveryAttempt = 0): Promise<void> => {
        const manualRequest = isChatGptWebZeroRiskBackendModel(parsed.modelId);
        if (manualRequest !== manualInteraction) {
          emit({
            type: "error",
            message: manualInteraction
              ? "ChatGPT Zero Risk requires the Zero Risk Web model route."
              : "The Zero Risk Web model route is unavailable while automatic browser interaction is enabled.",
            status: 409,
            errorType: "invalid_request_error",
            code: "browser_interaction_mode_mismatch",
            retryable: false,
          });
          return;
        }
        const turnCapabilities = parsed._compactionRequest && !manualRequest
          ? { ...configuredCapabilities, localToolsEnabled: false }
          : configuredCapabilities;
        const mode = manualRequest
          ? { localTools: true }
          : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, turnCapabilities);
        const structuredOutputValidator = parsed._compactionRequest
          ? undefined
          : createChatGptStructuredOutputValidator(parsed.options.outputFormat);
        const bufferStructuredOutput = structuredOutputValidator !== undefined;
        const retryKey = `${executionNamespace}:${chatGptTurnRetryKey(parsed)}`;
        const exhaustedRetry = chatGptWebTurnRetryPolicy.exhaustedError(retryKey);
        if (exhaustedRetry) {
          emitChatGptWebStructuredTrace("codex_retry_blocked_after_terminal_submission", {
            turnHash: chatGptWebTraceHash(extractChatGptTurnIdentity(parsed).turnId),
            reason: "retry_budget_exhausted",
            previousCode: exhaustedRetry.code,
          }, "info");
          emit({
            type: "error",
            message: exhaustedRetry.message,
            status: exhaustedRetry.status,
            errorType: exhaustedRetry.errorType,
            code: exhaustedRetry.code,
            retryable: false,
          });
          return;
        }
        let environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined;
        if (mode.localTools) {
          try {
            environment = environmentStore.resolve(parsed);
          } catch (error) {
            const identity = extractChatGptTurnIdentity(parsed);
            console.warn(
              `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
            );
            throw error;
          }
        }
        if (parsed._compactionRequest) {
          const structuredCompactionRequired = parsed.modelId !== CHATGPT_WEB_LUNA_MODEL_ID
            && configuredCapabilities.localToolsEnabled;
          if (structuredCompactionRequired
            && (!retainedLauncherDescriptor || (!manualRequest && !structuredBroker))) {
            emit({
              type: "error",
              message: manualRequest
                ? "Zero Risk could not resume the active ChatGPT conversation for context handoff. Retry the task from the Launcher."
                : "ChatGPT could not resume the active conversation for context handoff. Retry the task.",
              status: 409,
              errorType: "invalid_request_error",
              code: "compaction_control_unavailable",
              retryable: false,
            });
            return;
          }
          if (structuredCompactionRequired) {
            const compactionExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
            const compactedSourceExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
            const handoffTraceId = createHash("sha256")
              .update(`${compactionExecutionKey}:handoff`)
              .digest("hex")
              .slice(0, 12);
            const compactionTraceId = createHash("sha256")
              .update(compactionExecutionKey)
              .digest("hex")
              .slice(0, 12);
            const freshCompactionTraceId = `${handoffTraceId}_${freshConversationPerTurn ? "fresh" : "fallback"}`;
            const compactionNativeIdentity = extractChatGptTurnIdentity(parsed);
            // Durable, idempotent handoff state: a compaction whose handoff already committed is
            // answered from the committed summary and is never replayed or duplicated.
            const compactionHandoffStore = new ChatGptCompactionHandoffStore(
              turnJournalStatePath
                ? join(dirname(turnJournalStatePath), "compaction-handoffs.json")
                : undefined,
            );
            const committedHandoff = compactionHandoffStore.lookup(compactionExecutionKey);
            // A committed handoff durably supersedes the source response this compaction replaced.
            // That source's post-Send restart tombstone must stop failing closed the designed resume
            // of the same native turn; a compaction that never commits keeps its tombstone as-is.
            // Only a completed ("final") source keeps its crash-replay tombstone.
            const supersedeCompactedSourceJournal = (handoffTraceId: string): void => {
              try {
                const checkpoint = turnJournal.checkpoint(compactedSourceExecutionKey);
                if (!checkpoint || checkpoint.completion === "final") return;
                turnJournal.clear(compactedSourceExecutionKey);
                emitChatGptWebStructuredTrace("compaction_handoff_journal_released", {
                  traceId: handoffTraceId,
                  sourceExecutionKeyHash: createHash("sha256").update(compactedSourceExecutionKey).digest("hex").slice(0, 16),
                });
              } catch (error) {
                console.error(`[chatgpt-web] failed to release compacted-source restart journal checkpoint: ${error instanceof Error ? error.message : String(error)}`);
              }
            };
            let sharedSummary = existingStructuredCompactionRun(compactionExecutionKey);
            if (!sharedSummary && committedHandoff) {
              emitChatGptWebStructuredTrace("compaction_handoff_committed", {
                traceId: compactionTraceId,
                replayed: true,
                summaryChars: committedHandoff.summary.length,
              });
              supersedeCompactedSourceJournal(compactionTraceId);
              sharedSummary = Promise.resolve(committedHandoff.summary);
            }
            if (!sharedSummary) {
              sharedSummary = runStructuredCompactionOnce(
                compactionExecutionKey,
                {
                  ownerKey: `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`,
                  traceIds: [
                    compactionTraceId,
                    handoffTraceId,
                    freshCompactionTraceId,
                  ],
                  ...(compactionNativeIdentity.threadId
                    ? { nativeThreadId: compactionNativeIdentity.threadId }
                    : {}),
                  ...(compactionNativeIdentity.turnId
                    ? { nativeTurnId: compactionNativeIdentity.turnId }
                    : {}),
                },
                async (operatorSignal, retainOwnershipUntil) => {
                  const handoffTimeoutMs = Math.min(
                    timeoutMs ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                    MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
                  );
                  emitChatGptWebStructuredTrace("compaction_requested", {
                    traceId: compactionTraceId,
                    executionDeadlineMs: handoffTimeoutMs,
                    executionDeadlineBoundary: "browser_admission",
                    queuePolicy: "separate_queue_wait_budget",
                  });
                  const handoffDeadline = new AbortController();
                  const handoffTimeoutError = new ChatGptWebAdapterError(
                    `ChatGPT compaction made no progress for ${handoffTimeoutMs}ms after browser admission`,
                    {
                      status: 409,
                      errorType: "invalid_request_error",
                      code: "compaction_execution_timeout",
                      retryable: false,
                    },
                  );
                  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
                  // Execution/settlement budget: armed only when the compaction can actually make
                  // progress — a granted browser slot, or an already-admitted retained source it
                  // begins to drive. Queue wait never consumes this budget.
                  const armExecutionDeadline = (): void => {
                    if (handoffDeadline.signal.aborted) return;
                    if (handoffTimer) clearTimeout(handoffTimer);
                    handoffTimer = setTimeout(
                      () => handoffDeadline.abort(handoffTimeoutError),
                      handoffTimeoutMs,
                    );
                    handoffTimer.unref?.();
                  };
                  // The compaction handed its next browser turn to the queue: any armed execution
                  // window pauses until that turn is admitted, so queue capacity waits cannot be
                  // misread as a stalled settlement.
                  const pauseExecutionDeadline = (): void => {
                    if (handoffTimer) {
                      clearTimeout(handoffTimer);
                      handoffTimer = undefined;
                    }
                  };
                  const operationSignal = AbortSignal.any([operatorSignal, handoffDeadline.signal]);
                  const sourceConversationKey = chatGptConversationKey(parsed, executionNamespace);
                  const compactionStartedAtMs = Date.now();
                  const abortReasonFromSignal = (signal: AbortSignal): Error =>
                    signal.reason instanceof Error ? signal.reason : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
                  const runFreshCompaction = async (reason: string): Promise<string> => {
                    if (freshConversationPerTurn) console.info("[chatgpt-web] compaction uses configured fresh conversation mode");
                    else console.warn(`[chatgpt-web] retained compaction fallback=${reason}`);
                    // The fresh compaction turn queues like any browser turn; the execution budget
                    // arms when the scheduler grants it a slot (onBrowserTurnSlotGranted) and is
                    // re-armed by accepted submissions and multipart acknowledgements below.
                    const fallbackRuntime = startRuntime(
                      parsed,
                      manualRequest ? environment : undefined,
                      freshCompactionTraceId,
                      turnCapabilities,
                      {
                        onCompactionProgress: armExecutionDeadline,
                        onBrowserTurnQueued: pauseExecutionDeadline,
                        onBrowserTurnSlotGranted: armExecutionDeadline,
                      },
                    );
                    retainOwnershipUntil(fallbackRuntime.physicalSettlement);
                    try {
                      const rawSummary = await withAbort(fallbackRuntime.browser, operationSignal);
                      await withAbort(fallbackRuntime.physicalSettlement, operationSignal);
                      // Server-side completeness fence: the compaction summary is accepted only
                      // after the broker proved every MCP context chunk was read. A summary
                      // produced from partial context is rejected fail-closed.
                      const mcpInstalled = fallbackRuntime.mcpContext
                        ? await fallbackRuntime.mcpContext.installed
                        : undefined;
                      if (mcpInstalled) {
                        for (;;) {
                          if (operationSignal.aborted) throw abortReasonFromSignal(operationSignal);
                          const revision = structuredBroker!.beginCompletionFence(mcpInstalled.token);
                          if (revision === undefined) {
                            await new Promise<void>(resolveSleep => {
                              const timer = setTimeout(resolveSleep, 150);
                              operationSignal.addEventListener("abort", () => {
                                clearTimeout(timer);
                                resolveSleep();
                              }, { once: true });
                            });
                            continue;
                          }
                          let committed = false;
                          try {
                            committed = structuredBroker!.commitCompletionFence(mcpInstalled.token, revision);
                          } catch (error) {
                            if (!(error instanceof ChatGptWebMcpContextIncompleteError)) throw error;
                            // State-descriptive classification: a summary written while the context
                            // reader never engaged (or after an explicit reader-unavailable signal)
                            // is a transport failure, not a partial-context summary. Both stay
                            // fail-closed; neither can commit a handoff.
                            const readState = structuredBroker!.contextReadSnapshot?.(mcpInstalled.token);
                            const readerNeverEngaged = readState !== undefined && readState.chunksRead === 0;
                            const readerUnavailableSignalled = typeof rawSummary === "string"
                              && rawSummary.includes(CHATGPT_WEB_MCP_CONTEXT_UNAVAILABLE_SENTINEL);
                            if (readerNeverEngaged || readerUnavailableSignalled) {
                              throw new ChatGptWebAdapterError(
                                "The MCP context reader did not engage in the compaction conversation; no summary was accepted.",
                                {
                                  status: 502,
                                  errorType: "invalid_request_error",
                                  code: "codex_mcp_context_unavailable",
                                  retryable: false,
                                },
                              );
                            }
                            throw new ChatGptWebAdapterError(
                              "ChatGPT produced the compaction summary before the MCP context completed; the partial summary was rejected",
                              {
                                status: 502,
                                errorType: "invalid_request_error",
                                code: "codex_mcp_context_incomplete",
                                retryable: false,
                              },
                            );
                          }
                          if (committed) break;
                        }
                        // Result observed is authoritative forward progress: re-arm the stall
                        // window for the purely local handoff commit (canonicalization plus the
                        // idempotent durable store write), so a summary that completed late in
                        // the generation budget can never race its own deadline.
                        armExecutionDeadline();
                        emitChatGptWebStructuredTrace("compaction_result_observed", {
                          traceId: freshCompactionTraceId,
                          contextIdHash: mcpInstalled.summary.contextIdHash,
                          totalChunks: mcpInstalled.summary.totalChunks,
                          estimatedTokens: mcpInstalled.summary.estimatedTokens,
                          summaryChars: rawSummary.length,
                          elapsedMs: Date.now() - compactionStartedAtMs,
                        });
                      }
                      const canonical = canonicalizeCompactionHandoff(parsed, rawSummary);
                      emitChatGptWebStructuredTrace("compaction_handoff_started", {
                        traceId: freshCompactionTraceId,
                        ...(mcpInstalled ? {
                          contextIdHash: mcpInstalled.summary.contextIdHash,
                          totalChunks: mcpInstalled.summary.totalChunks,
                          estimatedTokens: mcpInstalled.summary.estimatedTokens,
                        } : {}),
                        summaryChars: canonical.length,
                        elapsedMs: Date.now() - compactionStartedAtMs,
                      });
                      const handoffCommit = compactionHandoffStore.commit(compactionExecutionKey, canonical, freshCompactionTraceId);
                      emitChatGptWebStructuredTrace("compaction_handoff_committed", {
                        traceId: freshCompactionTraceId,
                        ...(mcpInstalled ? {
                          contextIdHash: mcpInstalled.summary.contextIdHash,
                          totalChunks: mcpInstalled.summary.totalChunks,
                          estimatedTokens: mcpInstalled.summary.estimatedTokens,
                        } : {}),
                        summaryChars: canonical.length,
                        elapsedMs: Date.now() - compactionStartedAtMs,
                        duplicate: handoffCommit.duplicate,
                      });
                      if (!handoffCommit.duplicate) {
                        // The agent resumes immediately after this commit; its continuation turn
                        // must reclaim admission instead of re-entering the FIFO tail.
                        const handoffThreadId = extractChatGptTurnIdentity(parsed).threadId;
                        if (handoffThreadId) {
                          grantChatGptContinuationCredit(handoffThreadId, CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff);
                          emitChatGptWebStructuredTrace("continuation_credit_granted", {
                            traceId: freshCompactionTraceId,
                            nativeThreadHash: chatGptWebTraceHash(handoffThreadId),
                            reason: CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff,
                          });
                        }
                      }
                      supersedeCompactedSourceJournal(freshCompactionTraceId);
                      if (mcpInstalled) {
                        void Promise.resolve(structuredBroker!.revoke(mcpInstalled.token)).catch(() => {});
                      }
                      return canonical;
                    } catch (error) {
                      fallbackRuntime.cancel(error instanceof Error ? error : new Error(String(error)));
                      // The shared owner retains physical settlement independently of this error.
                      // Neither a timeout nor operator cancellation can open a competing trace.
                      throw error;
                    }
                  };
                  let source: ChatGptTurnSession | undefined;
                  let preserveFinalResponse = false;
                  try {
                    if (freshConversationPerTurn) {
                      // Full native history is the compaction input. Prefer a bounded
                      // safe-boundary preemption over an immediate abort: keep a committed final
                      // replayable if it won the native compaction race, release at a tool
                      // boundary when the short grace allows it, and only force — typed and
                      // fail-closed for undecided native work — when the grace expires.
                      const preemption = await preemptCompactionSource({
                        sessions: chatGptTurnSessions,
                        executionKey: compactedSourceExecutionKey,
                        compactionTraceId,
                        operationSignal,
                        journal: turnJournal,
                      });
                      retainOwnershipUntil(preemption.settlement);
                      await withAbort(preemption.settlement, operationSignal);
                      return await runFreshCompaction("configured_fresh_conversation");
                    }
                    // The previous compaction may already have detached the retained head while
                    // its browser/helper is still unwinding. Do not inspect that old epoch or
                    // decide to open a fresh fallback until physical release has completed.
                    if (sourceConversationKey) {
                      await chatGptTurnSessions.waitForConversationRetirement(
                        sourceConversationKey,
                        operationSignal,
                      );
                    }
                    source = sourceConversationKey
                      ? chatGptTurnSessions.findConversationHead(sourceConversationKey)
                      : undefined;
                    preserveFinalResponse = !source?.isActive()
                      && source?.settledOutcome()?.type === "final";
                    const retainedKey = source?.conversationKey();
                    if (!source || !retainedKey) {
                      return await runFreshCompaction("source_unavailable_before_handoff");
                    }
                    let rawSummary: string;
                    if (manualRequest && source.isActive() && source.runtime.mode === "tools") {
                      // Driving an already-admitted retained source is execution: the budget arms now.
                      armExecutionDeadline();
                      const zeroRiskSummary = await settleActiveZeroRiskCompactionSource(
                        parsed,
                        source,
                        broker,
                        operationSignal,
                      );
                      if (zeroRiskSummary === undefined) {
                        preserveFinalResponse = true;
                        rawSummary = await runFreshCompaction("zero_risk_source_had_no_compaction_boundary");
                      } else {
                        rawSummary = zeroRiskSummary;
                      }
                    } else if (manualRequest) {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      armExecutionDeadline();
                      rawSummary = await runFreshCompaction("zero_risk_source_already_completed");
                    } else if (source.isActive() && source.runtime.mode === "tools") {
                      // Driving an already-admitted retained source is execution: the budget arms now.
                      armExecutionDeadline();
                      const settlement = await settleActiveCompactionSource(
                        parsed,
                        source,
                        structuredBroker!,
                        operationSignal,
                      );
                      preserveFinalResponse = !settlement.compactionInstructionDelivered;
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                        { onQueued: pauseExecutionDeadline, onAdmitted: armExecutionDeadline },
                      );
                    } else {
                      if (source.isActive()) {
                        const outcome = await withAbort(source.browserOutcome, operationSignal);
                        if (outcome.type === "error") throw outcome.error;
                        await withAbort(source.physicalSettlement, operationSignal);
                        preserveFinalResponse = true;
                      }
                      armExecutionDeadline();
                      rawSummary = await requestRetainedCompactionHandoff(
                        worker,
                        parsed,
                        source,
                        structuredBroker!,
                        configuredCapabilities,
                        handoffTraceId,
                        operationSignal,
                        handoffTimeoutMs,
                        { onQueued: pauseExecutionDeadline, onAdmitted: armExecutionDeadline },
                      );
                    }
                    const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
                    // Durable, idempotent handoff commit for the retained path too: a daemon
                    // restart retry of the same native compaction must receive the SAME committed
                    // summary instead of minting a new one from the model.
                    const retainedHandoffCommit = compactionHandoffStore.commit(compactionExecutionKey, summary, compactionTraceId);
                    emitChatGptWebStructuredTrace("compaction_handoff_committed", {
                      traceId: compactionTraceId,
                      summaryChars: summary.length,
                      duplicate: retainedHandoffCommit.duplicate,
                      retained: true,
                    });
                    if (!retainedHandoffCommit.duplicate) {
                      // Same continuation contract as the MCP_CONTEXT path: the agent resumes
                      // right after this commit and must not wait behind fresh queued work.
                      const retainedHandoffThreadId = extractChatGptTurnIdentity(parsed).threadId;
                      if (retainedHandoffThreadId) {
                        grantChatGptContinuationCredit(retainedHandoffThreadId, CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff);
                        emitChatGptWebStructuredTrace("continuation_credit_granted", {
                          traceId: compactionTraceId,
                          nativeThreadHash: chatGptWebTraceHash(retainedHandoffThreadId),
                          reason: CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff,
                        });
                      }
                    }
                    await withAbort(
                      preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey),
                      operationSignal,
                    );
                    supersedeCompactedSourceJournal(compactionTraceId);
                    return summary;
                  } catch (error) {
                    const retainedKey = source?.conversationKey();
                    if (!retainedKey) throw error;
                    let handoffError = error instanceof Error ? error : new Error(String(error));
                    try {
                      // Operator cancellation ends the logical compaction, but cancel-all must not
                      // acknowledge until the retained browser/helper owner has physically retired.
                      await (preserveFinalResponse
                        ? chatGptTurnSessions.retireConversationPreservingFinalResponse(
                          retainedKey,
                          source!,
                          compactedSourceExecutionKey,
                        )
                        : chatGptTurnSessions.retireConversationAndWait(retainedKey));
                    } catch (retirementError) {
                      handoffError = new AggregateError(
                        [handoffError, retirementError instanceof Error ? retirementError : new Error(String(retirementError))],
                        "Structured compaction failed and its retained conversation could not be retired",
                      );
                    }
                    if (handoffError instanceof ChatGptWebAdapterError
                      && handoffError.code === "compaction_source_unavailable") {
                      return await runFreshCompaction("source_disappeared_before_handoff");
                    }
                    throw handoffError;
                  } finally {
                    if (handoffTimer) clearTimeout(handoffTimer);
                  }
                },
              );
            }
            emit({ type: "heartbeat" });
            let summary: string;
            try {
              summary = await withAbort(sharedSummary, incoming.abortSignal);
            } catch (error) {
              if (incoming.abortSignal?.aborted
                && error instanceof DOMException
                && error.name === "AbortError") {
                // The observer detached; the shared exact compaction round continues and remains
                // available to a canonical reconnect without a second browser submission.
                throw error;
              }
              const handoffError = error instanceof Error ? error : new Error(String(error));
              console.error("[chatgpt-web] structured context handoff failed:", handoffError);
              const upstreamError = handoffError instanceof ChatGptWebAdapterError ? handoffError : undefined;
              emit({
                type: "error",
                message: upstreamError?.message ?? "ChatGPT did not complete the context handoff. Retry the task.",
                status: upstreamError?.status ?? 409,
                errorType: upstreamError?.errorType ?? "invalid_request_error",
                code: upstreamError?.code ?? "compaction_handoff_failed",
                // Compaction retry remains an explicit operator decision even when its source
                // failure was retryable; preserve the cause without opening a new retry loop.
                retryable: false,
              });
              return;
            }
            emit({ type: "text_delta", text: summary, phase: "final_answer" });
            emitBrowserCompletion(
              { type: "final", answer: summary },
              estimateChatGptWebUsage(parsed, { answer: summary, reasoning: [] }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
              emit,
            );
            chatGptWebTurnRetryPolicy.clear(retryKey);
            return;
          }
          const responseExecutionKey = `${executionNamespace}:${chatGptCompactionSourceExecutionKey(parsed)}`;
          await chatGptTurnSessions.retireAndWait(responseExecutionKey, incoming.abortSignal);
        }
        const sourceExecutionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
        const executionKey = recoveryAttempt === 0
          ? sourceExecutionKey
          : `${sourceExecutionKey}:reference-recovery-${recoveryAttempt}`;
        const ownerKey = `${executionNamespace}:${chatGptThreadOwnershipKey(parsed)}`;
        const nativeIdentity = extractChatGptTurnIdentity(parsed);
        const nativeTurnId = nativeIdentity.turnId;
        if (!nativeTurnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser ownership");
        const abortedTurnIds = manualRequest ? new Set(priorChatGptAbortedTurnIds(parsed)) : undefined;
        if (abortedTurnIds?.size) {
          chatGptTurnSessions.retireAbortedOwnerTurns(ownerKey, abortedTurnIds, executionKey);
        }
        const sourceTraceId = chatGptWebTraceId(provider, parsed);
        const traceId = recoveryAttempt === 0
          ? sourceTraceId
          : createHash("sha256").update(`${sourceTraceId}:reference-recovery-${recoveryAttempt}`).digest("hex").slice(0, 12);
        const existingSession = chatGptTurnSessions.find(executionKey);
        const reconnecting = existingSession !== undefined;
        if (existingSession?.settledOutcome()?.type === "error") {
          emitChatGptWebStructuredTrace("codex_retry_blocked_after_terminal_submission", {
            traceId,
            turnHash: chatGptWebTraceHash(nativeTurnId),
            reason: "terminal_session_replay",
          }, "info");
        }
        if (!reconnecting && !parsed._compactionRequest) {
          const restartCheckpoint = turnJournal.checkpoint(executionKey);
          if (restartCheckpoint) {
            emitChatGptWebStructuredTrace("codex_retry_blocked_after_terminal_submission", {
              traceId,
              turnHash: chatGptWebTraceHash(nativeTurnId),
              reason: "journal_recovery_barrier",
              previousOutcome: restartCheckpoint.completion,
            }, "info");
            emit({
              type: "error",
              message: restartCheckpoint.completion === "running"
                ? "ChatGPT may already be processing this turn from before the local runtime restarted. Reconnect to the existing ChatGPT turn or start a new Codex turn explicitly."
                : "This exact ChatGPT turn already reached a terminal state before the local runtime restarted, but its response body is not available for crash replay. Start a new Codex turn explicitly if you want to run it again.",
              status: 409,
              errorType: "invalid_request_error",
              code: "chatgpt_restart_recovery_required",
              retryable: false,
            });
            return;
          }
        }
        const retryGate = reconnecting
          ? undefined
          : await chatGptWebTurnRetryPolicy.waitForAttempt(retryKey, incoming.abortSignal);
        if (retryGate && (retryGate.retryNumber > 0 || retryGate.circuitState !== "CLOSED")) {
          console.info(
            `[chatgpt-web] turn ${traceId} retry=${retryGate.retryNumber}`
            + ` backoffMs=${retryGate.backoffMs} circuit=${retryGate.circuitState}`,
          );
        }
        let session: ChatGptTurnSession;
        let schedulerRateLimitPressureRecorded = false;
        try {
          session = await chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
            executionKey,
            ownerKey,
            () => startRuntime(parsed, environment, traceId, turnCapabilities, {
              recoveryContinuation: recoveryAttempt > 0,
              onRecoveryRegistered: () => {
                if (referenceRecovery.state === "recovery_safe") referenceRecovery.advance("fresh_turn_registered");
              },
              beforePhysicalSubmission: () => chatGptWebTurnRetryPolicy.waitForAttempt(retryKey, incoming.abortSignal).then(() => undefined),
              onRateLimitPressure: error => {
                chatGptWebTurnRetryPolicy.recordRateLimitPressure(retryKey, error.retryAfterMs);
                schedulerRateLimitPressureRecorded = true;
              },
              onSubmissionActivated: conversationKey => {
                turnJournal.recordSubmission(executionKey, "send_activated", {
                  traceId,
                  nativeThreadId: nativeIdentity.threadId,
                  nativeTurnId,
                  conversationKey,
                  retryCount: retryGate?.retryNumber ?? 0,
                });
                console.info(`[chatgpt-web] send_safety_checkpoint ${JSON.stringify({
                  traceId,
                  durable: turnJournalStatePath !== undefined,
                })}`);
                emitChatGptWebStructuredTrace("submission_send_activated", {
                  traceId,
                  nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
                  nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
                  retryCount: retryGate?.retryNumber ?? 0,
                  durableJournal: turnJournalStatePath !== undefined,
                  conversationHash: chatGptWebTraceHash(conversationKey),
                });
              },
              onSendDispatchAttempted: () => {
                console.info(`[chatgpt-web] send_dispatch_attempted ${JSON.stringify({ traceId })}`);
              },
              onSubmissionAccepted: conversationKey => {
                turnJournal.recordSubmission(executionKey, "accepted", {
                  traceId,
                  nativeThreadId: nativeIdentity.threadId,
                  nativeTurnId,
                  conversationKey,
                  retryCount: retryGate?.retryNumber ?? 0,
                });
                console.info(`[chatgpt-web] submission_accepted ${JSON.stringify({ traceId })}`);
                emitChatGptWebStructuredTrace("submission_accepted", {
                  traceId,
                  nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
                  nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
                  retryCount: retryGate?.retryNumber ?? 0,
                  conversationHash: chatGptWebTraceHash(conversationKey),
                });
                chatGptWebTurnRetryPolicy.recordSubmissionAccepted(retryKey);
                if (recoveryAttempt > 0) {
                  referenceRecovery.advance("fresh_turn_submitted");
                  referenceRecovery.advance("continuation_active");
                  emitChatGptWebStructuredTrace("fresh_turn_accepted", {
                    traceId, recoveryGeneration: recoveryAttempt,
                    sourceTraceHash: chatGptWebTraceHash(sourceTraceId),
                  });
                }
              },
              onMultipartStageSendActivated: (stageIndex, conversationKey) => {
                turnJournal.recordMultipartStage(executionKey, "sent", stageIndex, {
                  traceId,
                  nativeThreadId: nativeIdentity.threadId,
                  nativeTurnId,
                  conversationKey,
                  retryCount: retryGate?.retryNumber ?? 0,
                });
                const checkpoint = turnJournal.checkpoint(executionKey);
                emitChatGptWebStructuredTrace("multipart_stage_sent", {
                  traceId,
                  nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
                  nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
                  stageIndex,
                  retryCount: retryGate?.retryNumber ?? 0,
                  durableJournal: turnJournalStatePath !== undefined,
                  lastSentStage: checkpoint?.multipartLastSentStage,
                  lastAcknowledgedStage: checkpoint?.multipartLastAcknowledgedStage ?? 0,
                  conversationHash: chatGptWebTraceHash(conversationKey),
                });
              },
              onMultipartTransactionRestart: (info, conversationKey) => {
                // The abandoned transaction held only inert stages; its journal records die with
                // the failed conversation so the fresh transaction records from part one. The
                // execution-safety proof is asserted again at this layer — fail closed.
                assertMultipartRestartSafety(info);
                try {
                  turnJournal.clear(executionKey);
                } catch (journalError) {
                  console.error(`[chatgpt-web] failed to clear abandoned multipart transaction journal: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
                }
                console.info(`[chatgpt-web] turn ${traceId} multipart transaction restart`
                  + ` attempt=${info.attempt} failedStage=${info.failedStage}`
                  + ` category=${info.failureCategory} conversation=${conversationKey ? "retired" : "none"}`);
              },
              onMultipartStageAcknowledged: (stageIndex, conversationKey) => {
                turnJournal.recordMultipartStage(executionKey, "acknowledged", stageIndex, {
                  traceId,
                  nativeThreadId: nativeIdentity.threadId,
                  nativeTurnId,
                  conversationKey,
                  retryCount: retryGate?.retryNumber ?? 0,
                });
                const checkpoint = turnJournal.checkpoint(executionKey);
                emitChatGptWebStructuredTrace("multipart_stage_acknowledged", {
                  traceId,
                  nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
                  nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
                  stageIndex,
                  retryCount: retryGate?.retryNumber ?? 0,
                  lastSentStage: checkpoint?.multipartLastSentStage,
                  lastAcknowledgedStage: checkpoint?.multipartLastAcknowledgedStage,
                  conversationHash: chatGptWebTraceHash(conversationKey),
                });
              },
            }),
            traceId,
            incoming.abortSignal,
            nativeTurnId,
            nativeIdentity.threadId,
            chatGptInstructionLineage(parsed),
          );
        } catch (error) {
          if (retryGate?.halfOpenProbe) chatGptWebTurnRetryPolicy.releaseProbe(retryKey);
          throw error;
        }
        const roundKey = chatGptTurnRoundKey(parsed);
        const emitRoundEvents = (events: readonly AdapterEvent[]): void => {
          // Journal the complete synchronous event batch before touching the HTTP observer. If the
          // observer disconnects midway through emission, an exact reconnect can replay the entire
          // canonical batch instead of losing the already-drained tail.
          session.appendRoundEvents(roundKey, events);
          try {
            turnJournal.recordEvents(executionKey, events);
          } catch (error) {
            console.error(`[chatgpt-web] failed to advance turn journal event checkpoint: ${error instanceof Error ? error.message : String(error)}`);
          }
          for (const event of events) emit(event);
        };
        const emitRoundBatch = (
          produce: (buffer: (event: AdapterEvent) => void) => void,
        ): void => {
          const events: AdapterEvent[] = [];
          produce(event => events.push(event));
          emitRoundEvents(events);
        };
        const emitRoundEvent = (event: AdapterEvent): void => emitRoundEvents([event]);
        try {
          await session.runExclusive(async () => {
            const replay = session.roundEvents(roundKey);
            replayEvents(replay, emit);
            if (session.roundCompleted(roundKey)) {
              const failure = session.roundFailure(roundKey);
              if (failure) throw failure;
              return;
            }
            if (session.roundHasTerminalEvent(roundKey)) {
              session.completeRound(roundKey);
              return;
            }
            const settled = session.settledOutcome();
            if (settled) {
              if (settled.type === "error") throw settled.error;
              const trace = session.runtime.trace.drain();
              const completedTextDeltas = session.runtime.text.drain();
              const finalReplay = replay.length === 0
                && trace.length === 0
                && completedTextDeltas.length === 0
                ? session.eventsForFinalReplay()
                : [];
              if (finalReplay.length > 0) {
                session.appendRoundReasoning(roundKey, session.reasoningForFinalReplay());
                emitRoundEvents(finalReplay);
              } else {
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                if (replay.length === 0 && !parsed._compactionRequest) {
                  emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
                }
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
                if (!bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(completedTextDeltas, buffer));
                }
              }
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              structuredOutputValidator?.(settled.answer);
              if (bufferStructuredOutput) {
                emitRoundBatch(buffer => emitTextDeltas([settled.answer], buffer));
              }
              const reasoning = session.roundReasoning(roundKey);
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.roundEvents(roundKey));
              emitRoundBatch(buffer => emitBrowserCompletion(
                settled,
                estimateChatGptWebUsage(parsed, { answer: settled.answer, reasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                buffer,
              ));
              session.completeRound(roundKey);
              try { turnJournal.recordTerminal(executionKey, "final", { response: settled.answer }); } catch (error) {
                console.error(`[chatgpt-web] failed to persist terminal turn journal checkpoint: ${error instanceof Error ? error.message : String(error)}`);
              }
              emitChatGptWebStructuredTrace("turn_completed", {
                traceId,
                nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
                nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
                retryCount: retryGate?.retryNumber ?? 0,
                lastSentStage: session.runtime.submission?.lastSentMultipartStage ?? 0,
                lastAcknowledgedStage: session.runtime.submission?.lastAcknowledgedMultipartStage ?? 0,
                outcome: "final",
              });
              chatGptWebTurnRetryPolicy.clear(retryKey);
              return;
            }

            let turnToken: string | undefined;
            if (session.runtime.mode === "tools") {
              turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
              if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
              await broker.updateEnvironment(turnToken, environment);

              const outstanding = session.outstanding();
              if (outstanding.length > 0) {
                const results = currentToolResults(parsed, session);
                if (results.length === 0) {
                  const reasoning = session.reasoningForOutstandingReplay();
                  if (replay.length === 0) emitRoundEvents(session.eventsForOutstandingReplay());
                  emitRoundBatch(buffer => emitToolBatch(
                    outstanding,
                    estimateChatGptWebUsage(parsed, { reasoning, toolRequests: outstanding }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                    buffer,
                  ));
                  session.completeRound(roundKey);
                  return;
                }
                if (results.length !== outstanding.length) {
                  throw new Error(`Codex returned ${results.length} of ${outstanding.length} results for a parallel ChatGPT tool batch`);
                }
                for (const message of results) {
                  await broker.completeTool(turnToken, message.toolCallId, brokerResult(message));
                  session.recordProgress("tool");
                  session.runtime.externalProgress.recordToolResult();
                  session.markResultDelivered(message.toolCallId);
                  try { turnJournal.recordToolResult(executionKey, message.toolCallId); } catch (error) {
                    console.error(`[chatgpt-web] failed to persist tool-result turn journal checkpoint: ${error instanceof Error ? error.message : String(error)}`);
                  }
                }
              }
            } else if (session.outstanding().length > 0) {
              throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
            }

            const toolWaitAbort = new AbortController();
            try {
              const roundReasoning = session.roundReasoning(roundKey);
              const emitNewTrace = (trace: ChatGptTraceEvent[]) => {
                roundReasoning.push(...trace.map(event => event.text));
                session.appendRoundReasoning(roundKey, trace.map(event => event.text));
                emitRoundBatch(buffer => emitTraceEvents(trace, buffer));
              };
              let pendingRecoveryDeltas: string[] = [];
              const emitNewText = (deltas: string[]) => {
                if (bufferStructuredOutput) return;
                pendingRecoveryDeltas.push(...deltas);
                const candidate = pendingRecoveryDeltas.join("").trimStart();
                if (CHATGPT_TURN_REFERENCE_RECOVERY_MARKER.startsWith(candidate)
                  || (candidate.startsWith(CHATGPT_TURN_REFERENCE_RECOVERY_MARKER)
                    && candidate.slice(CHATGPT_TURN_REFERENCE_RECOVERY_MARKER.length).trim() === "")) return;
                const ready = pendingRecoveryDeltas;
                pendingRecoveryDeltas = [];
                emitRoundBatch(buffer => emitTextDeltas(ready, buffer));
              };
              if (replay.length === 0 && !parsed._compactionRequest) {
                emitRoundBatch(buffer => emitReadOnlyContextWarning(parsed, turnCapabilities, buffer));
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              const externalProgress = session.runtime.mode === "tools"
                ? session.runtime.externalProgress
                : undefined;
              const armNextTools = () => turnToken
                ? broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(async requests => {
                  if (!externalProgress) {
                    throw new Error("ChatGPT broker returned tools for a read-only browser turn");
                  }
                  if (requests.length > 0) {
                    session.recordProgress("mcp");
                    const revision = externalProgress.recordToolBatch(requests.length);
                    if (!session.runtime.manualControl) {
                      // The browser outcome is in the same race below and owns the semantic DOM and
                      // renderer deadlines. A second fixed timer here can retire an accepted turn
                      // while its same-tab observer is still recovering. Keep the causal barrier —
                      // tools are not emitted until the browser captures their text boundary — but
                      // let browser settlement or request cancellation end the wait.
                      await externalProgress.waitForToolBatchObservation(
                        revision,
                        toolWaitAbort.signal,
                      );
                    }
                    externalProgress.assertToolBatchActive(revision);
                  }
                  return { type: "tools" as const, requests };
                }).catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error))
                : undefined;
              let nextTools = armNextTools();
              const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
              const finishBrowserOutcome = async (completedOutcome: ChatGptBrowserOutcome): Promise<void> => {
                // Zero Risk completion and its owner-only empty-batch signal are resolved by the
                // same broker transition. Drain once more so the accepted final answer cannot be
                // overtaken by the terminal owner notification.
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.roundEvents(roundKey));
                if (completedOutcome.type === "error") throw completedOutcome.error;
                if (session.runtime.text.value() !== completedOutcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                if (isTurnReferenceRecoveryAnswer(completedOutcome.answer)) {
                  if (recoveryAttempt > 0) {
                    referenceRecovery.fail();
                    throw new ChatGptWebAdapterError("Fresh browser continuation repeated a rejected turn reference.", {
                      status: 409, errorType: "invalid_request_error",
                      code: "turn_reference_recovery_exhausted", retryable: false,
                    });
                  }
                  referenceRecovery.advance("tool_reference_rejected");
                  referenceRecovery.advance("fencing_source_generation");
                  if (!turnToken || !structuredBroker) {
                    referenceRecovery.fail();
                    throw new ChatGptWebAdapterError("The browser turn could not prove its recovery origin.", {
                      status: 409, errorType: "invalid_request_error",
                      code: "turn_origin_unverifiable", retryable: false,
                    });
                  }
                  if (session.outstanding().length > 0) {
                    referenceRecovery.advance("outcome_uncertain");
                    throw new ChatGptWebAdapterError("A delivered native tool has no authoritative completed result; automatic continuation is unsafe.", {
                      status: 409, errorType: "invalid_request_error",
                      code: "execution_outcome_uncertain", retryable: false,
                    });
                  }
                  const reason = structuredBroker.consumeRecoveryRequest(turnToken);
                  if (!reason) {
                    referenceRecovery.fail();
                    throw new ChatGptWebAdapterError("The browser turn did not supply matching broker rejection evidence and a committed completion fence.", {
                      status: 409, errorType: "invalid_request_error",
                      code: "turn_origin_unverifiable", retryable: false,
                    });
                  }
                  // The browser worker returns a final answer only after its broker completion
                  // fence commits. consumeRecoveryRequest requires that exact committed channel.
                  // Physical settlement then proves the source observer and helper have stopped.
                  await withAbort(session.physicalSettlement, incoming.abortSignal);
                  referenceRecovery.advance("source_quiescent");
                  referenceRecovery.advance("reconciling_tool_history");
                  const checkpoint = turnJournal.checkpoint(executionKey);
                  if ((checkpoint?.outstandingToolCallHashes?.length ?? 0) > 0) {
                    referenceRecovery.advance("outcome_uncertain");
                    throw new ChatGptWebAdapterError("The durable journal has an unresolved native tool; automatic continuation is unsafe.", {
                      status: 409, errorType: "invalid_request_error",
                      code: "execution_outcome_uncertain", retryable: false,
                    });
                  }
                  referenceRecovery.advance("recovery_safe");
                  turnJournal.recordTerminal(executionKey, "error", { errorCode: "turn_reference_recovered" });
                  await broker.revoke(turnToken);
                  session.completeRound(roundKey);
                  emitChatGptWebStructuredTrace("recovery_source_quiescent", {
                    traceId, recoveryGeneration: 0, recoveryReason: reason,
                    sourceTraceHash: chatGptWebTraceHash(traceId),
                    toolReconciliationState: "no_outstanding_native_calls",
                    knownToolResults: parsed.context.messages.filter(message => message.role === "toolResult").length,
                  });
                  throw new FreshTurnRecoveryRequested(reason);
                }
                if (pendingRecoveryDeltas.length > 0 && !bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas(pendingRecoveryDeltas, buffer));
                  pendingRecoveryDeltas = [];
                }
                if (turnToken) await broker.revoke(turnToken);
                structuredOutputValidator?.(completedOutcome.answer);
                if (bufferStructuredOutput) {
                  emitRoundBatch(buffer => emitTextDeltas([completedOutcome.answer], buffer));
                }
                emitRoundBatch(buffer => emitBrowserCompletion(
                  completedOutcome,
                  estimateChatGptWebUsage(parsed, { answer: completedOutcome.answer, reasoning: roundReasoning }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                try { turnJournal.recordTerminal(executionKey, "final", { response: completedOutcome.answer }); } catch (error) {
                  console.error(`[chatgpt-web] failed to persist terminal turn journal checkpoint: ${error instanceof Error ? error.message : String(error)}`);
                }
                emitChatGptWebStructuredTrace("turn_completed", {
                  traceId,
                  nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
                  nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
                  retryCount: retryGate?.retryNumber ?? 0,
                  lastSentStage: session.runtime.submission?.lastSentMultipartStage ?? 0,
                  lastAcknowledgedStage: session.runtime.submission?.lastAcknowledgedMultipartStage ?? 0,
                  outcome: "final",
                });
                chatGptWebTurnRetryPolicy.clear(retryKey);
                if (recoveryAttempt > 0) referenceRecovery.advance("terminal");
              };
              const waitForTrace = () => session.runtime.trace.wait(toolWaitAbort.signal)
                .then(() => ({ type: "trace" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              const waitForText = () => session.runtime.text.wait(toolWaitAbort.signal)
                .then(() => ({ type: "text" as const }))
                .catch(error => toolWaitAbort.signal.aborted
                  ? new Promise<never>(() => {})
                  : Promise.reject(error));
              let nextTrace = waitForTrace();
              let nextText = waitForText();
              for (;;) {
                const next = await withAbort(
                  Promise.race([
                    ...(nextTools ? [nextTools] : []),
                    browserOutcome,
                    nextTrace,
                    nextText,
                  ]),
                  incoming.abortSignal,
                );
                if (next.type === "trace") {
                  emitNewTrace(session.runtime.trace.drain());
                  nextTrace = waitForTrace();
                  continue;
                }
                if (next.type === "text") {
                  emitNewText(session.runtime.text.drain());
                  nextText = waitForText();
                  continue;
                }
                emitNewTrace(session.runtime.trace.drain());
                emitNewText(session.runtime.text.drain());
                if (next.type === "browser") {
                  await finishBrowserOutcome(next.outcome);
                  return;
                }
                if (!turnToken || session.runtime.mode !== "tools" || !externalProgress) {
                  throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
                }
                if (next.requests.length === 0) {
                  if (!session.runtime.manualControl) {
                    throw new Error("ChatGPT tool bridge returned an empty batch");
                  }
                  await finishBrowserOutcome(await session.browserOutcome);
                  return;
                }
                validateBatchTools(parsed, next.requests);
                session.setOutstanding(next.requests, roundReasoning, session.roundEvents(roundKey));
                try { turnJournal.recordOutstandingToolCalls(executionKey, next.requests.map(request => request.callId)); } catch (error) {
                  console.error(`[chatgpt-web] failed to persist tool-batch turn journal checkpoint: ${error instanceof Error ? error.message : String(error)}`);
                }
                emitRoundBatch(buffer => emitToolBatch(
                  next.requests,
                  estimateChatGptWebUsage(parsed, { reasoning: roundReasoning, toolRequests: next.requests }, turnCapabilities, experimentalBiggerContext, experimentalSkillAttachments),
                  buffer,
                ));
                session.completeRound(roundKey);
                return;
              }
            } finally {
              toolWaitAbort.abort();
            }
          });
        } catch (error) {
          if (error instanceof FreshTurnRecoveryRequested) {
            chatGptTurnSessions.retire(executionKey, session);
            await chatGptTurnSessions.retireAndWait(executionKey, incoming.abortSignal);
            emitChatGptWebStructuredTrace("recovery_started", {
              traceId, recoveryGeneration: 1, recoveryReason: error.reason,
              sourceTraceHash: chatGptWebTraceHash(traceId),
              sourceQuiescent: true, toolReconciliationState: "known_completed_or_never_delivered",
            });
            try {
              await runChatGptWebTurn(1);
            } catch (recoveryError) {
              emitChatGptWebStructuredTrace("recovery_failed", {
                traceId, recoveryGeneration: 1, sourceTraceHash: chatGptWebTraceHash(traceId),
                errorCode: recoveryError instanceof ChatGptWebAdapterError ? recoveryError.code : "unclassified",
              }, "error");
              throw recoveryError;
            }
            emitChatGptWebStructuredTrace(recoveryGenerationFailed ? "recovery_failed" : "recovery_completed", {
              traceId, recoveryGeneration: 1, sourceTraceHash: chatGptWebTraceHash(traceId),
            }, recoveryGenerationFailed ? "error" : "info");
            return;
          }
          if (recoveryAttempt > 0) recoveryGenerationFailed = true;
          if (recoveryAttempt > 0 || referenceRecovery.state !== "active_browser_turn") referenceRecovery.fail();
          if (incoming.abortSignal?.aborted && error instanceof DOMException && error.name === "AbortError") {
            if (session.runtime.manualControl || session.runtime.submission?.phase === "prepared") {
              // Zero Risk is user-driven and has no DOM observer that can distinguish continued
              // work from a stopped native turn. A pre-submission automatic turn is also safe to
              // retire because no prompt can have reached ChatGPT yet.
              chatGptTurnSessions.retire(executionKey, session);
              chatGptWebTurnRetryPolicy.releaseProbe(retryKey);
            }
            // Post-Send automatic browser turns keep their exact execution and journal for
            // reconnect. Their owned DOM observer can continue proving the same physical ChatGPT
            // submission without ever replaying the prompt.
            throw error;
          }
          const turnError = submittedTurnFailure(session, error);
          const recovery = classifyChatGptRecovery(turnError, {
            submissionPhase: session.runtime.submission?.phase,
          });
          const safeRetry = turnError instanceof ChatGptWebAdapterError
            && turnError.retryable
            && recovery.mayResubmit;
          let handledError: Error = turnError;
          if (turnError instanceof ChatGptWebAdapterError && recovery.class === "CHATGPT_RATE_LIMITED") {
            if (safeRetry) {
              handledError = chatGptWebTurnRetryPolicy.recordRetryableFailure(
                retryKey,
                turnError,
                undefined,
                { rateLimitPressureAlreadyRecorded: schedulerRateLimitPressureRecorded },
              );
            } else if (!schedulerRateLimitPressureRecorded) {
              chatGptWebTurnRetryPolicy.recordRateLimitPressure(retryKey, turnError.retryAfterMs);
            }
          } else if (safeRetry && turnError instanceof ChatGptWebAdapterError) {
            handledError = chatGptWebTurnRetryPolicy.recordRetryableFailure(retryKey, turnError);
          } else {
            chatGptWebTurnRetryPolicy.clear(retryKey);
          }
          let willRetry = safeRetry
            && handledError instanceof ChatGptWebAdapterError
            && handledError.retryable;
          if (willRetry) {
            // Explicit provider evidence can prove that a post-Send activation was rejected before
            // ChatGPT accepted it. Remove that safety tombstone only after classification has made
            // the next fresh submission safe; every ambiguous outcome keeps its durable checkpoint.
            try { turnJournal.clear(executionKey); } catch (journalError) {
              console.error(`[chatgpt-web] failed to clear rejected-submission turn journal checkpoint: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
              handledError = new ChatGptWebAdapterError("ChatGPT proved the submission was rejected, but the local restart journal could not be cleared safely.", {
                status: 500,
                errorType: "server_error",
                code: "turn_journal_clear_failed",
                retryable: false,
                cause: journalError,
              });
              willRetry = false;
            }
          }
          console.info(
            `[chatgpt-web] turn ${traceId} recovery=${recovery.class}`
            + ` phase=${session.runtime.submission?.phase ?? "unknown"}`
            + ` retryable=${safeRetry} resubmit=${recovery.mayResubmit}`,
          );
          emitChatGptWebStructuredTrace("retry_decision", {
            traceId,
            nativeThreadHash: chatGptWebTraceHash(nativeIdentity.threadId),
            nativeTurnHash: chatGptWebTraceHash(nativeTurnId),
            retryCount: retryGate?.retryNumber ?? 0,
            submissionPhase: session.runtime.submission?.phase ?? "unknown",
            lastSentStage: session.runtime.submission?.lastSentMultipartStage ?? 0,
            lastAcknowledgedStage: session.runtime.submission?.lastAcknowledgedMultipartStage ?? 0,
            recoveryClass: recovery.class,
            mayResubmit: recovery.mayResubmit,
            safeRetry,
            willRetry,
            errorName: handledError.name,
            ...(handledError instanceof ChatGptWebAdapterError ? {
              errorCode: handledError.code,
              errorType: handledError.errorType,
              status: handledError.status,
              retryable: handledError.retryable,
              submissionRejected: handledError.submissionRejected,
            } : {}),
          }, willRetry ? "warning" : "error");
          if (handledError instanceof ChatGptWebAdapterError && !handledError.retryable) {
            // A deterministic request failure remains replayable so a native reconnect cannot burn
            // another browser attempt. Every other failure retires the browser session: client
            // disconnects, stage failures, and retryable ChatGPT errors must start a fresh surface
            // instead of replaying one rejected browser outcome for the registry's full TTL.
            session.cancel();
          } else {
            chatGptTurnSessions.retire(executionKey, session);
          }
          if (session.runtime.mode === "tools") {
            void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
          }
          if (handledError instanceof ChatGptWebAdapterError) {
            if (session.runtime.submission?.phase !== "prepared" && !willRetry) {
              try {
                turnJournal.recordTerminal(
                  executionKey,
                  handledError.code === "client_cancelled" ? "cancelled" : "error",
                  { errorCode: handledError.code },
                );
              } catch (journalError) {
                console.error(`[chatgpt-web] failed to persist failed turn journal checkpoint: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
              }
            }
            emitRoundEvent({
              type: "error",
              message: handledError.message,
              status: handledError.status,
              errorType: handledError.errorType,
              code: handledError.code,
              retryable: handledError.retryable,
            });
            session.completeRound(roundKey);
            return;
          }
          session.failRound(roundKey, turnError);
          chatGptWebTurnRetryPolicy.clear(retryKey);
          throw turnError;
        }
      };

      // Arm this before any awaited work, including environment lookup and owner retirement.
      const heartbeat = setInterval(
        () => emit({ type: "heartbeat" }),
        CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
      );
      try {
        emit({ type: "heartbeat" });
        await runChatGptWebTurn(initialRecoveryAttempt);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
