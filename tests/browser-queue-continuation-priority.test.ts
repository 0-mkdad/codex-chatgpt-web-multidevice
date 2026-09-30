import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { MAX_CONSECUTIVE_CONTINUATION_ADMISSIONS } from "../src/adapters/chatgpt-web/concurrency";
import {
  CHATGPT_CONTINUATION_CREDIT_REASONS,
  clearChatGptContinuationCredits,
  grantChatGptContinuationCredit,
  peekChatGptContinuationCredit,
  takeChatGptContinuationCredit,
} from "../src/adapters/chatgpt-web/continuation-credits";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";

/**
 * 2026-09-29 multi-agent incident regressions (live-run proven):
 *
 * 1. A compaction enqueued while an admission gate (rate-limit attempt reservation) was in
 *    flight lost the grant at gate settle: the gated turn was spliced and granted
 *    unconditionally, so the compaction waited 641,496ms for the NEXT released slot while the
 *    parent thread stayed dead. Priority must be decided at GRANT time, not gate-entry time.
 * 2. A send_input steer aborts the target child's live generation by design, but the child's
 *    follow-up turn re-entered the queue at the FIFO TAIL and starved 34 minutes behind turns
 *    enqueued minutes after it. Continuation-class admission (bounded, like compaction) fixes
 *    the re-entry without letting a steer storm starve fresh work.
 */

function stubWorker(options: {
  operationalLimit: number;
  configuredLimit?: number;
} = { operationalLimit: 2 }) {
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map<string, Promise<string>>(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    consecutiveCompactionAdmissions: 0,
    consecutiveContinuationAdmissions: 0,
    operationalConcurrencyLimit: () => options.operationalLimit,
    configuredOperationalConcurrencyLimit: () => options.configuredLimit ?? options.operationalLimit,
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      starts.push(turn.traceId);
      releases.set(turn.traceId, () => resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  return {
    worker,
    starts,
    releases,
    queuedTraceIds: () => (worker as unknown as { pendingRuns: Array<{ turn: { traceId: string } }> })
      .pendingRuns.map(entry => entry.turn.traceId),
  };
}

function turn(options: {
  traceId: string;
  compaction?: boolean;
  continuation?: boolean;
  beforePhysicalSubmission?: () => Promise<void>;
  onSlotGranted?: () => void | Promise<void>;
}): BrowserTurn {
  return {
    traceId: options.traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ text: options.traceId, images: [], release() {} }),
    onTextDelta() {},
    ...(options.compaction ? { compaction: true } : {}),
    ...(options.continuation ? { continuation: true } : {}),
    ...(options.beforePhysicalSubmission ? { beforePhysicalSubmission: options.beforePhysicalSubmission } : {}),
    ...(options.onSlotGranted ? { onSlotGranted: options.onSlotGranted } : {}),
  } as BrowserTurn;
}

function traceEvents(): { events: () => Array<{ event: string; detail: Record<string, unknown> }>; restore: () => void } {
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX)) lines.push(line);
  });
  return {
    events: () => lines.map(line => JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as { event: string; detail: Record<string, unknown> }),
    restore: () => info.mockRestore(),
  };
}

test("a compaction enqueued while an admission gate is in flight wins the slot at gate settle", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 2 });
  let releaseGate!: () => void;
  let gateRuns = 0;
  void worker.run(turn({ traceId: "runner_A" }));
  const gated = worker.run(turn({
    traceId: "gated_child",
    beforePhysicalSubmission: () => new Promise<void>(resolve => {
      gateRuns += 1;
      releaseGate = resolve;
    }),
  }));
  await Bun.sleep(5);
  expect(starts).toEqual(["runner_A"]);

  // The gated turn is now INSIDE the in-flight admission. Enqueue the compaction now — exactly
  // the live ordering (slot released 18:58:59.328, compaction entered .333, gate settled .446).
  void worker.run(turn({ traceId: "compact_C", compaction: true }));
  await Bun.sleep(5);
  expect(starts).toEqual(["runner_A"]);
  releaseGate();
  await Bun.sleep(15);

  expect(starts).toEqual(["runner_A", "compact_C"]);
  expect(gateRuns).toBe(1);

  releases.get("runner_A")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["runner_A", "compact_C", "gated_child"]);
  releases.get("compact_C")?.();
  releases.get("gated_child")?.();
  await gated;
});

test("an ordinary turn enqueued during the gate does NOT steal the gated turn's grant (FIFO within class)", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 2 });
  let releaseGate!: () => void;
  void worker.run(turn({ traceId: "runner_A" }));
  const gated = worker.run(turn({
    traceId: "gated_child",
    beforePhysicalSubmission: () => new Promise<void>(resolve => { releaseGate = resolve; }),
  }));
  await Bun.sleep(5);
  void worker.run(turn({ traceId: "later_ordinary" }));
  await Bun.sleep(5);
  releaseGate();
  await Bun.sleep(15);
  expect(starts).toEqual(["runner_A", "gated_child"]);
  releases.get("runner_A")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["runner_A", "gated_child", "later_ordinary"]);
  releases.get("gated_child")?.();
  releases.get("later_ordinary")?.();
  await gated;
});

test("a continuation turn is admitted before older ordinary work at concurrency 1", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
  void worker.run(turn({ traceId: "old_running" }));
  void worker.run(turn({ traceId: "old_queued" }));
  const steered = worker.run(turn({ traceId: "steered_resume", continuation: true }));
  await Bun.sleep(5);
  releases.get("old_running")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["old_running", "steered_resume"]);
  releases.get("steered_resume")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["old_running", "steered_resume", "old_queued"]);
  releases.get("old_queued")?.();
  await steered;
});

