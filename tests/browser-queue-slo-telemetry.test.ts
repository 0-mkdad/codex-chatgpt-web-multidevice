import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";

/**
 * v6.1.11 queue/capacity SLO telemetry regressions. Telemetry-only: none of these fields may
 * influence scheduling. They exist so operators can tell "stuck agent" apart from "capacity
 * saturation" (live session de90c3d579da, 2026-09-29: parent + one child held both slots while
 * two queued children were correctly waiting — previously invisible in the structured channel).
 */

function stubWorker(options: { operationalLimit: number } = { operationalLimit: 2 }) {
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
    configuredOperationalConcurrencyLimit: () => options.operationalLimit,
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      setTimeout(() => resolve(turn.traceId), 5);
    }),
  }) as ChatGptBrowserWorker;
  return worker;
}

function turn(traceId: string, extra: Partial<BrowserTurn> = {}): BrowserTurn {
  return {
    traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
    ...extra,
  } as BrowserTurn;
}

function capturedTraces() {
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(String(args[0]));
  });
  const structured = () => lines
    .filter(line => line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX))
    .map(line => JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as {
      event: string;
      detail: Record<string, unknown>;
    });
  const consoleLines = () => lines.filter(line => line.startsWith("[chatgpt-web] "));
  return { structured, consoleLines, restore: () => info.mockRestore() };
}

test("queue_state telemetry carries SLO fields for ordinary turns across the full lifecycle", async () => {
  const worker = stubWorker({ operationalLimit: 2 });
  const capture = capturedTraces();
  try {
    const first = worker.run(turn("slo_first"));
    const second = worker.run(turn("slo_second"));
    await first;
    await second;
    await Bun.sleep(15);
    const states = capture.structured().filter(event => event.event === "queue_state");
    const phases = states.map(event => event.detail.phase);
    expect(phases).toEqual(["queued", "granted", "queued", "granted", "released", "released"]);
    for (const event of states) {
      expect(event.detail).toHaveProperty("availableSlots");
      expect(event.detail).toHaveProperty("oldestWaitMs");
      expect(event.detail).toHaveProperty("runningByClass");
      expect(event.detail).toHaveProperty("effectivePressureLimit");
      expect(event.detail).toHaveProperty("queueDepth");
      expect(event.detail).toHaveProperty("activeSlotCount");
    }
    const granted = states.filter(event => event.detail.phase === "granted");
    expect(granted.every(event => event.detail.priorityClass === "ordinary"));
    // Grant-time accounting: first grant shows 1 running ordinary; second shows 2.
    expect((granted[0]!.detail.runningByClass as Record<string, number>).ordinary).toBe(1);
    expect((granted[1]!.detail.runningByClass as Record<string, number>).ordinary).toBe(2);
  } finally {
    capture.restore();
  }
});

test("runningByClass distinguishes compaction and continuation running work", async () => {
  const worker = stubWorker({ operationalLimit: 3 });
  const capture = capturedTraces();
  try {
    await worker.run(turn("slo_compaction", { compaction: true }));
    await worker.run(turn("slo_continuation", { continuation: true }));
    await worker.run(turn("slo_ordinary"));
    await Bun.sleep(15);
    const granted = capture.structured()
      .filter(event => event.event === "queue_state" && event.detail.phase === "granted");
    expect((granted[0]!.detail.runningByClass as Record<string, number>).compaction).toBe(1);
    expect((granted[1]!.detail.runningByClass as Record<string, number>).continuation).toBe(1);
    expect((granted[2]!.detail.runningByClass as Record<string, number>).ordinary).toBe(1);
  } finally {
    capture.restore();
  }
});

test("oldestWaitMs grows for a saturated queue and resets to the next-oldest entry on release", async () => {
  const worker = stubWorker({ operationalLimit: 1 });
  const capture = capturedTraces();
  try {
    const running = worker.run(turn("slo_holder"));
    const queuedA = worker.run(turn("slo_wait_a"));
    const queuedB = worker.run(turn("slo_wait_b"));
    const granted = capture.structured()
      .filter(event => event.event === "queue_state" && event.detail.phase === "granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.detail.availableSlots).toBe(0);
    // Capacity saturation is visible: 0 available slots with 2 queued behind the holder.
    const releaseState = capture.structured()
      .filter(event => event.event === "queue_state" && event.detail.phase === "released");
    running.then(() => {}, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
    // After release the oldest waiter must win the freed slot (wakeup correctness witness).
    const reGranted = capture.structured()
      .filter(event => event.event === "queue_state" && event.detail.phase === "granted");
    expect(reGranted.length).toBeGreaterThanOrEqual(2);
    expect(reGranted[1]!.detail.traceId).toBe("slo_wait_a");
    expect((reGranted[1]!.detail.runningByClass as Record<string, number>).ordinary).toBe(1);
    void releaseState;
    void queuedA;
    void queuedB;
  } finally {
    capture.restore();
  }
});

test("plain console queue lines carry the additive SLO fields without dropping existing ones", async () => {
  const worker = stubWorker({ operationalLimit: 1 });
  const capture = capturedTraces();
  try {
    const running = worker.run(turn("slo_console"));
    await running;
    await Bun.sleep(15);
    const queued = capture.consoleLines().find(line => line.startsWith("[chatgpt-web] turn_queued"));
    const granted = capture.consoleLines().find(line => line.startsWith("[chatgpt-web] slot_granted"));
    const released = capture.consoleLines().find(line => line.startsWith("[chatgpt-web] slot_released"));
    expect(queued).toBeDefined();
    expect(granted).toBeDefined();
    expect(released).toBeDefined();
    const queuedPayload = JSON.parse(queued!.slice("[chatgpt-web] turn_queued ".length)) as Record<string, unknown>;
    expect(queuedPayload).toHaveProperty("queueSequence");
    expect(queuedPayload).toHaveProperty("configuredOperationalLimit");
    expect(queuedPayload).toHaveProperty("effectivePressureLimit");
    expect(queuedPayload).toHaveProperty("priorityClass");
    expect(queuedPayload).toHaveProperty("availableSlots");
    expect(queuedPayload).toHaveProperty("oldestWaitMs");
    expect(queuedPayload).toHaveProperty("runningByClass");
    const grantedPayload = JSON.parse(granted!.slice("[chatgpt-web] slot_granted ".length)) as Record<string, unknown>;
    expect(grantedPayload).toHaveProperty("slotGrantedAt");
    expect(grantedPayload).toHaveProperty("availableSlots");
    const releasedPayload = JSON.parse(released!.slice("[chatgpt-web] slot_released ".length)) as Record<string, unknown>;
    expect(releasedPayload).toHaveProperty("availableSlots");
  } finally {
    capture.restore();
  }
});
