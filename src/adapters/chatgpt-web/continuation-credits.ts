/**
 * One-shot admission credits for continuation-class browser turns.
 *
 * Live evidence (2026-09-29 multi-agent incident): when native Codex steers a busy child via
 * send_input, the Codex Interrupt hook intentionally aborts the child's live browser generation;
 * the follow-up turn then re-entered the browser queue at the FIFO TAIL behind turns that were
 * enqueued minutes after the child started, and the steered child waited 34 minutes to resume.
 * The same FIFO-tail re-entry hit a parent thread right after its compaction handoff committed
 * (30+ minute parent blackout under queue saturation).
 *
 * A credit marks a thread whose NEXT model turn is a continuation of work that was already
 * running: the turn is admitted before ordinary work (bounded, like compaction — see
 * MAX_CONSECUTIVE_CONTINUATION_ADMISSIONS) instead of starving at the tail. Credits only reorder
 * WHO receives the next browser slot; they never bypass the operational limits, the physical tab
 * ceiling, or any submission-safety invariant.
 *
 * Credits are short-lived (TTL), bounded in count, keyed by native thread id, and consumed
 * exactly once by the turn construction that actually enqueues a browser turn for the thread.
 */

/** Long enough to cover the interrupt-hook deadline (~3s) plus request compilation; short enough that a stale credit can only boost one imminent turn. */
const CONTINUATION_CREDIT_TTL_MS = 120_000;

/** Hard bound so a pathological interrupt storm cannot grow the map unbounded. */
const MAX_CONTINUATION_CREDITS = 256;

export const CHATGPT_CONTINUATION_CREDIT_REASONS = {
  interruptSteer: "interrupt_steer",
  compactionHandoff: "compaction_handoff",
} as const;

export type ChatGptContinuationCreditReason =
  (typeof CHATGPT_CONTINUATION_CREDIT_REASONS)[keyof typeof CHATGPT_CONTINUATION_CREDIT_REASONS];

import { chatGptWebTraceHash, emitChatGptWebStructuredTrace } from "./structured-trace";

interface ContinuationCredit {
  reason: ChatGptContinuationCreditReason;
  grantedAt: number;
}

const credits = new Map<string, ContinuationCredit>();

/** Expiry is a starvation witness (native delay, queue pressure, compaction, 429): make it visible. */
function emitCreditExpired(
  threadId: string,
  credit: ContinuationCredit,
  ageMs: number,
  observed: "ttl_exceeded" | "clock_skew",
): void {
  emitChatGptWebStructuredTrace("continuation_credit_expired", {
    nativeThreadHash: chatGptWebTraceHash(threadId),
    reason: credit.reason,
    ageMs,
    ttlMs: CONTINUATION_CREDIT_TTL_MS,
    observed,
  }, "warning");
}

function normalizeThreadId(threadId: unknown): string {
  return typeof threadId === "string" ? threadId.trim() : "";
}

function pruneExpired(now: number): void {
  for (const [key, credit] of credits) {
    if (now - credit.grantedAt > CONTINUATION_CREDIT_TTL_MS) credits.delete(key);
  }
}

export function chatGptContinuationCreditTtlMs(): number {
  return CONTINUATION_CREDIT_TTL_MS;
}

/** Grant (or refresh) the one-shot continuation credit for a thread. Idempotent per thread. */
export function grantChatGptContinuationCredit(
  threadId: string,
  reason: ChatGptContinuationCreditReason,
  now = Date.now(),
): boolean {
  const key = normalizeThreadId(threadId);
  if (!key) return false;
  pruneExpired(now);
  if (!credits.has(key) && credits.size >= MAX_CONTINUATION_CREDITS) {
    // Evict the oldest credit; the newest evidence of interrupted progress is the most valuable.
    const oldestKey = credits.keys().next().value;
    if (oldestKey === undefined) return false;
    credits.delete(oldestKey);
  }
  credits.set(key, { reason, grantedAt: now });
  return true;
}

/**
 * Consume the thread's credit for the turn about to be enqueued. One-shot: the credit is removed
 * even when it turns out to be expired, so a stale credit can never accumulate.
 */
export function takeChatGptContinuationCredit(
  threadId: string,
  now = Date.now(),
): { reason: ChatGptContinuationCreditReason; ageMs: number } | undefined {
  const key = normalizeThreadId(threadId);
  if (!key) return undefined;
  const credit = credits.get(key);
  credits.delete(key);
  if (!credit) return undefined;
  const ageMs = now - credit.grantedAt;
  if (ageMs > CONTINUATION_CREDIT_TTL_MS) {
    emitCreditExpired(key, credit, ageMs, "ttl_exceeded");
    return undefined;
  }
  if (ageMs < 0) {
    emitCreditExpired(key, credit, ageMs, "clock_skew");
    return undefined;
  }
  return { reason: credit.reason, ageMs };
}

/** Diagnostics: does the thread currently hold a credit? Non-consuming. */
export function peekChatGptContinuationCredit(threadId: string, now = Date.now()): boolean {
  const key = normalizeThreadId(threadId);
  if (!key) return false;
  const credit = credits.get(key);
  if (!credit) return false;
  return now - credit.grantedAt <= CONTINUATION_CREDIT_TTL_MS;
}

/** Test/diagnostics hook: drop every credit. */
export function clearChatGptContinuationCredits(): void {
  credits.clear();
}
