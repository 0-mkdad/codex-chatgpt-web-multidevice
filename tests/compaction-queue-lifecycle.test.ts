import { expect, spyOn, test } from "bun:test";
import {
  ChatGptBrowserWorker,
  MAX_CHATGPT_BROWSER_TABS,
} from "../src/adapters/chatgpt-web/browser-worker";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  DEFAULT_MAX_COMPACTION_QUEUE_WAIT_MS,
  MAX_COMPACTION_EXECUTION_STALL_MS,
  MAX_CONSECUTIVE_COMPACTION_ADMISSIONS,
  resolveChatGptCompactionQueueWaitTimeoutMs,
} from "../src/adapters/chatgpt-web/concurrency";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";

/**
 * 6.1.10 compaction queue lifecycle regression suite.
 *
 * The live 4-agent stress incident proved that the 300s compaction settlement deadline was armed
 * BEFORE browser-slot admission: under queue saturation the queued compaction timed out without
 * any browser submission, MCP transport, or generation, and Codex's retries re-entered the back
 * of the same FIFO queue. These tests pin the separated lifecycle:
 * queue waiting (priority + dedicated budget) is independent of post-admission execution.
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
  abortSignal?: AbortSignal;
  onSlotGranted?: () => void | Promise<void>;
}): BrowserTurn {
  return {
    traceId: options.traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ text: options.traceId, images: [], release() {} }),
    onTextDelta() {},
    ...(options.compaction ? { compaction: true } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.onSlotGranted ? { onSlotGranted: options.onSlotGranted } : {}),
  } as BrowserTurn;
}

function traceLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX)) lines.push(line);
  });
  return { lines, restore: () => info.mockRestore() };
}

function traceEvents(lines: string[]): Array<{ event: string; detail: Record<string, unknown> }> {
  return lines.map(line => JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as { event: string; detail: Record<string, unknown> });
}

test("compaction lifecycle constants keep queue wait and execution budgets separate", () => {
  expect(MAX_COMPACTION_EXECUTION_STALL_MS).toBe(5 * 60_000);
  expect(DEFAULT_MAX_COMPACTION_QUEUE_WAIT_MS).toBeGreaterThan(MAX_COMPACTION_EXECUTION_STALL_MS);
  expect(MAX_CONSECUTIVE_COMPACTION_ADMISSIONS).toBeGreaterThanOrEqual(1);
  expect(resolveChatGptCompactionQueueWaitTimeoutMs(undefined)).toBe(DEFAULT_MAX_COMPACTION_QUEUE_WAIT_MS);
  expect(resolveChatGptCompactionQueueWaitTimeoutMs("45000")).toBe(45_000);
  expect(() => resolveChatGptCompactionQueueWaitTimeoutMs("nope")).toThrow("CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS");
});

test("a queued compaction survives far beyond the 300s execution budget without cancellation", async () => {
  // §51 incident preconditions: operationalLimit=2, two long ordinary turns hold both slots,
  // a compaction enters the queue BEHIND an ordinary turn. The old build armed the settlement
  // deadline pre-queue and killed the compaction at 300s with zero browser work.
  const { worker, starts, releases, queuedTraceIds } = stubWorker({ operationalLimit: 2 });
  const ordinaryA = worker.run(turn({ traceId: "ordinary_A" }));
  const ordinaryB = worker.run(turn({ traceId: "ordinary_B" }));
  await Bun.sleep(5);
  expect(starts).toEqual(["ordinary_A", "ordinary_B"]);

  const slotGranted: string[] = [];
  const ordinaryD = worker.run(turn({ traceId: "ordinary_D" }));
  const queuedCompaction = worker.run(turn({
    traceId: "compact_C",
    compaction: true,
    onSlotGranted: () => { slotGranted.push("compact_C"); },
  }));

  // Simulated >300s queue wait (Bun.sleep stands in for the fake clock; the 60-minute queue
  // budget cannot elapse): no cancellation, no compaction_queue_timeout, entry stays queued.
  await Bun.sleep(20);
  expect(starts).toEqual(["ordinary_A", "ordinary_B"]);
  expect(queuedTraceIds()).toEqual(["ordinary_D", "compact_C"]);

  // Releasing one slot admits the COMPACTION next — priority over the older ordinary turn.
  releases.get("ordinary_A")?.();
  await Bun.sleep(10);
  expect(starts).toEqual(["ordinary_A", "ordinary_B", "compact_C"]);
  expect(slotGranted).toEqual(["compact_C"]);
  expect(queuedTraceIds()).toEqual(["ordinary_D"]);

  releases.get("compact_C")?.();
  releases.get("ordinary_B")?.();
  await Bun.sleep(10);
  expect(starts).toEqual(["ordinary_A", "ordinary_B", "compact_C", "ordinary_D"]);
  releases.get("ordinary_D")?.();
  await Promise.all([ordinaryA, ordinaryB, ordinaryD, queuedCompaction]);
});

test("queue-wait budget expiry fails the compaction with the typed queue timeout, before any browser work", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS;
  process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS = "15";
  try {
    const { worker, starts } = stubWorker({ operationalLimit: 1 });
    worker.run(turn({ traceId: "occupying_turn" }));
    await Bun.sleep(5);
    const queueTimerPromise = worker.run(turn({
      traceId: "compact_expires",
      compaction: true,
      onSlotGranted: () => { throw new Error("compaction must never be admitted in this test"); },
    }));
    await expect(queueTimerPromise).rejects.toMatchObject({
      code: "compaction_queue_timeout",
      status: 409,
      retryable: false,
      message: expect.stringContaining("waited too long for browser capacity"),
    });
    expect(starts).toEqual(["occupying_turn"]);
    expect((worker as unknown as { pendingRuns: unknown[] }).pendingRuns).toHaveLength(0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS;
    else process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS = previous;
  }
});

test("queue timeout, execution timeout, and handoff timeout are distinct typed phases", async () => {
  const previous = process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS;
  process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS = "10";
  try {
    const { worker } = stubWorker({ operationalLimit: 1 });
    worker.run(turn({ traceId: "occupying_turn" }));
    await Bun.sleep(5);
    const rejected = worker.run(turn({ traceId: "compact_q", compaction: true }));
    await expect(rejected).rejects.toMatchObject({ code: "compaction_queue_timeout" });
    await expect(rejected).rejects.not.toMatchObject({ code: "compaction_execution_timeout" });
    await expect(rejected).rejects.not.toMatchObject({ code: "compaction_handoff_timeout" });
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS;
    else process.env.CODEX_CHATGPT_WEB_COMPACTION_QUEUE_TIMEOUT_MS = previous;
  }
});

test("a queued compaction is admitted before older ordinary work, at concurrency 1", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
  const running = worker.run(turn({ traceId: "ordinary_A" }));
  await Bun.sleep(5);
  worker.run(turn({ traceId: "ordinary_C" }));
  const granted: string[] = [];
  worker.run(turn({ traceId: "compact_B", compaction: true, onSlotGranted: () => { granted.push("B"); } }));
  await Bun.sleep(5);
  expect(starts).toEqual(["ordinary_A"]);

  releases.get("ordinary_A")?.();
  await running;
  await Bun.sleep(10);
  // §29: B receives admission according to compaction priority; C must not jump ahead.
  expect(starts).toEqual(["ordinary_A", "compact_B"]);
  expect(granted).toEqual(["B"]);

  releases.get("compact_B")?.();
  await Bun.sleep(10);
  expect(starts).toEqual(["ordinary_A", "compact_B", "ordinary_C"]);
});

test("bounded fairness admits ordinary work after the configured consecutive compaction admissions", async () => {
  const { worker, starts, releases, queuedTraceIds } = stubWorker({ operationalLimit: 2 });
  worker.run(turn({ traceId: "compact_C1", compaction: true }));
  worker.run(turn({ traceId: "compact_C2", compaction: true }));
  const ordinaryWaiting = worker.run(turn({ traceId: "ordinary_O1" }));
  worker.run(turn({ traceId: "compact_C3", compaction: true }));
  await Bun.sleep(5);
  // Two consecutive compaction admissions fill both slots; O1 stays queued behind them.
  expect(starts).toEqual(["compact_C1", "compact_C2"]);
  expect(queuedTraceIds()).toEqual(["ordinary_O1", "compact_C3"]);

  releases.get("compact_C1")?.();
  await Bun.sleep(10);
  // After MAX_CONSECUTIVE_COMPACTION_ADMISSIONS consecutive compaction admissions, the waiting
  // ordinary turn wins the next slot; the remaining compaction follows without starving.
  expect(starts).toEqual(["compact_C1", "compact_C2", "ordinary_O1"]);
  expect(queuedTraceIds()).toEqual(["compact_C3"]);

  releases.get("compact_C2")?.();
  await Bun.sleep(10);
  expect(starts).toEqual(["compact_C1", "compact_C2", "ordinary_O1", "compact_C3"]);
  releases.get("ordinary_O1")?.();
  releases.get("compact_C3")?.();
  await Promise.all([ordinaryWaiting]).catch(() => {});
});

test("priority selection never exceeds the operational limit or the physical tab ceiling", async () => {
  expect(MAX_CHATGPT_BROWSER_TABS).toBeGreaterThanOrEqual(1);
  const { worker, starts, releases } = stubWorker({ operationalLimit: 1 });
  const a = worker.run(turn({ traceId: "a" }));
  await Bun.sleep(5);
  worker.run(turn({ traceId: "compact_b", compaction: true }));
  worker.run(turn({ traceId: "c" }));
  await Bun.sleep(5);
  expect(starts).toEqual(["a"]);
  expect((worker as unknown as { runningRuns: number }).runningRuns).toBe(1);
  releases.get("a")?.();
  await Bun.sleep(10);
  expect(starts).toEqual(["a", "compact_b"]);
  releases.get("compact_b")?.();
  await Bun.sleep(10);
  expect(starts).toEqual(["a", "compact_b", "c"]);
});

test("equivalent compaction retries collapse onto one queue entry with preserved position", async () => {
  const { worker, starts, releases, queuedTraceIds } = stubWorker({ operationalLimit: 1 });
  const running = worker.run(turn({ traceId: "ordinary_A" }));
  await Bun.sleep(5);
  // One logical compaction; Codex retries surface as repeat submissions of the same identity.
  const first = worker.run(turn({ traceId: "compact_C", compaction: true }));
  await expect(worker.run(turn({ traceId: "compact_C", compaction: true })))
    .rejects.toThrow("Duplicate ChatGPT web browser turn: compact_C");
  await expect(worker.run(turn({ traceId: "compact_C", compaction: true })))
    .rejects.toThrow("Duplicate ChatGPT web browser turn: compact_C");
  expect(queuedTraceIds().filter(traceId => traceId === "compact_C")).toHaveLength(1);
  expect(queuedTraceIds()).toEqual(["compact_C"]);

  releases.get("ordinary_A")?.();
  await running;
  await Bun.sleep(10);
  expect(starts).toEqual(["ordinary_A", "compact_C"]);
  expect(starts.filter(traceId => traceId === "compact_C")).toHaveLength(1);
  releases.get("compact_C")?.();
  await expect(first).resolves.toBe("compact_C");
});

test("multiple independent compactions stay isolated and each reaches exactly one admission", async () => {
  const { worker, starts, releases } = stubWorker({ operationalLimit: 2 });
  const granted: string[] = [];
  worker.run(turn({ traceId: "compact_agent1", compaction: true, onSlotGranted: () => { granted.push("agent1"); } }));
  worker.run(turn({ traceId: "compact_agent2", compaction: true, onSlotGranted: () => { granted.push("agent2"); } }));
  await Bun.sleep(5);
  expect(starts).toEqual(["compact_agent1", "compact_agent2"]);
  expect(granted).toEqual(["agent1", "agent2"]);
  releases.get("compact_agent1")?.();
  releases.get("compact_agent2")?.();
  await Bun.sleep(5);
});

test("authoritative abort removes a queued compaction without a queue timeout event", async () => {
  const { worker, queuedTraceIds } = stubWorker({ operationalLimit: 1 });
  worker.run(turn({ traceId: "occupying" }));
  await Bun.sleep(5);
  const controller = new AbortController();
  const queued = worker.run(turn({
    traceId: "compact_cancelled",
    compaction: true,
    abortSignal: controller.signal,
  }));
  await Bun.sleep(5);
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  expect(queuedTraceIds()).not.toContain("compact_cancelled");
});

test("queue telemetry is metadata-only and reconstructs the compaction lifecycle", async () => {
  const { lines, restore } = traceLines();
  try {
    const { worker, starts, releases } = stubWorker({ operationalLimit: 2 });
    worker.run(turn({ traceId: "ordinary_A" }));
    worker.run(turn({ traceId: "ordinary_B" }));
    await Bun.sleep(5);
    worker.run(turn({ traceId: "compact_C", compaction: true }));
    await Bun.sleep(5);
    expect(starts).toEqual(["ordinary_A", "ordinary_B"]);

    releases.get("ordinary_A")?.();
    await Bun.sleep(10);

    const events = traceEvents(lines);
    const entered = events.find(event => event.event === "compaction_queue_entered");
    const granted = events.find(event => event.event === "compaction_slot_granted");
    expect(entered).toBeDefined();
    expect(entered!.detail).toMatchObject({
      traceId: "compact_C",
      priorityClass: "compaction",
      activeSlotCount: 2,
      queueWaitBudgetMs: DEFAULT_MAX_COMPACTION_QUEUE_WAIT_MS,
    });
    expect(granted).toBeDefined();
    expect(granted!.detail).toMatchObject({
      traceId: "compact_C",
      executionDeadlineMs: MAX_COMPACTION_EXECUTION_STALL_MS,
    });
    expect(typeof granted!.detail.queueWaitMs).toBe("number");
    // §58: no payload leakage — only identities, counters, and durations are recorded.
    const serialized = JSON.stringify(events);
    for (const forbidden of ["prompt", "summary", "cookie", "authorization", "content"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  } finally {
    restore();
  }
});
