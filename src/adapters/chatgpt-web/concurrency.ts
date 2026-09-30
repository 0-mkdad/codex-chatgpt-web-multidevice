/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

/**
 * Pending logical turns are cheaper than physical ChatGPT tabs, but they still retain request,
 * cancellation, and replay state. Keep the queue bounded well below the 256-entry session registry
 * while allowing ordinary main-task + subagent fan-out to wait safely for physical capacity.
 */
export const MAX_CHATGPT_LOGICAL_PENDING_TURNS = 64;

/** Retained logical sessions, including terminal replay state. */
export const MAX_CHATGPT_TURN_SESSIONS = 256;

export type ChatGptOperationalConcurrencyMode = "safe" | "balanced" | "aggressive" | "maximum";

export const DEFAULT_CHATGPT_OPERATIONAL_CONCURRENCY = 5;

const CHATGPT_OPERATIONAL_CONCURRENCY_BY_MODE: Record<ChatGptOperationalConcurrencyMode, number> = {
  safe: 1,
  balanced: 2,
  aggressive: 3,
  maximum: MAX_CHATGPT_BROWSER_TABS,
};

/**
 * Reliability-oriented concurrency below the hard browser-tab ceiling. The environment value is
 * intentionally internal so existing public provider configuration and protocol shapes stay
 * compatible. Named modes are preferred; integers 1..5 are accepted for diagnostics/experiments.
 */
export function resolveChatGptOperationalConcurrency(
  configured = process.env.CODEX_CHATGPT_WEB_CONCURRENCY_MODE,
): number {
  const normalized = configured?.trim().toLowerCase();
  if (!normalized) return DEFAULT_CHATGPT_OPERATIONAL_CONCURRENCY;
  if (normalized in CHATGPT_OPERATIONAL_CONCURRENCY_BY_MODE) {
    return CHATGPT_OPERATIONAL_CONCURRENCY_BY_MODE[normalized as ChatGptOperationalConcurrencyMode];
  }
  const numeric = Number(normalized);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= MAX_CHATGPT_BROWSER_TABS) {
    return numeric;
  }
  throw new Error(
    `CODEX_CHATGPT_WEB_CONCURRENCY_MODE must be safe, balanced, aggressive, maximum, or 1-${MAX_CHATGPT_BROWSER_TABS}`,
  );
}

/**
 * Execution/settlement budget for an ADMITTED compaction: the maximum allowed time without
 * meaningful progress after a browser slot has been granted. This must never measure the time
 * spent waiting in the logical browser queue — a queued compaction has not begun executing, so
 * queue capacity waits cannot consume this budget.
 */
export const MAX_COMPACTION_EXECUTION_STALL_MS = 5 * 60_000;

/**
 * Queue-wait policy for compaction turns, deliberately separate from the execution budget above.
 *
 * Default rationale: the live 4-agent stress incident showed legitimate queue waits of 28-32
 * minutes for ordinary turns, and single ordinary turns can legitimately run ~45 minutes. With
 * priority admission a queued compaction waits at most the remaining runtime of the turns that
 * already hold every slot, so the default is set above the largest observed legitimate wait with
 * headroom (2x a 30-minute wait). It is not the execution budget: expiry fails the operation with
 * a dedicated typed error instead of the misleading settlement timeout.
 */
export const DEFAULT_MAX_COMPACTION_QUEUE_WAIT_MS = 60 * 60_000;

/**
 * Bounded fairness for compaction priority: after this many consecutive compaction admissions,
 * the next admitted turn is the oldest waiting ordinary turn. Prevents a stream of compactions
 * from starving ordinary queued work while still letting context-blocked agents resume first.
 */
export const MAX_CONSECUTIVE_COMPACTION_ADMISSIONS = 2;

/**
 * Bounded fairness for continuation priority (interrupt-steered children, post-compaction
 * resumes): after this many consecutive continuation admissions, the next admitted turn is the
 * oldest waiting ordinary turn, mirroring the compaction cap. A steered child must reclaim
 * admission instead of starving at the FIFO tail behind turns enqueued after it, but a stream of
 * steered children must not starve fresh work either.
 */
export const MAX_CONSECUTIVE_CONTINUATION_ADMISSIONS = 2;

/**
 * Resolve the compaction queue-wait budget. Environment override is internal, mirroring
 * CODEX_CHATGPT_WEB_CONCURRENCY_MODE, so tests and diagnostics can shrink the bound without
 * touching the production default.
 */
export function resolveChatGptCompactionQueueWaitTimeoutMs(
  configured = process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS,
): number {
  const normalized = configured?.trim();
  if (!normalized) return DEFAULT_MAX_COMPACTION_QUEUE_WAIT_MS;
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS must be a positive integer number of milliseconds");
  }
  return value;
}
