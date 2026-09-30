import { chatGptCompactionPreemptedError, chatGptExecutionOutcomeUncertainError } from "./adapter-error";
import { emitChatGptWebStructuredTrace } from "./structured-trace";

/**
 * Bounded safe-boundary preemption for fresh-conversation compaction.
 *
 * Fresh-conversation compaction must release the unfinished browser/tool owner of the source
 * execution key before rebuilding it. Releasing an owner mid-tool-execution loses its in-flight
 * result (proven live on 2026-09-30: a nine-minute child investigation was aborted by an
 * AbortError and never delivered). Instead of an immediate abort, the preemption waits a short
 * bounded grace for the owner to reach a safe boundary — no undecided native/tool execution —
 * or to settle final on its own. Only when the grace expires with undecided native work does it
 * force the retirement, and then with a typed, fail-closed outcome so the replay can never
 * duplicate native side effects blindly.
 *
 * This intentionally does not change queue priority, concurrency, or the scheduler: the
 * retirement itself stays exactly `retireAndWait` on the same execution key.
 */

export const COMPACTION_PREEMPTION_GRACE_MS = 5_000;
export const COMPACTION_PREEMPTION_POLL_MS = 100;

export interface CompactionPreemptionMarkerInput {
  traceId: string;
  nativeThreadId?: string;
  pendingNativeExecutions: number;
  forced: boolean;
  blockedUncertain: boolean;
}

export interface CompactionPreemptionJournal {
  recordCompactionPreemption(executionKey: string, marker: CompactionPreemptionMarkerInput): void;
}

/** Structural subset of ChatGptTurnSession the preemption relies on; kept narrow for tests. */
export interface CompactionPreemptionSourceSession {
  traceId?: string;
  nativeThreadId?: string;
  physicalSettlement: Promise<void>;
  outstanding(): unknown[];
  settledOutcome(): { type: "final" | "error"; error?: unknown } | undefined;
}

export interface CompactionPreemptionSessions {
  find(key: string): CompactionPreemptionSourceSession | undefined;
  retireAndWait(key: string, signal?: AbortSignal, reason?: Error): Promise<boolean>;
}

export type CompactionPreemptionOutcome =
  | { kind: "absent"; settlement: Promise<void> }
  | { kind: "final-preserved"; settlement: Promise<void> }
  | { kind: "safe-boundary"; settlement: Promise<void> }
  | { kind: "forced"; uncertain: boolean; settlement: Promise<void> };

function delayWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("ChatGPT compaction preemption aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      cleanup();
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new DOMException("ChatGPT compaction preemption aborted", "AbortError"));
    };
    function finish() {
      cleanup();
      resolve();
    }
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function preemptCompactionSource(options: {
  sessions: CompactionPreemptionSessions;
  executionKey: string;
  compactionTraceId: string;
  operationSignal?: AbortSignal;
  graceMs?: number;
  pollMs?: number;
  journal?: CompactionPreemptionJournal;
}): Promise<CompactionPreemptionOutcome> {
  const { sessions, executionKey, compactionTraceId, operationSignal, journal } = options;
  const graceMs = options.graceMs ?? COMPACTION_PREEMPTION_GRACE_MS;
  const pollMs = options.pollMs ?? COMPACTION_PREEMPTION_POLL_MS;
  const previous = sessions.find(executionKey);
  if (!previous) return { kind: "absent", settlement: Promise.resolve() };
  if (previous.settledOutcome()?.type === "final") {
    // The source won the native compaction race: keep the committed final replayable.
    return { kind: "final-preserved", settlement: previous.physicalSettlement };
  }
  emitChatGptWebStructuredTrace("compaction_preemption_started", {
    compactionTraceId,
    sourceTraceId: previous.traceId,
    graceMs,
  });
  const deadline = Date.now() + graceMs;
  let boundary = false;
  let settledFinal = false;
  let settledError = false;
  while (Date.now() < deadline) {
    const outcome = previous.settledOutcome();
    if (outcome?.type === "final") {
      settledFinal = true;
      break;
    }
    if (outcome?.type === "error") {
      // The owner failed on its own; retirement is pure cleanup and the client already knows.
      settledError = true;
      boundary = true;
      break;
    }
    if (previous.outstanding().length === 0) {
      boundary = true;
      break;
    }
    await delayWithAbort(Math.max(0, Math.min(pollMs, deadline - Date.now())), operationSignal);
  }
  if (settledFinal) {
    emitChatGptWebStructuredTrace("compaction_preemption_safe_boundary", {
      compactionTraceId,
      sourceTraceId: previous.traceId,
      boundary: "final",
    });
    return { kind: "final-preserved", settlement: previous.physicalSettlement };
  }
  const pendingNativeExecutions = previous.outstanding().length;
  // An owner that settled (even with an error) has no client awaiting an in-flight result, so
  // its retirement can never lose undelivered work — only a still-active owner can.
  const uncertain = !settledError && (!boundary || pendingNativeExecutions > 0);
  if (!uncertain) {
    emitChatGptWebStructuredTrace("compaction_preemption_safe_boundary", {
      compactionTraceId,
      sourceTraceId: previous.traceId,
      boundary: settledError ? "settled_error" : "tool_boundary",
    });
  } else {
    emitChatGptWebStructuredTrace("compaction_preemption_forced", {
      compactionTraceId,
      sourceTraceId: previous.traceId,
      graceMs,
      pendingNativeExecutions,
    });
  }
  const reason = uncertain
    ? chatGptExecutionOutcomeUncertainError(pendingNativeExecutions)
    : chatGptCompactionPreemptedError();
  journal?.recordCompactionPreemption(executionKey, {
    traceId: previous.traceId ?? "",
    nativeThreadId: previous.nativeThreadId,
    pendingNativeExecutions,
    forced: uncertain,
    blockedUncertain: uncertain,
  });
  if (uncertain) {
    emitChatGptWebStructuredTrace("compaction_replay_blocked_uncertain", {
      compactionTraceId,
      sourceTraceId: previous.traceId,
      pendingNativeExecutions,
    });
  }
  const settlement = sessions.retireAndWait(executionKey, operationSignal, reason).then(() => {});
  return uncertain
    ? { kind: "forced", uncertain: true, settlement }
    : { kind: "safe-boundary", settlement };
}
