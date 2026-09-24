import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  ChatGptBrowserWorker,
  MAX_CHATGPT_BROWSER_TABS,
  chatGptCdpRecoverySnapshot,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnLifecycleProgress,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

type SchedulerState = {
  runningRuns: number;
  pendingRuns: unknown[];
  activeRuns: Map<string, Promise<string>>;
};

function browserTurn(traceId: string, abortSignal?: AbortSignal): BrowserTurn {
  return {
    traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
    ...(abortSignal ? { abortSignal } : {}),
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`deterministic scheduler condition was not reached: ${label}`);
}

function rateLimitError(retryAfterMs = 15_000): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("rate limited", {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
    retryAfterMs,
    submissionRejected: true,
  });
}

function fakeRetryClock() {
  let now = 0;
  const sleepers: Array<{ at: number; resolve: () => void }> = [];
  const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, {
    now: () => now,
    random: () => 0.5,
    sleep: ms => new Promise<void>(resolve => sleepers.push({ at: now + ms, resolve })),
  });
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (const sleeper of sleepers.splice(0)) {
      if (sleeper.at <= now) sleeper.resolve();
      else sleepers.push(sleeper);
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return { policy, advance, pendingSleeps: () => sleepers.length };
}

test.each([1, 2, 3, 5])("scheduler stress completes five turns at physical limit %i without starvation", async limit => {
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let running = 0;
  let maxRunning = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    operationalConcurrencyLimit: () => limit,
    runExclusive: (turn: BrowserTurn) => new Promise<string>(resolve => {
      starts.push(turn.traceId);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      releases.set(turn.traceId, () => {
        running -= 1;
        resolve(turn.traceId);
      });
    }),
  }) as ChatGptBrowserWorker;

  const traces = Array.from({ length: 5 }, (_unused, index) => `stress-${limit}-${index + 1}`);
  const promises = traces.map(traceId => worker.run(browserTurn(traceId)));
  for (const traceId of traces) {
    await until(() => releases.has(traceId), `start ${traceId}`);
    releases.get(traceId)!();
  }
  await expect(Promise.all(promises)).resolves.toEqual(traces);
  await until(() => (worker as unknown as SchedulerState).activeRuns.size === 0, `cleanup limit ${limit}`);

  expect(starts).toEqual(traces);
  expect(new Set(starts).size).toBe(5);
  expect(maxRunning).toBe(limit);
  expect(maxRunning).toBeLessThanOrEqual(MAX_CHATGPT_BROWSER_TABS);
  const state = worker as unknown as SchedulerState;
  expect(state.runningRuns).toBe(0);
  expect(state.pendingRuns).toHaveLength(0);
  expect(state.activeRuns.size).toBe(0);
});

test("ten logical sessions share balanced physical capacity without restoring the five-tab limit", async () => {
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let physicallyRunning = 0;
  let maxPhysicallyRunning = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    operationalConcurrencyLimit: () => 2,
    configuredOperationalConcurrencyLimit: () => 2,
    runExclusive: (turn: BrowserTurn) => new Promise<string>(resolve => {
      starts.push(turn.traceId);
      physicallyRunning += 1;
      maxPhysicallyRunning = Math.max(maxPhysicallyRunning, physicallyRunning);
      releases.set(turn.traceId, () => {
        physicallyRunning -= 1;
        resolve(turn.traceId);
      });
    }),
  }) as ChatGptBrowserWorker;
  const sessions = new ChatGptTurnSessions(30 * 60_000, 64);
  const traces = Array.from({ length: 10 }, (_unused, index) => `logical-${index + 1}`);
  const owned = traces.map((traceId, index) => {
    const browser = worker.run(browserTurn(traceId));
    const key = `execution-${index + 1}`;
    const session = sessions.getOrCreate(key, () => ({
      mode: "read-only" as const,
      browser,
      physicalSettlement: browser.then(() => undefined, () => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      lifecycleProgress: new ChatGptTurnLifecycleProgress(),
      cancel: () => {},
    }), traceId, `owner-${index + 1}`, `turn-${index + 1}`, `thread-${index + 1}`);
    return { key, session };
  });

  expect(sessions.activeCount()).toBe(10);
  await until(() => starts.length === 2, "first balanced ten-turn slots");
  expect(starts).toEqual(traces.slice(0, 2));
  for (const [index, traceId] of traces.entries()) {
    await until(() => releases.has(traceId), `ten-turn start ${traceId}`);
    releases.get(traceId)!();
    await owned[index]!.session.browserOutcome;
    expect(sessions.retire(owned[index]!.key, owned[index]!.session)).toBeTrue();
  }
  await until(() => (worker as unknown as SchedulerState).activeRuns.size === 0, "ten-turn cleanup");

  expect(starts).toEqual(traces);
  expect(new Set(starts).size).toBe(10);
  expect(maxPhysicallyRunning).toBe(2);
  expect(maxPhysicallyRunning).toBeLessThanOrEqual(MAX_CHATGPT_BROWSER_TABS);
  expect(sessions.activeCount()).toBe(0);
});

