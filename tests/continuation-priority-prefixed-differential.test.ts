import { expect, test } from "bun:test";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

// PRE-FIX module: the exact source that produced the failing installed 6.1.10 candidate
// (final-6.1.10-source/src is byte-identical to the repo tree at the installed build, whose
// dist/runtime/app/cli.js hash 25197a95… matches the live install). Read-only import.
// The fixture lives only on the incident workstation, outside the repository, so CI and any
// other checkout skip these differential tests instead of failing on the missing module.
let preFixPrototype: object | null = null;
try {
  // @ts-ignore — deliberate import of an incident fixture that exists outside the repository
  preFixPrototype = (await import("../../final-6.1.10-source/src/adapters/chatgpt-web/browser-worker"))
    .ChatGptBrowserWorker.prototype;
} catch {}
const testIfFixture = test.skipIf(preFixPrototype === null);

/**
 * Differential pre-fix reproduction of the 2026-09-29 compaction starvation incident:
 * a compaction enqueued while an admission gate is in flight must LOSE the grant on the
 * pre-fix scheduler (the gated turn is spliced and granted unconditionally at settle) and
 * WIN on the fixed scheduler. This test pins that the regression suite actually detects the
 * shipped bug rather than merely confirming the new code's happy path.
 */

type PreFixWorkerStub = { run: (turn: BrowserTurn) => Promise<unknown> };

function preFixStubWorker(operationalLimit: number) {
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  const worker = Object.assign(Object.create(preFixPrototype!), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map<string, Promise<string>>(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    consecutiveCompactionAdmissions: 0,
    operationalConcurrencyLimit: () => operationalLimit,
    configuredOperationalConcurrencyLimit: () => operationalLimit,
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      starts.push(turn.traceId);
      releases.set(turn.traceId, () => resolve(turn.traceId));
    }),
  }) as PreFixWorkerStub;
  return { worker, starts, releases };
}

function preFixTurn(options: {
  traceId: string;
  compaction?: boolean;
  beforePhysicalSubmission?: () => Promise<void>;
}): BrowserTurn {
  return {
    traceId: options.traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ text: options.traceId, images: [], release() {} }),
    onTextDelta() {},
    ...(options.compaction ? { compaction: true } : {}),
    ...(options.beforePhysicalSubmission ? { beforePhysicalSubmission: options.beforePhysicalSubmission } : {}),
  } as BrowserTurn;
}

testIfFixture("PRE-FIX 6.1.10 scheduler reproduces the incident: compaction loses the slot to the gated turn", async () => {
  const { worker, starts, releases } = preFixStubWorker(2);
  let releaseGate!: () => void;
  void worker.run(preFixTurn({ traceId: "runner_A" }));
  const gated = worker.run(preFixTurn({
    traceId: "gated_child",
    beforePhysicalSubmission: () => new Promise<void>(resolve => { releaseGate = resolve; }),
  })) as Promise<string>;
  await Bun.sleep(5);
  expect(starts).toEqual(["runner_A"]);
  void worker.run(preFixTurn({ traceId: "compact_C", compaction: true }));
  await Bun.sleep(5);
  releaseGate();
  await Bun.sleep(15);
  // The shipped scheduler grants the gated turn at settle and the compaction keeps waiting —
  // the exact live failure (18:58:59.333 compaction_queue_entered, 641,496ms queue wait).
  expect(starts).toEqual(["runner_A", "gated_child"]);
  releases.get("runner_A")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["runner_A", "gated_child", "compact_C"]);
  releases.get("gated_child")?.();
  releases.get("compact_C")?.();
  await gated;
});

testIfFixture("PRE-FIX 6.1.10 scheduler reproduces the steer starvation: a steered child's resume waits behind older FIFO work", async () => {
  // Live: steered child 8fac's follow-up c30634339f67 queued at the FIFO tail (18:50:17) and was
  // admitted only at 19:24:17 (queueWaitMs 2,039,861). The pre-fix scheduler has no continuation
  // class, so the resume turn is plain FIFO head-of-line blocked behind the older turn.
  const { worker, starts, releases } = preFixStubWorker(1);
  void worker.run(preFixTurn({ traceId: "old_running" }));
  void worker.run(preFixTurn({ traceId: "old_queued" }));
  const steered = worker.run(preFixTurn({ traceId: "steered_resume" })) as Promise<string>;
  await Bun.sleep(5);
  releases.get("old_running")?.();
  await Bun.sleep(15);
  // Pre-fix: the steered resume is NOT prioritized — the older queued turn wins the slot.
  expect(starts).toEqual(["old_running", "old_queued"]);
  releases.get("old_queued")?.();
  await Bun.sleep(15);
  expect(starts).toEqual(["old_running", "old_queued", "steered_resume"]);
  releases.get("steered_resume")?.();
  await steered;
});
