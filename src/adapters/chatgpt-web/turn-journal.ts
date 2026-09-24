import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import type { AdapterEvent } from "../../types";
import type { ChatGptSubmissionPhase } from "./recovery-classification";

export type ChatGptTurnJournalCompletion = "running" | "final" | "error" | "cancelled";

export interface ChatGptTurnJournalCheckpoint {
  executionKeyHash: string;
  traceId: string;
  provider: "chatgpt-web";
  submissionPhase: Exclude<ChatGptSubmissionPhase, "prepared">;
  completion: ChatGptTurnJournalCompletion;
  eventSequence: number;
  retryCount: number;
  updatedAt: number;
  nativeThreadHash?: string;
  nativeTurnHash?: string;
  conversationHash?: string;
  outstandingToolCallHashes?: string[];
  eventChainHash?: string;
  responseHash?: string;
  errorCode?: string;
}

interface ChatGptTurnJournalFile {
  version: 1;
  entries: Record<string, ChatGptTurnJournalCheckpoint>;
}

export interface ChatGptTurnJournalIdentity {
  traceId: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  conversationKey?: string;
  retryCount?: number;
}

const MAX_TURN_JOURNAL_ENTRIES = 256;
const TURN_JOURNAL_TTL_MS = 24 * 60 * 60_000;
const SHA256_RE = /^[a-f0-9]{64}$/;

function isSafetyCriticalRunningCheckpoint(checkpoint: ChatGptTurnJournalCheckpoint): boolean {
  return checkpoint.completion === "running"
    && (checkpoint.submissionPhase === "send_activated" || checkpoint.submissionPhase === "accepted");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`Invalid persisted ChatGPT turn journal ${field}`);
  }
  return value;
}

function optionalHash(value: unknown, field: string): string | undefined {
  const parsed = boundedString(value, field, 64);
  if (parsed !== undefined && !SHA256_RE.test(parsed)) {
    throw new Error(`Invalid persisted ChatGPT turn journal ${field}`);
  }
  return parsed;
}

function validateCheckpoint(value: unknown): ChatGptTurnJournalCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted ChatGPT turn journal checkpoint");
  }
  const candidate = value as Partial<ChatGptTurnJournalCheckpoint>;
  const executionKeyHash = optionalHash(candidate.executionKeyHash, "execution key hash");
  const traceId = boundedString(candidate.traceId, "trace id", 128);
  const completion = candidate.completion;
  const submissionPhase = candidate.submissionPhase;
  if (!executionKeyHash || !traceId || candidate.provider !== "chatgpt-web"
    || (submissionPhase !== "send_activated" && submissionPhase !== "accepted")
    || (completion !== "running" && completion !== "final" && completion !== "error" && completion !== "cancelled")
    || !Number.isSafeInteger(candidate.eventSequence) || candidate.eventSequence! < 0
    || !Number.isSafeInteger(candidate.retryCount) || candidate.retryCount! < 0
    || typeof candidate.updatedAt !== "number" || !Number.isFinite(candidate.updatedAt)) {
    throw new Error("Invalid persisted ChatGPT turn journal checkpoint");
  }
  const outstanding = candidate.outstandingToolCallHashes;
  if (outstanding !== undefined && (!Array.isArray(outstanding)
    || outstanding.length > 128
    || outstanding.some(item => typeof item !== "string" || !SHA256_RE.test(item)))) {
    throw new Error("Invalid persisted ChatGPT turn journal outstanding tool calls");
  }
  return {
    executionKeyHash,
    traceId,
    provider: "chatgpt-web",
    submissionPhase,
    completion,
    eventSequence: candidate.eventSequence!,
    retryCount: candidate.retryCount!,
    updatedAt: candidate.updatedAt,
    ...(optionalHash(candidate.nativeThreadHash, "thread hash") ? { nativeThreadHash: candidate.nativeThreadHash } : {}),
    ...(optionalHash(candidate.nativeTurnHash, "turn hash") ? { nativeTurnHash: candidate.nativeTurnHash } : {}),
    ...(optionalHash(candidate.conversationHash, "conversation hash") ? { conversationHash: candidate.conversationHash } : {}),
    ...(outstanding ? { outstandingToolCallHashes: [...outstanding] } : {}),
    ...(optionalHash(candidate.eventChainHash, "event chain hash") ? { eventChainHash: candidate.eventChainHash } : {}),
    ...(optionalHash(candidate.responseHash, "response hash") ? { responseHash: candidate.responseHash } : {}),
    ...(boundedString(candidate.errorCode, "error code", 128) ? { errorCode: candidate.errorCode } : {}),
  };
}