test("a pending compaction still outranks a continuation turn", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
  void worker.run(turn({ traceId: "old_running" }));
  void worker.run(turn({ traceId: "compact_C", compaction: true }));
  const steered = worker.run(turn({ traceId: "steered_resume", continuation: true }));
  await Bun.sleep(5);
  releases.get("old_running")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["old_running", "compact_C"]);
  releases.get("compact_C")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["old_running", "compact_C", "steered_resume"]);
  releases.get("steered_resume")?.();
  await steered;
});

test(`after ${MAX_CONSECUTIVE_CONTINUATION_ADMISSIONS} consecutive continuation admissions the oldest ordinary turn runs`, async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
  void worker.run(turn({ traceId: "hold" }));
  void worker.run(turn({ traceId: "cont_1", continuation: true }));
  void worker.run(turn({ traceId: "cont_2", continuation: true }));
  void worker.run(turn({ traceId: "cont_3", continuation: true }));
  void worker.run(turn({ traceId: "fresh_ordinary" }));
  await Bun.sleep(5);
  releases.get("hold")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["hold", "cont_1"]);
  releases.get("cont_1")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["hold", "cont_1", "cont_2"]);
  releases.get("cont_2")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["hold", "cont_1", "cont_2", "fresh_ordinary"]);
  releases.get("fresh_ordinary")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["hold", "cont_1", "cont_2", "fresh_ordinary", "cont_3"]);
});

test("ordinary-only queues stay strictly FIFO", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
  void worker.run(turn({ traceId: "a" }));
  void worker.run(turn({ traceId: "b" }));
  void worker.run(turn({ traceId: "c" }));
  await Bun.sleep(5);
  releases.get("a")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["a", "b"]);
  releases.get("b")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["a", "b", "c"]);
});

test("parent + 4 ordinary subagents all run together at the default 5-slot capacity; a sixth waits", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 5, configuredLimit: 5 });
  void worker.run(turn({ traceId: "parent" }));
  void worker.run(turn({ traceId: "child_a" }));
  void worker.run(turn({ traceId: "child_b" }));
  void worker.run(turn({ traceId: "child_c" }));
  void worker.run(turn({ traceId: "child_d" }));
  await Bun.sleep(5);
  // All five ordinary turns are admitted immediately: no child waits while a slot is free.
  expect(starts).toEqual(["parent", "child_a", "child_b", "child_c", "child_d"]);
  // A sixth turn must stay queued until a slot frees, proving the ceiling is the limit itself (5).
  void worker.run(turn({ traceId: "latecomer" }));
  await Bun.sleep(5);
  expect(starts).toEqual(["parent", "child_a", "child_b", "child_c", "child_d"]);
  releases.get("parent")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["parent", "child_a", "child_b", "child_c", "child_d", "latecomer"]);
  releases.get("child_a")?.();
  releases.get("child_b")?.();
  releases.get("child_c")?.();
  releases.get("child_d")?.();
  releases.get("latecomer")?.();
  await Bun.sleep(15);
});

test("queue and slot telemetry carry the priority class", async () => {
  const trace = traceEvents();
  try {
    const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
    void worker.run(turn({ traceId: "held" }));
    void worker.run(turn({ traceId: "cont", continuation: true }));
    await Bun.sleep(5);
    releases.get("held")?.();
    await Bun.sleep(15);
    expect(starts).toEqual(["held", "cont"]);
    const events = trace.events();
    const queuedCont = events.find(event => event.event === "continuation_slot_granted");
    expect(queuedCont).toBeDefined();
    expect(queuedCont!.detail.traceId).toBe("cont");
  } finally {
    trace.restore();
  }
});

test("continuation credits are one-shot, TTL-bounded, and thread-scoped", () => {
  clearChatGptContinuationCredits();
  expect(grantChatGptContinuationCredit("", CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer)).toBe(false);
  expect(grantChatGptContinuationCredit("thread-A", CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer, 1_000)).toBe(true);
  expect(peekChatGptContinuationCredit("thread-A", 1_000)).toBe(true);
  expect(peekChatGptContinuationCredit("thread-B", 1_000)).toBe(false);

  // A different thread must not consume A's credit.
  expect(takeChatGptContinuationCredit("thread-B", 1_050)).toBeUndefined();
  expect(peekChatGptContinuationCredit("thread-A", 1_050)).toBe(true);

  // One-shot: the first take consumes it, the second gets nothing.
  expect(takeChatGptContinuationCredit("thread-A", 1_100)).toEqual({
    reason: CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer,
    ageMs: 100,
  });
  expect(takeChatGptContinuationCredit("thread-A", 1_150)).toBeUndefined();
  expect(peekChatGptContinuationCredit("thread-A", 1_150)).toBe(false);

  // TTL: an expired credit is not handed out (and taking it still consumes it).
  grantChatGptContinuationCredit("thread-C", CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff, 5_000);
  expect(peekChatGptContinuationCredit("thread-C", 5_000 + 120_001)).toBe(false);
  expect(takeChatGptContinuationCredit("thread-C", 5_000 + 120_001)).toBeUndefined();
  expect(takeChatGptContinuationCredit("thread-C", 5_000 + 120_002)).toBeUndefined();

  // A refreshed credit wins over expiry.
  grantChatGptContinuationCredit("thread-D", CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer, 10_000);
  grantChatGptContinuationCredit("thread-D", CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff, 11_000);
  expect(takeChatGptContinuationCredit("thread-D", 11_500)).toEqual({
    reason: CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff,
    ageMs: 500,
  });
  clearChatGptContinuationCredits();
});
