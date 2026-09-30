import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import type { AdapterEvent } from "../../types";
import type { ChatGptSubmissionPhase } from "./recovery-classification";
import { criticalStoreLoadFailure } from "./store-diagnostics";
import { emitChatGptWebStructuredTrace } from "./structured-trace";

export type ChatGptTurnJournalCompletion = "running" | "final" | "error" | "cancelled";

/**
 * Durable compaction-preemption marker. Created when a fresh-conversation compaction releases a
 * still-active source owner, and kept until the outcome is terminal: the client re-drive
 * completes (replay_completed), an explicit cancellation lands (cancelled), or the preemption
 * itself was fail-closed (replay_blocked_uncertain). Unresolved markers are exempt from pruning
 * so a preempted turn can never silently become a lost result.
 */
export type ChatGptCompactionPreemptionPhase =
  | "preempted"
  | "replaying"
  | "replay_completed"
  | "replay_blocked_uncertain"
  | "cancelled"
  | "failed_terminal";

export interface ChatGptCompactionPreemptionMarker {
  executionKeyHash: string;
  traceId: string;
  phase: ChatGptCompactionPreemptionPhase;
  pendingNativeExecutions: number;
  forced: boolean;
  createdAt: number;
  updatedAt: number;
  nativeThreadHash?: string;
  resolvedAt?: number;
}

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
  multipartLastSentStage?: number;
  multipartLastAcknowledgedStage?: number;
  outstandingToolCallHashes?: string[];
  eventChainHash?: string;
  responseHash?: string;
  errorCode?: string;
}

interface ChatGptTurnJournalFile {
  version: 1;
  entries: Record<string, ChatGptTurnJournalCheckpoint>;
  preemptions?: Record<string, ChatGptCompactionPreemptionMarker>;
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
const MAX_PREEMPTION_MARKERS = 64;
const PREEMPTION_PHASES: readonly ChatGptCompactionPreemptionPhase[] = [
  "preempted",
  "replaying",
  "replay_completed",
  "replay_blocked_uncertain",
  "cancelled",
  "failed_terminal",
];
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

function optionalStage(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 5) {
    throw new Error(`Invalid persisted ChatGPT turn journal ${field}`);
  }
  return value as number;
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
  const multipartLastSentStage = optionalStage(candidate.multipartLastSentStage, "multipart last sent stage");
  const multipartLastAcknowledgedStage = optionalStage(
    candidate.multipartLastAcknowledgedStage,
    "multipart last acknowledged stage",
  );
  if (multipartLastAcknowledgedStage !== undefined
    && (multipartLastSentStage === undefined || multipartLastAcknowledgedStage > multipartLastSentStage)) {
    throw new Error("Invalid persisted ChatGPT turn journal multipart acknowledgement ordering");
  }
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
    ...(multipartLastSentStage !== undefined ? { multipartLastSentStage } : {}),
    ...(multipartLastAcknowledgedStage !== undefined ? { multipartLastAcknowledgedStage } : {}),
    ...(outstanding ? { outstandingToolCallHashes: [...outstanding] } : {}),
    ...(optionalHash(candidate.eventChainHash, "event chain hash") ? { eventChainHash: candidate.eventChainHash } : {}),
    ...(optionalHash(candidate.responseHash, "response hash") ? { responseHash: candidate.responseHash } : {}),
    ...(boundedString(candidate.errorCode, "error code", 128) ? { errorCode: candidate.errorCode } : {}),
  };
}