test("accepted sibling survives OPEN while one HALF_OPEN probe succeeds and queued work resumes fairly", async () => {
  const { policy, advance, pendingSleeps } = fakeRetryClock();
  const starts: string[] = [];
  let releaseA!: () => void;
  let rejectB!: (error: Error) => void;
  let acceptC!: () => void;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome", retryScope: "account" },
    activeRuns: new Map(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    configuredOperationalConcurrencyLimit: () => 2,
    operationalConcurrencyLimit: () => policy.operationalConcurrencyLimit(2, "account"),
    runExclusive: (turn: BrowserTurn) => {
      starts.push(turn.traceId);
      if (turn.traceId === "A") return new Promise<string>(resolve => { releaseA = () => resolve("A"); });
      if (turn.traceId === "B") return new Promise<string>((_resolve, reject) => { rejectB = reject; });
      if (turn.traceId === "C") {
        expect(policy.circuitSnapshot("account")).toMatchObject({ state: "HALF_OPEN", probeKey: "account:C" });
        return new Promise<string>(resolve => {
          acceptC = () => {
            policy.recordSubmissionAccepted("account:C");
            resolve("C");
          };
        });
      }
      policy.recordSubmissionAccepted("account:D");
      return Promise.resolve("D");
    },
  }) as ChatGptBrowserWorker;
  const turn = (traceId: string): BrowserTurn => ({
    ...browserTurn(traceId),
    beforePhysicalSubmission: () => policy.waitForAttempt(`account:${traceId}`).then(() => undefined),
    onRateLimitPressure: error => policy.recordRateLimitPressure(`account:${traceId}`, error.retryAfterMs),
  });

  const a = worker.run(turn("A"));
  const b = worker.run(turn("B"));
  const c = worker.run(turn("C"));
  const d = worker.run(turn("D"));
  await until(() => starts.length === 2, "A and B start");
  expect(starts).toEqual(["A", "B"]);

  rejectB(rateLimitError());
  await expect(b).rejects.toMatchObject({ status: 429, submissionRejected: true });
  await until(() => pendingSleeps() === 1, "C waits behind OPEN circuit");
  expect(policy.circuitSnapshot("account")).toMatchObject({ state: "OPEN", failures: 1 });
  expect(starts).toEqual(["A", "B"]);

  await advance(15_000);
  await until(() => starts.includes("C"), "C half-open probe starts beside accepted A");
  expect(starts).toEqual(["A", "B", "C"]);
  expect(starts.filter(value => value === "A")).toHaveLength(1);
  expect(starts.includes("D")).toBeFalse();

  acceptC();
  await expect(c).resolves.toBe("C");
  await until(() => starts.includes("D"), "D resumes after successful probe");
  expect(policy.circuitSnapshot("account")).toMatchObject({ state: "CLOSED", failures: 0 });
  await expect(d).resolves.toBe("D");
  releaseA();
  await expect(a).resolves.toBe("A");
  expect(starts).toEqual(["A", "B", "C", "D"]);
});

