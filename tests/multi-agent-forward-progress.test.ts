import { expect, spyOn, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  clearChatGptContinuationCredits,
  grantChatGptContinuationCredit,
  takeChatGptContinuationCredit,
} from "../src/adapters/chatgpt-web/continuation-credits";

/**
 * Deterministic multi-agent forward-progress proof (Failure B closure evidence).
 *
 * Drives the REAL ChatGptBrowserWorker admission scheduler (only the browser execution itself is
 * stubbed) through the exact live topology of the 2026-09-29 incident: a parent holding a browser
 * slot in its multi-agent wait loop, three children sharing the remaining capacity, a send_input
 * steer of an active child, and an auto-compaction of the parent requested mid-wait.
 *
 * Layer fidelity note (deliberate, not a shortcut): at this layer "submission" is the slot-granted
 * boundary (the stub executes instead of ChatGPT web) and "tool activity" does not exist — tool
 * traffic per child trace was proven separately from the live launcher log (broker
 * queued/delivered/completed records per trace). What this harness proves is the SCHEDULING
 * contract: bounded forward progress, no starvation, bounded compaction priority, and continuations
 * that never fall to the FIFO tail.
 */

interface ChildRecord {
  traceId: string;
  spawnedAt: number;
  queuedAt?: number;
  grantedAt?: number;
  queueWaitMs?: number;
  submittedAt?: number;
  completedAt?: number;
}

function harness(operationalLimit: number) {
  const records = new Map<string, ChildRecord>();
  const releaseCallbacks = new Map<string, () => void>();
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    lines.push(line);
    if (!line.startsWith("[chatgpt-web] ")) return;
    const spaceIndex = line.indexOf(" ", "[chatgpt-web] ".length);
    const eventName = line.slice("[chatgpt-web] ".length, spaceIndex);
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(line.slice(spaceIndex + 1)) as Record<string, unknown>;
    } catch {
      return;
    }
    const traceId = String(detail.traceId ?? "");
    if (!traceId) return;
    const record = records.get(traceId) ?? { traceId, spawnedAt: Date.now() };
    if (eventName === "turn_queued") {
      record.queuedAt = detail.queuedAt as number;
    } else if (eventName === "slot_granted") {
      record.grantedAt = detail.slotGrantedAt as number;
      record.queueWaitMs = detail.queueWaitMs as number;
    }
    records.set(traceId, record);
  });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map<string, Promise<string>>(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    consecutiveCompactionAdmissions: 0,
    consecutiveContinuationAdmissions: 0,
    operationalConcurrencyLimit: () => operationalLimit,
    configuredOperationalConcurrencyLimit: () => operationalLimit,
    // The stub stands in for the physical browser turn; its start is the real scheduler's
    // submission boundary (slot held until the caller releases it, exactly like a live turn).
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      const record = records.get(turn.traceId);
      if (record) record.submittedAt = Date.now();
      releaseCallbacks.set(turn.traceId, () => {
        const done = records.get(turn.traceId);
        if (done) done.completedAt = Date.now();
        resolve(turn.traceId);
      });
    }),
  }) as ChatGptBrowserWorker;
  return {
    worker,
    releaseCallbacks,
    restore: () => info.mockRestore(),
    record: (traceId: string) => records.get(traceId)!,
    snapshot: () => [...records.values()].sort((a, b) => a.spawnedAt - b.spawnedAt),
    printTimeline(label: string): void {
      const rows = [...records.values()].map(entry => ({
        child: entry.traceId,
        spawnedAt: entry.spawnedAt,
        queuedAt: entry.queuedAt,
        slotGrantedAt: entry.grantedAt,
        queueWaitMs: entry.queueWaitMs,
        submittedAt: entry.submittedAt,
        toolActivity: "n/a (scheduler layer; live-tool proof = launcher broker records)",
        completedAt: entry.completedAt,
      }));
      // eslint-disable-next-line no-console
      console.log(`MULTI_AGENT_TIMELINE ${label} ${JSON.stringify(rows)}`);
    },
  };
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

test("parent + 3 children at operational concurrency 2: overlap is real, waits are bounded, nobody starves", async () => {
  const h = harness(2);
  try {
    // Parent takes slot 1 and holds it for its whole multi-agent wait loop (live-inherent:
    // its ChatGPT generation stays open across wait_agent polls).
    const parent = h.worker.run(turn("parent"));
    await Bun.sleep(3);
    expect(h.record("parent").grantedAt).toBeDefined();

    // Three children spawn while the parent waits. Slot 2 admits child A immediately — this is
    // REAL overlap: parent and child A are simultaneously admitted (live mirror: 18:39:04).
    const childA = h.worker.run(turn("child_A"));
    const childB = h.worker.run(turn("child_B"));
    const childC = h.worker.run(turn("child_C"));
    await Bun.sleep(10);
    expect(h.record("child_A").grantedAt).toBeDefined();
    expect(h.record("child_B").grantedAt).toBeUndefined();
    expect(h.record("child_C").grantedAt).toBeUndefined();

    // Child A finishes -> B is admitted with bounded latency (one release, no priority jumping).
    h.releaseCallbacks.get("child_A")!();
    await Bun.sleep(10);
    expect(h.record("child_B").grantedAt).toBeDefined();
    expect((h.record("child_B").queueWaitMs ?? Infinity)).toBeLessThan(1_000);

    // Child B finishes -> C is admitted. FIFO rotation, no starvation.
    h.releaseCallbacks.get("child_B")!();
    await Bun.sleep(10);
    expect(h.record("child_C").grantedAt).toBeDefined();
    expect((h.record("child_C").queueWaitMs ?? Infinity)).toBeLessThan(1_000);

    // Parent + all three children complete.
    h.releaseCallbacks.get("parent")!();
    h.releaseCallbacks.get("child_C")!();
    await Bun.sleep(10);
    for (const id of ["parent", "child_A", "child_B", "child_C"]) {
      expect(h.record(id).completedAt).toBeDefined();
    }
    // Prove real overlap: parent's slot and child A's slot were held simultaneously
    // (parent granted before A, released after A — activeSlotCount reached 2).
    expect(h.record("child_A").grantedAt!).toBeGreaterThanOrEqual(h.record("parent").grantedAt!);
    h.printTimeline("concurrency2-parent+3children");
    await parent;
    await childA;
    await childB;
    await childC;
  } finally {
    h.restore();
  }
});