/**
 * Privacy-safe restart checkpoint for browser turns that may already have reached ChatGPT.
 *
 * It intentionally stores no prompt, response text, tool arguments/results, tokens, cookies,
 * environment authority, or browser storage. Its primary safety purpose is duplicate suppression:
 * after a daemon restart an exact post-Send turn fails closed unless an in-memory owner still exists.
 */
export class ChatGptTurnJournal {
  private loaded = false;
  private readonly entries = new Map<string, ChatGptTurnJournalCheckpoint>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = TURN_JOURNAL_TTL_MS,
  ) {}

  checkpoint(executionKey: string): ChatGptTurnJournalCheckpoint | undefined {
    if (!this.path) return undefined;
    this.load();
    this.prune();
    const stored = this.entries.get(hash(executionKey));
    return stored ? { ...stored, outstandingToolCallHashes: stored.outstandingToolCallHashes ? [...stored.outstandingToolCallHashes] : undefined } : undefined;
  }

  recordSubmission(
    executionKey: string,
    phase: Exclude<ChatGptSubmissionPhase, "prepared">,
    identity: ChatGptTurnJournalIdentity,
  ): void {
    if (!this.path) return;
    this.load();
    const key = hash(executionKey);
    this.prune();
    const previous = this.entries.get(key);
    if (!previous) this.ensureCapacityForSafetyCheckpoint();
    const checkpoint: ChatGptTurnJournalCheckpoint = {
      executionKeyHash: key,
      traceId: identity.traceId,
      provider: "chatgpt-web",
      submissionPhase: phase === "accepted" || previous?.submissionPhase === "accepted" ? "accepted" : "send_activated",
      completion: previous?.completion ?? "running",
      eventSequence: previous?.eventSequence ?? 0,
      retryCount: identity.retryCount ?? previous?.retryCount ?? 0,
      updatedAt: this.now(),
      ...(identity.nativeThreadId ? { nativeThreadHash: hash(identity.nativeThreadId) } : previous?.nativeThreadHash ? { nativeThreadHash: previous.nativeThreadHash } : {}),
      ...(identity.nativeTurnId ? { nativeTurnHash: hash(identity.nativeTurnId) } : previous?.nativeTurnHash ? { nativeTurnHash: previous.nativeTurnHash } : {}),
      ...(identity.conversationKey ? { conversationHash: hash(identity.conversationKey) } : previous?.conversationHash ? { conversationHash: previous.conversationHash } : {}),
      ...(previous?.outstandingToolCallHashes ? { outstandingToolCallHashes: [...previous.outstandingToolCallHashes] } : {}),
      ...(previous?.eventChainHash ? { eventChainHash: previous.eventChainHash } : {}),
      ...(previous?.responseHash ? { responseHash: previous.responseHash } : {}),
      ...(previous?.errorCode ? { errorCode: previous.errorCode } : {}),
    };
    this.entries.delete(key);
    this.entries.set(key, checkpoint);
    this.prune();
    this.persist();
  }

  recordEvents(executionKey: string, events: readonly AdapterEvent[]): void {
    if (!this.path || events.length === 0) return;
    this.load();
    const key = hash(executionKey);
    const checkpoint = this.entries.get(key);
    if (!checkpoint) return;
    const previousSequence = checkpoint.eventSequence;
    checkpoint.eventSequence += events.length;
    checkpoint.eventChainHash = createHash("sha256")
      .update(checkpoint.eventChainHash ?? "")
      .update(JSON.stringify(events))
      .digest("hex");
    checkpoint.updatedAt = this.now();
    const crossedFlushBoundary = Math.floor(previousSequence / 16) !== Math.floor(checkpoint.eventSequence / 16);
    const terminalEvent = events.some(event => event.type === "done" || event.type === "error");
    if (crossedFlushBoundary || terminalEvent) this.persist();
  }

  recordOutstandingToolCalls(executionKey: string, callIds: readonly string[]): void {
    if (!this.path) return;
    this.load();
    const checkpoint = this.entries.get(hash(executionKey));
    if (!checkpoint) return;
    checkpoint.outstandingToolCallHashes = callIds.map(hash).sort();
    checkpoint.updatedAt = this.now();
    this.persist();
  }

  recordToolResult(executionKey: string, callId: string): void {
    if (!this.path) return;
    this.load();
    const checkpoint = this.entries.get(hash(executionKey));
    if (!checkpoint?.outstandingToolCallHashes) return;
    const delivered = hash(callId);
    checkpoint.outstandingToolCallHashes = checkpoint.outstandingToolCallHashes.filter(candidate => candidate !== delivered);
    checkpoint.updatedAt = this.now();
    this.persist();
  }

  recordTerminal(
    executionKey: string,
    completion: Exclude<ChatGptTurnJournalCompletion, "running">,
    options: { response?: string; errorCode?: string } = {},
  ): void {
    if (!this.path) return;
    this.load();
    const checkpoint = this.entries.get(hash(executionKey));
    if (!checkpoint) return;
    checkpoint.completion = completion;
    checkpoint.updatedAt = this.now();
    checkpoint.outstandingToolCallHashes = [];
    if (options.response !== undefined) checkpoint.responseHash = hash(options.response);
    if (options.errorCode) checkpoint.errorCode = options.errorCode.slice(0, 128);
    this.prune();
    this.persist();
  }

  clear(executionKey: string): void {
    if (!this.path) return;
    this.load();
    if (!this.entries.delete(hash(executionKey))) return;
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ChatGptTurnJournalFile>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
      throw new Error(`Invalid ChatGPT turn journal: ${this.path}`);
    }
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!SHA256_RE.test(key)) throw new Error(`Invalid ChatGPT turn journal key: ${this.path}`);
      const checkpoint = validateCheckpoint(value);
      if (checkpoint.executionKeyHash !== key) throw new Error(`Mismatched ChatGPT turn journal key: ${this.path}`);
      this.entries.set(key, checkpoint);
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, checkpoint] of this.entries) {
      if (!isSafetyCriticalRunningCheckpoint(checkpoint) && checkpoint.updatedAt < cutoff) {
        this.entries.delete(key);
      }
    }
    while (this.entries.size > MAX_TURN_JOURNAL_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, checkpoint] of this.entries) {
        if (isSafetyCriticalRunningCheckpoint(checkpoint)) continue;
        if (checkpoint.updatedAt < oldestAt) {
          oldestAt = checkpoint.updatedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        throw new Error(
          `ChatGPT turn journal safety capacity exhausted (${MAX_TURN_JOURNAL_ENTRIES} running post-Send checkpoints); manual recovery or explicit clearing is required`,
        );
      }
      this.entries.delete(oldestKey);
    }
  }

  private ensureCapacityForSafetyCheckpoint(): void {
    if (this.entries.size < MAX_TURN_JOURNAL_ENTRIES) return;
    let oldestTerminalKey: string | undefined;
    let oldestTerminalAt = Number.POSITIVE_INFINITY;
    for (const [key, checkpoint] of this.entries) {
      if (isSafetyCriticalRunningCheckpoint(checkpoint)) continue;
      if (checkpoint.updatedAt < oldestTerminalAt) {
        oldestTerminalAt = checkpoint.updatedAt;
        oldestTerminalKey = key;
      }
    }
    if (!oldestTerminalKey) {
      throw new Error(
        `ChatGPT turn journal safety capacity exhausted (${MAX_TURN_JOURNAL_ENTRIES} running post-Send checkpoints); refusing to evict duplicate-suppression state`,
      );
    }
    this.entries.delete(oldestTerminalKey);
  }

  private persist(): void {
    if (!this.path) return;
    const payload: ChatGptTurnJournalFile = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
