import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";
import {
  ChatGptRateLimitStateStore,
  rateLimitStatePath,
} from "../src/adapters/chatgpt-web/rate-limit-state";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function rateLimitError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("ChatGPT rate limited this account", {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
}

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), "cgw-rate-limit-state-"));
  temporaryRoots.push(configDir);
  const path = rateLimitStatePath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  let now = 1_000_000;
  const clock = () => now;
  const advance = (ms: number) => { now += ms; };
  /** Deferred sleep: parks the gate like the real backoff would, released manually. */
  const deferredSleep = () => {
    let release!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve; });
    return {
      sleep: () => parked,
      release: () => release(),
    };
  };
  const makePolicy = (sleep?: () => Promise<void>) => new ChatGptWebTurnRetryPolicy(30 * 60_000, {
    now: clock,
    ...(sleep ? { sleep: () => sleep() } : {}),
    stateStore: new ChatGptRateLimitStateStore(path, clock),
  });
  return { path, clock, advance, deferredSleep, makePolicy };
}

describe("persistent 429 rate-limit circuit state", () => {
  test("an OPEN circuit survives a restart and gates new submissions until its window expires", async () => {
    const { path, advance, deferredSleep, makePolicy } = fixture();
    const first = makePolicy();
    first.recordRateLimitPressure("quota-authority-a:turn_1", undefined);
    expect(first.circuitSnapshot("quota-authority-a:turn_1").state).toBe("OPEN");
    expect(existsSync(path)).toBe(true);
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    const scopeHashes = Object.keys(persisted.circuits);
    expect(scopeHashes).toHaveLength(1);
    expect(scopeHashes[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(path, "utf8")).not.toContain("quota-authority-a");

    // A fresh runtime restores the OPEN circuit and keeps suppressing new submissions.
    const parked = deferredSleep();
    const restarted = makePolicy(parked.sleep);
    expect(restarted.circuitSnapshot("quota-authority-a:turn_2").state).toBe("OPEN");
    expect(restarted.operationalConcurrencyLimit(2, "quota-authority-a:turn_2")).toBe(1);
    let probeStarted = false;
    const gatePromise = restarted.waitForAttempt("quota-authority-a:turn_2").then(gate => {
      probeStarted = true;
      return gate;
    });
    await Bun.sleep(10);
    expect(probeStarted).toBe(false); // no immediate provider hit while the restored window is open

    advance(70_000);
    parked.release();
    const snapshot = await gatePromise;
    expect(["OPEN", "HALF_OPEN"]).toContain(snapshot.circuitState);
    expect(probeStarted).toBe(true);
  });

  test("an expired persisted circuit is ignored and cleaned from the file", () => {
    const { path, clock, makePolicy } = fixture();
    writeFileSync(path, JSON.stringify({
      version: 1,
      circuits: { "0123456789abcdef": {
        openUntil: 500_000, reason: "rate_limit_pressure", status: 429, retryAfterMs: 0, updatedAt: 400_000,
      } },
    }));
    const policy = makePolicy();
    expect(policy.circuitSnapshot("any:turn").state).toBe("CLOSED");
    expect(policy.operationalConcurrencyLimit(2, "any:turn")).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).circuits)).toHaveLength(0);
    void clock;
  });

  test("a malformed state file fails open for the circuit only, with the runtime unaffected", () => {
    const { path, makePolicy } = fixture();
    writeFileSync(path, "{not json at all");
    const policy = makePolicy();
    expect(policy.circuitSnapshot("any:turn").state).toBe("CLOSED");
    expect(policy.operationalConcurrencyLimit(2, "any:turn")).toBe(2);
    // Live pressure still works after the failed restore.
    policy.recordRateLimitPressure("any:turn", 1000);
    expect(policy.circuitSnapshot("any:turn").state).toBe("OPEN");
  });

  test("an unsupported schema version fails open exactly like corruption", () => {
    const { path, makePolicy } = fixture();
    writeFileSync(path, JSON.stringify({ version: 99, circuits: {} }));
    const policy = makePolicy();
    expect(policy.circuitSnapshot("any:turn").state).toBe("CLOSED");
  });

  test("a missing state file behaves like a fresh runtime", () => {
    const { path, makePolicy } = fixture();
    const policy = makePolicy();
    expect(policy.circuitSnapshot("any:turn").state).toBe("CLOSED");
    expect(existsSync(path)).toBe(false);
  });

  test("a probe acceptance after restart closes the circuit and clears the persisted window", async () => {
    const { path, advance, deferredSleep, makePolicy } = fixture();
    const first = makePolicy();
    first.recordRateLimitPressure("quota-authority-b:turn_1", 5_000);
    const parked = deferredSleep();
    const restarted = makePolicy(parked.sleep);
    expect(restarted.circuitSnapshot("quota-authority-b:turn_1").state).toBe("OPEN");
    const gate = restarted.waitForAttempt("quota-authority-b:turn_1");
    await Bun.sleep(10);
    advance(20_000);
    parked.release();
    await gate;
    restarted.recordSubmissionAccepted("quota-authority-b:turn_1");
    expect(restarted.circuitSnapshot("quota-authority-b:turn_1").state).toBe("CLOSED");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).circuits)).toHaveLength(0);
  });

  test("rate-limit failures persist their typed reason alongside the open window", () => {
    const { path, makePolicy } = fixture();
    const policy = makePolicy();
    policy.recordRetryableFailure("quota-authority-c:turn_1", rateLimitError());
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    const [circuit] = Object.values(persisted.circuits as Record<string, { reason: string; status: number }>);
    expect(circuit.reason).toBe("rate_limit_exceeded");
    expect(circuit.status).toBe(429);
  });
});