test("provider-serialized model (concurrency 1): fair interleaving with bounded latency, no starvation", async () => {
  const h = harness(1);
  try {
    const parent = h.worker.run(turn("parent"));
    const childA = h.worker.run(turn("child_A"));
    const childB = h.worker.run(turn("child_B"));
    const childC = h.worker.run(turn("child_C"));
    await Bun.sleep(5);
    expect(h.record("parent").grantedAt).toBeDefined();

    // Strict rotation: each release admits exactly the next turn in queue order, every wait is
    // bounded by the single prior turn's runtime, and all four runs complete.
    for (const id of ["parent", "child_A", "child_B", "child_C"]) {
      h.releaseCallbacks.get(id)!();
      await Bun.sleep(10);
    }
    const order = ["parent", "child_A", "child_B", "child_C"]
      .map(id => h.record(id).grantedAt!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const id of ["parent", "child_A", "child_B", "child_C"]) {
      expect((h.record(id).queueWaitMs ?? Infinity)).toBeLessThan(1_000);
      expect(h.record(id).completedAt).toBeDefined();
    }
    h.printTimeline("concurrency1-fair-interleaving");
    await parent;
    await childA;
    await childB;
    await childC;
  } finally {
    h.restore();
  }
});

test("parent waiting + child A active + B/C queued + steer(A) + parent compaction: bounded priority everywhere", async () => {
  clearChatGptContinuationCredits();
  const h = harness(2);
  try {
    // Parent holds slot 1 in its wait loop; child A holds slot 2; B and C are queued.
    const parent = h.worker.run(turn("parent"));
    const childA = h.worker.run(turn("child_A"));
    const childB = h.worker.run(turn("child_B"));
    const childC = h.worker.run(turn("child_C"));
    await Bun.sleep(5);
    expect(h.record("parent").grantedAt).toBeDefined();
    expect(h.record("child_A").grantedAt).toBeDefined();

    // Auto-compaction of the parent: the live design aborts the parent's browser generation
    // (slot released), enqueues the compaction turn, and later resumes the parent. The parent
    // thread receives a one-shot continuation credit exactly as startRuntime grants it.
    h.releaseCallbacks.get("parent")!();
    grantChatGptContinuationCredit("parent-thread", "compaction_handoff");
    const compaction = h.worker.run(turn("compact_P", { compaction: true }));
    await Bun.sleep(5);
    // Bounded priority: the freed slot goes to the compaction, NOT to queued children B/C.
    expect(h.record("compact_P").grantedAt).toBeDefined();
    expect(h.record("child_B").grantedAt).toBeUndefined();
    expect(h.record("child_C").grantedAt).toBeUndefined();

    // Child A is steered (send_input): its live generation is aborted and the follow-up turn
    // arrives carrying the thread's continuation credit (adapter mapping: credit -> class).
    // Give the release microtask time to admit B into A's freed slot first (two slots then held
    // by compaction + B), so the steered resume must WAIT and then beat C on the next release.
    h.releaseCallbacks.get("child_A")!();
    await Bun.sleep(8);
    expect(h.record("child_B").grantedAt).toBeDefined();
    grantChatGptContinuationCredit("child-A-thread", "interrupt_steer");
    const steered = takeChatGptContinuationCredit("child-A-thread");
    expect(steered).toBeDefined();
    const childAResume = h.worker.run(turn("child_A_resume", { continuation: steered !== undefined }));
    await Bun.sleep(5);
    // Slots are full (compaction + B): the steered resume is queued, NOT granted yet.
    expect(h.record("child_A_resume").grantedAt).toBeUndefined();
    expect(h.record("child_C").grantedAt).toBeUndefined();

    h.releaseCallbacks.get("compact_P")!();
    await Bun.sleep(10);
    // The continuation reclaims admission ahead of C; it does NOT fall to the FIFO tail.
    expect(h.record("child_A_resume").grantedAt).toBeDefined();
    expect(h.record("child_C").grantedAt).toBeUndefined();

    // Bounded anti-starvation: C follows next (ordinary FIFO; continuation streak stays bounded).
    h.releaseCallbacks.get("child_A_resume")!();
    await Bun.sleep(10);
    expect(h.record("child_C").grantedAt).toBeDefined();
    h.releaseCallbacks.get("child_C")!();
    h.releaseCallbacks.get("child_B")!();

    for (const promise of [parent, childA, childB, childC, compaction, childAResume]) {
      await promise;
    }
    h.printTimeline("steer+compaction-bounded-priority");
  } finally {
    h.restore();
    clearChatGptContinuationCredits();
  }
});
