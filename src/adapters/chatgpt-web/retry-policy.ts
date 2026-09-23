import { ChatGptWebAdapterError } from "./adapter-error";

/** Maximum number of automatic browser-turn retries after the initial send. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = 3;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;
const TRANSIENT_RETRY_BASE_MS = [2_000, 5_000, 12_000] as const;
const RATE_LIMIT_RETRY_BASE_MS = [15_000, 30_000, 60_000] as const;
const RETRY_JITTER_FRACTION = 0.15;

export type ChatGptRateLimitCircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface RetryBudgetEntry {
  retries: number;
  updatedAt: number;
  nextAttemptAt: number;
  backoffMs: number;
  lastError: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

interface RateLimitCircuit {
  state: ChatGptRateLimitCircuitState;
  failures: number;
  openUntil: number;
  probeKey?: string;
}

export interface ChatGptRetryGateSnapshot {
  retryNumber: number;
  backoffMs: number;
  circuitState: ChatGptRateLimitCircuitState;
  circuitOpenUntil?: number;
  halfOpenProbe: boolean;
}

interface RetryPolicyDependencies {
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function exhaustedError(entry: RetryBudgetEntry): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} ChatGPT remained unavailable after several attempts.`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

function abortError(): DOMException {
  return new DOMException("ChatGPT retry wait aborted", "AbortError");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Process-local retry pressure controller.
 *
 * Native Codex remains responsible for deciding whether to retry a retryable response. This class
 * only gates that already-existing retry so immediate reconnects cannot hammer ChatGPT. Account
 * rate-limit evidence additionally opens a shared circuit that pauses new submissions while
 * accepted/running turns remain untouched.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();
  private readonly circuits = new Map<string, RateLimitCircuit>();
  private readonly circuitWaiters = new Map<string, Set<() => void>>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly ttlMs = RETRY_BUDGET_TTL_MS,
    dependencies: RetryPolicyDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.sleep = dependencies.sleep ?? defaultSleep;
  }

  recordRetryableFailure(
    key: string,
    error: ChatGptWebAdapterError,
    now = this.now(),
  ): ChatGptWebAdapterError {
    this.prune(now);
    const previous = this.entries.get(key);
    const retries = (previous?.retries ?? 0) + 1;
    const rateLimited = error.status === 429 || error.code === "rate_limit_exceeded";
    const base = rateLimited
      ? RATE_LIMIT_RETRY_BASE_MS[Math.min(retries - 1, RATE_LIMIT_RETRY_BASE_MS.length - 1)]!
      : TRANSIENT_RETRY_BASE_MS[Math.min(retries - 1, TRANSIENT_RETRY_BASE_MS.length - 1)]!;
    const backoffMs = Math.max(error.retryAfterMs ?? 0, this.jitter(base));
    const entry: RetryBudgetEntry = {
      retries,
      updatedAt: now,
      nextAttemptAt: now + backoffMs,
      backoffMs,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    if (rateLimited) this.openRateLimitCircuit(key, error.retryAfterMs, now);
    else {
      const scope = this.scopeFor(key);
      const circuit = this.circuitForScope(scope);
      if (circuit.state === "HALF_OPEN" && circuit.probeKey === key) {
        this.closeCircuit(scope, circuit);
      }
    }
    return retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : error;
  }

  recordRateLimitPressure(
    key: string,
    retryAfterMs?: number,
    now = this.now(),
  ): void {
    this.prune(now);
    this.openRateLimitCircuit(key, retryAfterMs, now);
  }

  /**
   * Wait until both the per-execution retry delay and the shared account circuit allow a new
   * browser submission. The first caller after OPEN becomes the sole HALF_OPEN probe.
   */
  async waitForAttempt(key: string, signal?: AbortSignal): Promise<ChatGptRetryGateSnapshot> {
    const scope = this.scopeFor(key);
    for (;;) {
      if (signal?.aborted) throw abortError();
      const now = this.now();
      this.prune(now);
      const entry = this.entries.get(key);
      const circuit = this.circuitForScope(scope);
      const retryNotBefore = entry?.nextAttemptAt ?? now;
      const circuitNotBefore = circuit.state === "OPEN" ? circuit.openUntil : now;
      const notBefore = Math.max(retryNotBefore, circuitNotBefore);
      if (notBefore > now) {
        await this.sleep(notBefore - now, signal);
        continue;
      }

      if (circuit.state === "OPEN") {
        circuit.state = "HALF_OPEN";
        circuit.probeKey = key;
        this.notifyCircuitChange(scope);
      } else if (circuit.state === "HALF_OPEN" && circuit.probeKey !== key) {
        await this.waitForCircuitChange(scope, signal);
        continue;
      }

      return {
        retryNumber: entry?.retries ?? 0,
        backoffMs: entry?.backoffMs ?? 0,
        circuitState: circuit.state,
        ...(circuit.state !== "CLOSED" ? { circuitOpenUntil: circuit.openUntil } : {}),
        halfOpenProbe: circuit.state === "HALF_OPEN" && circuit.probeKey === key,
      };
    }
  }

  /** Acceptance is strong enough to prove the account can currently start a ChatGPT turn. */
  recordSubmissionAccepted(key: string): void {
    this.entries.delete(key);
    const scope = this.scopeFor(key);
    const circuit = this.circuitForScope(scope);
    if (circuit.state === "HALF_OPEN" && circuit.probeKey === key) this.closeCircuit(scope, circuit);
  }

  exhaustedError(key: string, now = this.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : undefined;
  }

  clear(key: string): void {
    this.entries.delete(key);
    this.releaseProbe(key);
  }

  releaseProbe(key: string): void {
    const scope = this.scopeFor(key);
    const circuit = this.circuitForScope(scope);
    if (circuit.state === "HALF_OPEN" && circuit.probeKey === key) {
      circuit.state = "OPEN";
      circuit.openUntil = this.now();
      circuit.probeKey = undefined;
      this.notifyCircuitChange(scope);
    }
  }

  circuitSnapshot(keyOrScope?: string): {
    state: ChatGptRateLimitCircuitState;
    failures: number;
    openUntil?: number;
    probeKey?: string;
  } {
    let circuit: RateLimitCircuit;
    if (keyOrScope) {
      circuit = this.circuitForScope(this.scopeFor(keyOrScope));
    } else {
      const active = [...this.circuits.values()].filter(candidate => candidate.state !== "CLOSED");
      circuit = active.length === 1 ? active[0]! : { state: "CLOSED", failures: 0, openUntil: 0 };
    }
    return {
      state: circuit.state,
      failures: circuit.failures,
      ...(circuit.state !== "CLOSED" ? { openUntil: circuit.openUntil } : {}),
      ...(circuit.probeKey ? { probeKey: circuit.probeKey } : {}),
    };
  }

  /** New-submission pressure only; accepted/running turns are never cancelled by this value. */
  operationalConcurrencyLimit(normalLimit = 2, keyOrScope?: string): number {
    if (!Number.isSafeInteger(normalLimit) || normalLimit < 1) {
      throw new Error("ChatGPT operational concurrency limit must be a positive integer");
    }
    if (!keyOrScope) {
      return [...this.circuits.values()].some(circuit => circuit.state !== "CLOSED") ? 1 : normalLimit;
    }
    const circuit = this.circuitForScope(this.scopeFor(keyOrScope));
    return circuit.state === "CLOSED" ? normalLimit : 1;
  }

  private openRateLimitCircuit(key: string, retryAfterMs: number | undefined, now: number): void {
    const scope = this.scopeFor(key);
    const circuit = this.circuitForScope(scope);
    circuit.failures += 1;
    const base = RATE_LIMIT_RETRY_BASE_MS[
      Math.min(circuit.failures - 1, RATE_LIMIT_RETRY_BASE_MS.length - 1)
    ]!;
    const cooldownMs = Math.max(retryAfterMs ?? 0, this.jitter(base));
    circuit.state = "OPEN";
    circuit.probeKey = undefined;
    circuit.openUntil = Math.max(circuit.openUntil, now + cooldownMs);
    this.notifyCircuitChange(scope);
    console.warn(
      `[chatgpt-web] rate-limit circuit OPEN scope=${scope.slice(0, 12)}`
      + ` cooldownMs=${cooldownMs} source=${key.slice(0, 12)}`,
    );
  }

  private closeCircuit(scope: string, circuit: RateLimitCircuit): void {
    circuit.state = "CLOSED";
    circuit.failures = 0;
    circuit.openUntil = 0;
    circuit.probeKey = undefined;
    this.notifyCircuitChange(scope);
    console.info(`[chatgpt-web] rate-limit circuit CLOSED scope=${scope.slice(0, 12)}`);
  }

  private jitter(baseMs: number): number {
    const sample = Math.min(1, Math.max(0, this.random()));
    const factor = 1 - RETRY_JITTER_FRACTION + (2 * RETRY_JITTER_FRACTION * sample);
    return Math.max(1, Math.round(baseMs * factor));
  }

  private waitForCircuitChange(scope: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiters = this.circuitWaiters.get(scope) ?? new Set<() => void>();
      this.circuitWaiters.set(scope, waiters);
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (waiters.size === 0) this.circuitWaiters.delete(scope);
        resolve();
      };
      const onAbort = () => {
        waiters.delete(wake);
        if (waiters.size === 0) this.circuitWaiters.delete(scope);
        reject(abortError());
      };
      waiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notifyCircuitChange(scope: string): void {
    for (const wake of [...(this.circuitWaiters.get(scope) ?? [])]) wake();
  }

  private scopeFor(keyOrScope: string): string {
    const separator = keyOrScope.indexOf(":");
    return separator > 0 ? keyOrScope.slice(0, separator) : keyOrScope;
  }

  private circuitForScope(scope: string): RateLimitCircuit {
    let circuit = this.circuits.get(scope);
    if (!circuit) {
      circuit = { state: "CLOSED", failures: 0, openUntil: 0 };
      this.circuits.set(scope, circuit);
    }
    return circuit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();