test("a HALF_OPEN probe that is rate limited reopens the circuit and keeps later queued work blocked", async () => {
  const { policy, advance, pendingSleeps } = fakeRetryClock();
  const starts: string[] = [];
  let releaseA!: () => void;
  let rejectB!: (error: Error) => void;
  let rejectC!: (error: Error) => void;
  const dAbort = new AbortController();
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome", retryScope: "account" },
    activeRuns: new Map(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    configuredOperationalConcurrencyLimit: () => 2,
    operationalConcurrencyLimit: () => policy.operationalConcurrencyLimit(2, "account"),
    runExclusive: (turn: BrowserTurn) => {
      starts.push(turn.traceId);
      if (turn.traceId === "A") return new Promise<string>(resolve => { releaseA = () => resolve("A"); });
      if (turn.traceId === "B") return new Promise<string>((_resolve, reject) => { rejectB = reject; });
      if (turn.traceId === "C") return new Promise<string>((_resolve, reject) => { rejectC = reject; });
      return Promise.resolve("D");
    },
  }) as ChatGptBrowserWorker;
  const turn = (traceId: string, abortSignal?: AbortSignal): BrowserTurn => ({
    ...browserTurn(traceId, abortSignal),
    beforePhysicalSubmission: () => policy.waitForAttempt(`account:${traceId}`, abortSignal).then(() => undefined),
    onRateLimitPressure: error => policy.recordRateLimitPressure(`account:${traceId}`, error.retryAfterMs),
  });

  const a = worker.run(turn("A"));
  const b = worker.run(turn("B"));
  const c = worker.run(turn("C"));
  const d = worker.run(turn("D", dAbort.signal));
  await until(() => starts.length === 2, "A and B start before repeated 429");
  rejectB(rateLimitError());
  await expect(b).rejects.toMatchObject({ status: 429 });
  await until(() => pendingSleeps() === 1, "C waits for first cooldown");
  await advance(15_000);
  await until(() => starts.includes("C"), "C becomes first half-open probe");

  rejectC(rateLimitError(30_000));
  await expect(c).rejects.toMatchObject({ status: 429 });
  await until(() => pendingSleeps() === 1, "D waits after probe reopens circuit");
  expect(policy.circuitSnapshot("account")).toMatchObject({ state: "OPEN", failures: 2 });
  expect(starts.includes("D")).toBeFalse();
  expect(starts.filter(value => value === "A")).toHaveLength(1);

  dAbort.abort();
  await expect(d).rejects.toMatchObject({ name: "AbortError" });
  releaseA();
  await expect(a).resolves.toBe("A");
  expect(starts).toEqual(["A", "B", "C"]);
});

test("shared browser-host loss settles accepted siblings without losing the queued turn or leaking slots", async () => {
  const starts: string[] = [];
  const rejectors = new Map<string, (error: Error) => void>();
  let hostFailed = false;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    pendingRuns: [],
    runningRuns: 0,
    nextQueueSequence: 1,
    admissionInFlight: false,
    configuredOperationalConcurrencyLimit: () => 2,
    operationalConcurrencyLimit: () => 2,
    runExclusive: (turn: BrowserTurn) => {
      starts.push(turn.traceId);
      if (turn.traceId === "C") {
        expect(hostFailed).toBeTrue();
        return Promise.resolve("C-safe-pre-send-restart");
      }
      return new Promise<string>((_resolve, reject) => rejectors.set(turn.traceId, reject));
    },
  }) as ChatGptBrowserWorker;

  const a = worker.run(browserTurn("A"));
  const b = worker.run(browserTurn("B"));
  const c = worker.run(browserTurn("C"));
  await until(() => starts.length === 2, "accepted host-loss siblings occupy both slots");
  expect(starts).toEqual(["A", "B"]);

  hostFailed = true;
  rejectors.get("A")!(new Error("shared browser host exited after acceptance"));
  rejectors.get("B")!(new Error("shared browser host exited after acceptance"));
  const settledAccepted = await Promise.allSettled([a, b]);
  expect(settledAccepted.every(result => result.status === "rejected")).toBeTrue();
  await until(() => starts.includes("C"), "queued pre-send turn retains its position after host loss");
  await expect(c).resolves.toBe("C-safe-pre-send-restart");
  await until(() => (worker as unknown as SchedulerState).activeRuns.size === 0, "host-loss scheduler cleanup");

  expect(starts).toEqual(["A", "B", "C"]);
  const state = worker as unknown as SchedulerState;
  expect(state.runningRuns).toBe(0);
  expect(state.pendingRuns).toHaveLength(0);
  expect(state.activeRuns.size).toBe(0);
  expect(chatGptCdpRecoverySnapshot()).toEqual({ active: 0, queued: 0 });
});

