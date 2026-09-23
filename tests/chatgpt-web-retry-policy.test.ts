import { expect, test } from "bun:test";
import { ChatGptRecoveryExhaustedError, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { classifyChatGptRecovery } from "../src/adapters/chatgpt-web/recovery-classification";
import {
  ChatGptWebTurnRetryPolicy,
  MAX_CHATGPT_WEB_TURN_RETRIES,
} from "../src/adapters/chatgpt-web/retry-policy";

function transientError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("temporary upstream failure", {
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });
}

function rateLimitError(retryAfterMs?: number, submissionRejected = false): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("rate limited", {
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(submissionRejected ? { submissionRejected: true } : {}),
  });
}

test("retry policy applies deterministic 2s/5s/12s pre-submission backoff and keeps the hard cap", async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, {
    now: () => now,
    random: () => 0.5,
    sleep: async ms => { sleeps.push(ms); now += ms; },
  });
  const key = "scope:retry-sequence";

  for (const expected of [2_000, 5_000, 12_000]) {
    const handled = policy.recordRetryableFailure(key, transientError());
    expect(handled.retryable).toBeTrue();
    const gate = await policy.waitForAttempt(key);
    expect(gate.backoffMs).toBe(expected);
    expect(sleeps.at(-1)).toBe(expected);
  }

  expect(MAX_CHATGPT_WEB_TURN_RETRIES).toBe(3);
  const exhausted = policy.recordRetryableFailure(key, transientError());
  expect(exhausted.retryable).toBeFalse();
  expect(policy.exhaustedError(key)).toMatchObject({ retryable: false });
});

test("rate-limit circuit honors Retry-After, permits one half-open probe, and never cancels active turns", async () => {
  let now = 10_000;
  const sleeps: number[] = [];
  const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, {
    now: () => now,
    random: () => 0.5,
    sleep: async ms => { sleeps.push(ms); now += ms; },
  });

  policy.recordRetryableFailure("scope:probe", rateLimitError(45_000, true));
  expect(policy.circuitSnapshot("scope")).toMatchObject({ state: "OPEN", failures: 1 });
  expect(policy.operationalConcurrencyLimit(2, "scope")).toBe(1);

  const probe = await policy.waitForAttempt("scope:probe");
  expect(sleeps).toEqual([45_000]);
  expect(probe).toMatchObject({ circuitState: "HALF_OPEN", halfOpenProbe: true });
  expect(policy.operationalConcurrencyLimit(2, "scope")).toBe(1);

  let secondReleased = false;
  const second = policy.waitForAttempt("scope:another").then(value => {
    secondReleased = true;
    return value;
  });
  await Promise.resolve();
  expect(secondReleased).toBeFalse();

  policy.recordSubmissionAccepted("scope:probe");
  expect(policy.circuitSnapshot("scope")).toMatchObject({ state: "CLOSED", failures: 0 });
  expect(policy.operationalConcurrencyLimit(2, "scope")).toBe(2);
  await expect(second).resolves.toMatchObject({ circuitState: "CLOSED", halfOpenProbe: false });
});

test("repeated account pressure backs off with 15s/30s/60s cooldowns", async () => {
  let now = 0;
  const sleeps: number[] = [];
  const policy = new ChatGptWebTurnRetryPolicy(30 * 60_000, {
    now: () => now,
    random: () => 0.5,
    sleep: async ms => { sleeps.push(ms); now += ms; },
  });

  for (const expected of [15_000, 30_000, 60_000]) {
    policy.recordRetryableFailure("scope:probe", rateLimitError(undefined, true));
    await policy.waitForAttempt("scope:probe");
    expect(sleeps.at(-1)).toBe(expected);
  }
});

test("recovery taxonomy makes submission phase authoritative for resubmission", () => {
  expect(classifyChatGptRecovery(transientError(), { submissionPhase: "prepared" })).toMatchObject({
    class: "CHATGPT_TRANSIENT_SERVER_ERROR",
    retryable: true,
    mayResubmit: true,
  });
  expect(classifyChatGptRecovery(transientError(), { submissionPhase: "send_activated" })).toMatchObject({
    class: "CHATGPT_TRANSIENT_SERVER_ERROR",
    retryable: false,
    mayResubmit: false,
    preserveBrowserOwner: false,
    preserveTools: false,
    terminal: true,
  });
  expect(classifyChatGptRecovery(rateLimitError(7_000, true), { submissionPhase: "send_activated" })).toMatchObject({
    class: "CHATGPT_RATE_LIMITED",
    retryable: true,
    mayResubmit: true,
    cooldownRequired: true,
  });
  expect(classifyChatGptRecovery(rateLimitError(), { submissionPhase: "send_activated" })).toMatchObject({
    class: "CHATGPT_RATE_LIMITED",
    retryable: false,
    mayResubmit: false,
  });
  expect(classifyChatGptRecovery(new Error("observer detached"), {
    submissionPhase: "accepted",
    clientDisconnected: true,
  })).toMatchObject({
    class: "CLIENT_STREAM_DISCONNECTED",
    terminal: false,
    mayResubmit: false,
    preserveBrowserOwner: true,
    preserveTools: true,
  });
  expect(classifyChatGptRecovery(new Error("CDP transport lost"), {
    submissionPhase: "accepted",
    hint: "CDP_SESSION_LOST",
  })).toMatchObject({
    class: "CDP_SESSION_LOST",
    mayReconnectObserver: true,
    mayReconnectCdp: true,
    mayResubmit: false,
  });
  expect(classifyChatGptRecovery(new ChatGptRecoveryExhaustedError(
    "CDP_SESSION_LOST",
    "same-owner CDP recovery exhausted",
  ), { submissionPhase: "accepted" })).toMatchObject({
    class: "CDP_SESSION_LOST",
    retryable: false,
    mayResubmit: false,
    mayReconnectObserver: false,
    mayReconnectCdp: false,
    preserveBrowserOwner: false,
    preserveTools: false,
    terminal: true,
  });
});