function validatePreemptionMarker(key: string, value: unknown): ChatGptCompactionPreemptionMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted ChatGPT compaction preemption marker");
  }
  const candidate = value as Partial<ChatGptCompactionPreemptionMarker>;
  if (candidate.executionKeyHash !== key) throw new Error(`Mismatched ChatGPT compaction preemption marker key: ${key}`);
  const traceId = boundedString(candidate.traceId, "preemption trace id", 128);
  if (!traceId) throw new Error("Invalid persisted ChatGPT compaction preemption marker trace id");
  if (!PREEMPTION_PHASES.includes(candidate.phase as ChatGptCompactionPreemptionPhase)) {
    throw new Error("Invalid persisted ChatGPT compaction preemption phase");
  }
  if (!Number.isSafeInteger(candidate.pendingNativeExecutions) || candidate.pendingNativeExecutions! < 0
    || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt! <= 0
    || !Number.isSafeInteger(candidate.updatedAt) || candidate.updatedAt! < candidate.createdAt!) {
    throw new Error("Invalid persisted ChatGPT compaction preemption marker counters");
  }
  if (typeof candidate.forced !== "boolean") {
    throw new Error("Invalid persisted ChatGPT compaction preemption marker forced flag");
  }
  return {
    executionKeyHash: key,
    traceId,
    phase: candidate.phase as ChatGptCompactionPreemptionPhase,
    pendingNativeExecutions: candidate.pendingNativeExecutions!,
    forced: candidate.forced,
    createdAt: candidate.createdAt!,
    updatedAt: candidate.updatedAt!,
    ...(optionalHash(candidate.nativeThreadHash, "preemption thread hash") ? { nativeThreadHash: candidate.nativeThreadHash } : {}),
    ...(Number.isSafeInteger(candidate.resolvedAt) && candidate.resolvedAt! > 0 ? { resolvedAt: candidate.resolvedAt } : {}),
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
  private readonly preemptions = new Map<string, ChatGptCompactionPreemptionMarker>();

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

  recordMultipartStage(
    executionKey: string,
    state: "sent" | "acknowledged",
    stageIndex: number,
    identity: ChatGptTurnJournalIdentity,
  ): void {
    if (!this.path) return;
    if (!Number.isSafeInteger(stageIndex) || stageIndex <= 0 || stageIndex > 5) {
      throw new Error("Invalid ChatGPT multipart stage journal index");
    }
    this.load();
    const key = hash(executionKey);
    this.prune();
    const previous = this.entries.get(key);
    if (!previous) this.ensureCapacityForSafetyCheckpoint();
    const lastSent = previous?.multipartLastSentStage ?? 0;
    const lastAcknowledged = previous?.multipartLastAcknowledgedStage ?? 0;
    if (state === "sent") {
      if (stageIndex !== lastSent + 1 || stageIndex !== lastAcknowledged + 1) {
        throw new Error("ChatGPT multipart stage send journal ordering violation");
      }
    } else if (stageIndex !== lastSent || stageIndex !== lastAcknowledged + 1) {
      throw new Error("ChatGPT multipart stage acknowledgement journal ordering violation");
    }
    const checkpoint: ChatGptTurnJournalCheckpoint = {
      executionKeyHash: key,
      traceId: identity.traceId,
      provider: "chatgpt-web",
      submissionPhase: "send_activated",
      completion: previous?.completion ?? "running",
      eventSequence: previous?.eventSequence ?? 0,
      retryCount: identity.retryCount ?? previous?.retryCount ?? 0,
      updatedAt: this.now(),
      ...(identity.nativeThreadId ? { nativeThreadHash: hash(identity.nativeThreadId) } : previous?.nativeThreadHash ? { nativeThreadHash: previous.nativeThreadHash } : {}),
      ...(identity.nativeTurnId ? { nativeTurnHash: hash(identity.nativeTurnId) } : previous?.nativeTurnHash ? { nativeTurnHash: previous.nativeTurnHash } : {}),
      ...(identity.conversationKey ? { conversationHash: hash(identity.conversationKey) } : previous?.conversationHash ? { conversationHash: previous.conversationHash } : {}),
      multipartLastSentStage: state === "sent" ? stageIndex : lastSent,
      ...(state === "acknowledged"
        ? { multipartLastAcknowledgedStage: stageIndex }
        : lastAcknowledged > 0 ? { multipartLastAcknowledgedStage: lastAcknowledged } : {}),
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
      ...(previous?.multipartLastSentStage ? { multipartLastSentStage: previous.multipartLastSentStage } : {}),
      ...(previous?.multipartLastAcknowledgedStage ? { multipartLastAcknowledgedStage: previous.multipartLastAcknowledgedStage } : {}),
      ...(previous?.outstandingToolCallHashes ? { outstandingToolCallHashes: [...previous.outstandingToolCallHashes] } : {}),
      ...(previous?.eventChainHash ? { eventChainHash: previous.eventChainHash } : {}),
      ...(previous?.responseHash ? { responseHash: previous.responseHash } : {}),
      ...(previous?.errorCode ? { errorCode: previous.errorCode } : {}),
    };
    this.entries.delete(key);
    this.entries.set(key, checkpoint);
    this.prune();
    // A submission for a preempted execution key is the client's replay of the compacted turn:
    // the execution-key dedup proves the re-drive targets exactly the preempted request.
    const preemptedMarker = this.preemptions.get(key);
    if (preemptedMarker && preemptedMarker.phase === "preempted" && preemptedMarker.resolvedAt === undefined) {
      this.preemptions.delete(key);
      this.preemptions.set(key, { ...preemptedMarker, phase: "replaying", updatedAt: this.now() });
      emitChatGptWebStructuredTrace("compaction_replay_started", {
        executionKeyHash: key,
        sourceTraceId: preemptedMarker.traceId,
        replayTraceId: identity.traceId,
      });
    }
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
    const key = hash(executionKey);
    const checkpoint = this.entries.get(key);
    if (!checkpoint) return;
    checkpoint.completion = completion;
    checkpoint.updatedAt = this.now();
    checkpoint.outstandingToolCallHashes = [];
    if (options.response !== undefined) checkpoint.responseHash = hash(options.response);
    if (options.errorCode) checkpoint.errorCode = options.errorCode.slice(0, 128);
    this.resolvePreemptionOnTerminal(key, checkpoint);
    this.prune();
    this.persist();
  }

  /** Terminal journal states resolve durable compaction-preemption markers for the same
   *  execution key (the dedup-proven replay) or — on a final answer — for any preempted turn
   *  that shared the same native thread. Until one of those lands, the marker stays. */
  private resolvePreemptionOnTerminal(key: string, checkpoint: ChatGptTurnJournalCheckpoint): void {
    if (checkpoint.completion === "running") return;
    const marker = this.preemptions.get(key);
    if (marker && marker.resolvedAt === undefined) {
      if (checkpoint.completion === "final") {
        this.resolvePreemption(marker, "replay_completed");
        return;
      }
      if (checkpoint.completion === "cancelled") {
        this.resolvePreemption(marker, "cancelled");
        return;
      }
      if (marker.phase === "replaying") {
        // A replay attempt failed terminally: re-arm the durable marker so the unresolved
        // preemption stays visible instead of degrading into a silent lost result.
        this.preemptions.set(key, { ...marker, phase: "preempted", updatedAt: this.now() });
        return;
      }
      // An error terminal on the source's own preemption settlement leaves the marker
      // unresolved on purpose: the result is still formally undelivered.
      return;
    }
    if (checkpoint.completion === "final" && checkpoint.nativeThreadHash) {
      for (const marker of this.preemptions.values()) {
        if (marker.resolvedAt === undefined && marker.executionKeyHash !== key
          && marker.nativeThreadHash === checkpoint.nativeThreadHash) {
          this.resolvePreemption(marker, "replay_completed");
        }
      }
    }
  }

  clear(executionKey: string): void {
    if (!this.path) return;
    this.load();
    const key = hash(executionKey);
    const marker = this.preemptions.get(key);
    if (marker && marker.resolvedAt === undefined) {
      // An explicit journal clear is an explicit cancellation of the preempted turn.
      this.preemptions.delete(key);
      this.preemptions.set(key, { ...marker, phase: "cancelled", resolvedAt: this.now(), updatedAt: this.now() });
      this.persist();
    }
    if (!this.entries.delete(key)) return;
    this.persist();
  }

  compactionPreemption(executionKey: string): ChatGptCompactionPreemptionMarker | undefined {
    if (!this.path) return undefined;
    this.load();
    const marker = this.preemptions.get(hash(executionKey));
    return marker ? { ...marker } : undefined;
  }

  recordCompactionPreemption(
    executionKey: string,
    info: {
      traceId: string;
      nativeThreadId?: string;
      pendingNativeExecutions: number;
      forced: boolean;
      blockedUncertain: boolean;
    },
  ): void {
    if (!this.path) return;
    this.load();
    const key = hash(executionKey);
    const now = this.now();
    const existing = this.preemptions.get(key);
    const marker: ChatGptCompactionPreemptionMarker = {
      executionKeyHash: key,
      traceId: info.traceId,
      phase: info.blockedUncertain ? "replay_blocked_uncertain" : "preempted",
      pendingNativeExecutions: info.pendingNativeExecutions,
      forced: info.forced,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(info.nativeThreadId ? { nativeThreadHash: hash(info.nativeThreadId) } : existing?.nativeThreadHash ? { nativeThreadHash: existing.nativeThreadHash } : {}),
      ...(info.blockedUncertain ? { resolvedAt: now } : existing?.resolvedAt ? { resolvedAt: existing.resolvedAt } : {}),
    };
    this.preemptions.delete(key);
    this.preemptions.set(key, marker);
    this.prunePreemptions();
    this.persist();
  }

  private resolvePreemption(
    marker: ChatGptCompactionPreemptionMarker,
    phase: ChatGptCompactionPreemptionPhase,
  ): void {
    const now = this.now();
    const resolved = { ...marker, phase, resolvedAt: now, updatedAt: now };
    this.preemptions.set(marker.executionKeyHash, resolved);
    emitChatGptWebStructuredTrace("compaction_replay_completed", {
      executionKeyHash: marker.executionKeyHash,
      sourceTraceId: marker.traceId,
      resolution: phase,
      pendingNativeExecutions: marker.pendingNativeExecutions,
    });
    this.persist();
  }

  private prunePreemptions(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, marker] of this.preemptions) {
      if (marker.resolvedAt !== undefined && marker.updatedAt < cutoff) this.preemptions.delete(key);
    }
    while (this.preemptions.size > MAX_PREEMPTION_MARKERS) {
      let oldestResolvedKey: string | undefined;
      let oldestResolvedAt = Number.POSITIVE_INFINITY;
      for (const [key, marker] of this.preemptions) {
        if (marker.resolvedAt === undefined) continue;
        if (marker.resolvedAt < oldestResolvedAt) {
          oldestResolvedAt = marker.resolvedAt;
          oldestResolvedKey = key;
        }
      }
      if (!oldestResolvedKey) {
        throw new Error(
          `ChatGPT compaction preemption marker capacity exhausted (${MAX_PREEMPTION_MARKERS} unresolved); manual recovery or explicit clearing is required`,
        );
      }
      this.preemptions.delete(oldestResolvedKey);
    }
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (!this.path || !existsSync(this.path)) {
        this.loaded = true;
        return;
      }
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
      if (parsed.preemptions !== undefined) {
        if (typeof parsed.preemptions !== "object" || Array.isArray(parsed.preemptions)) {
          throw new Error(`Invalid ChatGPT turn journal preemptions: ${this.path}`);
        }
        for (const [key, value] of Object.entries(parsed.preemptions)) {
          if (!SHA256_RE.test(key)) throw new Error(`Invalid ChatGPT compaction preemption key: ${this.path}`);
          this.preemptions.set(key, validatePreemptionMarker(key, value));
        }
      }
      // Only a fully validated load marks the journal as loaded: a corrupt file must keep
      // failing closed on every contact instead of being silently overwritten by a persist.
      this.loaded = true;
    } catch (error) {
      throw criticalStoreLoadFailure("TurnJournal", this.path, error);
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    this.prunePreemptions();
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
      preemptions: this.preemptions.size > 0 ? Object.fromEntries(this.preemptions) : undefined,
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