test("accelerated parallel soak represents sixty logical minutes and leaves zero runtime residue", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const brokerPath = process.platform === "win32"
    ? `\\\\.\\pipe\\cgw-soak-${process.pid}-${Date.now()}`
    : join(tmpdir(), `cgw-soak-${process.pid}-${Date.now()}.sock`);
  const broker = TurnBroker.forSocket(brokerPath);
  const sessions = new ChatGptTurnSessions(30 * 60_000, 64);
  const environment: ChatGptTurnEnvironment = {
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [process.cwd()],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{ name: "exec_command", description: "soak tool", parameters: { type: "object" } }],
  };
  let logicalNow = 0;
  let lifecycleOperations = 0;
  let simulatedTurns = 0;
  let duplicateSubmissions = 0;
  let duplicateToolExecutions = 0;
  let crossTurnDeliveries = 0;
  let maxRunning = 0;
  const submitted = new Set<string>();
  const completedTools = new Set<string>();
  const progressInstances: ChatGptExternalTurnProgress[] = [];

  try {
    for (let cycle = 0; cycle < 120; cycle += 1) {
      logicalNow += 30_000;
      let physicalRunning = 0;
      const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
        config: { browserHost: "managed-chrome" },
        activeRuns: new Map(),
        pendingRuns: [],
        runningRuns: 0,
        nextQueueSequence: 1,
        admissionInFlight: false,
        operationalConcurrencyLimit: () => 2,
        runExclusive: async (turn: BrowserTurn) => {
          lifecycleOperations += 5; // grant, send, accept, stream, complete
          if (submitted.has(turn.traceId)) duplicateSubmissions += 1;
          submitted.add(turn.traceId);
          physicalRunning += 1;
          maxRunning = Math.max(maxRunning, physicalRunning);
          await Promise.resolve();
          physicalRunning -= 1;
          return turn.traceId;
        },
      }) as ChatGptBrowserWorker;
      const state = worker as unknown as SchedulerState;
      const traces = Array.from({ length: 5 }, (_unused, index) => `soak-${cycle}-${index}`);
      lifecycleOperations += traces.length * 2; // queue + release
      simulatedTurns += traces.length;
      await Promise.all(traces.map(traceId => worker.run(browserTurn(traceId))));
      await until(() => state.activeRuns.size === 0, `soak scheduler cleanup ${cycle}`);
      expect(state.runningRuns).toBe(0);
      expect(state.pendingRuns).toHaveLength(0);

      for (const [index, traceId] of traces.entries()) {
        const lifecycleProgress = new ChatGptTurnLifecycleProgress();
        lifecycleProgress.record("browser", logicalNow + index);
        lifecycleProgress.record("response", logicalNow + index + 1);
        if ((cycle + index) % 11 === 0) {
          lifecycleProgress.record("recovery", logicalNow + index + 2);
          lifecycleOperations += 1;
        }
        const session = sessions.getOrCreate(`session-${traceId}`, () => ({
          mode: "read-only" as const,
          browser: Promise.resolve(traceId),
          physicalSettlement: Promise.resolve(),
          trace: new ChatGptTraceFeed(),
          text: new ChatGptTextFeed(),
          lifecycleProgress,
          cancel: () => {},
        }), traceId);
        await session.browserOutcome;
        await session.physicalSettlement;
        expect(sessions.retire(`session-${traceId}`, session)).toBeTrue();
      }

      if (cycle % 10 === 0) {
        const tokens = await Promise.all(Array.from({ length: 3 }, (_unused, index) => (
          broker.register(environment, 60_000, `soak-tool-${cycle}-${index}`)
        )));
        const claims = await Promise.all(tokens.map((token, index) => callTurnBroker<{ bindingId: string }>(
          brokerPath,
          { method: "claim", token, activityId: `activity_soak_${cycle}_${index}_abcdefghijklmnop` },
          2_000,
        )));
        const invocations = claims.map((claim, index) => callTurnBroker(
          brokerPath,
          {
            method: "invoke",
            bindingId: claim.bindingId,
            wireName: "exec_command",
            arguments: { cmd: `turn-${cycle}-${index}` },
          },
          2_000,
        ));
        const batches = await Promise.all(tokens.map(token => broker.nextToolBatch(token)));
        const ownerByCall = new Map<string, string>();
        for (const [index, batch] of batches.entries()) {
          expect(batch).toHaveLength(1);
          const request = batch[0]!;
          ownerByCall.set(request.callId, tokens[index]!);
          if (completedTools.has(request.callId)) duplicateToolExecutions += 1;
          const progress = new ChatGptExternalTurnProgress();
          progressInstances.push(progress);
          progress.recordToolBatch(1, logicalNow + 10 + index);
          progress.recordToolResult(logicalNow + 20 + index);
          lifecycleOperations += 2;
        }
        try {
          broker.completeTool(tokens[1]!, batches[0]![0]!.callId, { content: [{ type: "text", text: "wrong-owner" }] });
          crossTurnDeliveries += 1;
        } catch {}
        for (const [index, batch] of batches.entries()) {
          const request = batch[0]!;
          expect(ownerByCall.get(request.callId)).toBe(tokens[index]);
          broker.completeTool(tokens[index]!, request.callId, {
            content: [{ type: "text", text: `result-${cycle}-${index}` }],
          });
          completedTools.add(request.callId);
        }
        const results = await Promise.all(invocations);
        expect(results.map(result => JSON.stringify(result))).toEqual([
          JSON.stringify({ content: [{ type: "text", text: `result-${cycle}-0` }] }),
          JSON.stringify({ content: [{ type: "text", text: `result-${cycle}-1` }] }),
          JSON.stringify({ content: [{ type: "text", text: `result-${cycle}-2` }] }),
        ]);
        for (const token of tokens) broker.revoke(token);
      }
    }

    const brokerState = broker as unknown as {
      channels: Map<string, unknown>;
      pending: Map<string, unknown>;
      bindings: Map<string, unknown>;
    };
    expect(logicalNow).toBe(3_600_000);
    expect(simulatedTurns).toBe(600);
    expect(submitted.size).toBe(600);
    expect(lifecycleOperations).toBe(4_326);
    expect(completedTools.size).toBe(36);
    expect(progressInstances).toHaveLength(36);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(duplicateSubmissions).toBe(0);
    expect(duplicateToolExecutions).toBe(0);
    expect(crossTurnDeliveries).toBe(0);
    expect(sessions.activeCount()).toBe(0);
    expect(brokerState.channels.size).toBe(0);
    expect(brokerState.pending.size).toBe(0);
    expect(brokerState.bindings.size).toBe(0);
    expect(progressInstances.every(progress => progress.snapshot().activeToolCalls === 0)).toBeTrue();
    expect(chatGptCdpRecoverySnapshot()).toEqual({ active: 0, queued: 0 });
  } finally {
    sessions.clear();
    await broker.close().catch(() => {});
    info.mockRestore();
    warn.mockRestore();
  }
});
