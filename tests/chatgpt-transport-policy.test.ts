import { expect, spyOn, test } from "bun:test";
import { ChatGptRecoveryExhaustedError, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  assertChatGptWebMultipartInputWithinLimits,
  chatGptMultipartLedgerAfterAck,
  classifyMultipartPreFinalFailure,
  eligibleForMultipartTransactionRestart,
  throwIfChatGptMessageTooLongToast,
} from "../src/adapters/chatgpt-web/browser-worker";
import { assertMultipartRestartSafety, submittedTurnFailure } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_INSTANT_STAGING_HEADROOM_TOKENS } from "../src/chatgpt-web-models";

const plusHigh = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
  experimentalBiggerContext: true,
};

test("six-part transactions near 200k and 261k are admitted by the upstream experimental ceiling", () => {
  // Live counterexamples that disprove the brief 6.1.3 70k whole-transaction envelope:
  // trace 218780a2065d completed a six-part transaction at ~261,776 formatted conservative
  // input; trace 76c3ba5b9b75 completed at ~163,769. The ceiling is the upstream
  // base × min(parts, 3) rule — 270k for six parts on the 90k Plus profile — and the failed
  // trace 003b96e77cf6 (~196k planned) sits inside it too.
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    196_074, 33_401, "gpt-5.6-sol", "high", plusHigh, 900_000, 6,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    261_776, 47_244, "gpt-5.6-sol", "high", plusHigh, 900_000, 6,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    163_769, 45_000, "gpt-5.6-sol", "high", plusHigh, 900_000, 6,
  )).not.toThrow();
  // Above the upstream ceiling the pre-send refusal remains (upstream code and message).
  let thrown: unknown;
  try {
    assertChatGptWebMultipartInputWithinLimits(
      270_001, 33_401, "gpt-5.6-sol", "high", plusHigh, 900_000, 6,
    );
  } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ChatGptWebAdapterError);
  expect((thrown as ChatGptWebAdapterError).code).toBe("context_length_exceeded");
  expect((thrown as ChatGptWebAdapterError).message).toContain("270,000-token");
});

test("Instant staging headroom is an operational margin, never a claimed provider limit", () => {
  expect(CHATGPT_WEB_INSTANT_STAGING_HEADROOM_TOKENS).toBe(1_024);
});

test("observable ACK ledger records measured acknowledgements, including smaller-than-planned ones", () => {
  // Live trace 003b96e77cf6 stage 1: planned cumulative 41,411, actual ACK only 72 tokens —
  // far below the former ~200-token reserve — so the ledger must track the real measurement.
  expect(chatGptMultipartLedgerAfterAck(41_411, 72)).toBe(41_483);
  expect(chatGptMultipartLedgerAfterAck(41_411, 400)).toBe(41_811);
  expect(chatGptMultipartLedgerAfterAck(undefined, 72)).toBeUndefined();
  expect(chatGptMultipartLedgerAfterAck(41_411, undefined)).toBeUndefined();
});

const toastPage = (alertText: string | undefined) => ({
  locator: (selector: string) => ({
    filter: (options: { hasText: RegExp }) => ({
      first: () => ({
        isVisible: async () => {
          if (!selector.includes('aside[role="alert"]')) throw new Error(`unexpected selector ${selector}`);
          return alertText !== undefined && options.hasText.test(alertText);
        },
      }),
    }),
  }),
});

test("exact visible message-too-long toast becomes a deterministic nonretryable rejection", async () => {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const info = spyOn(console, "info").mockImplementation(capture);
  const warn = spyOn(console, "warn").mockImplementation(capture);
  try {
    let thrown: unknown;
    try {
      await throwIfChatGptMessageTooLongToast(
        toastPage("The message you submitted was too long, please edit it and resubmit.") as never,
        { traceId: "trace-toast" },
      );
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ChatGptWebAdapterError);
    const adapterError = thrown as ChatGptWebAdapterError;
    expect(adapterError.code).toBe("chatgpt_message_too_long");
    expect(adapterError.status).toBe(400);
    expect(adapterError.retryable).toBe(false);
    expect(adapterError.submissionRejected).toBe(true);
    expect(lines.some(line => line.includes("chatgpt_visible_error_observed")
      && line.includes("message_too_long") && line.includes("trace-toast"))).toBe(true);
  } finally {
    info.mockRestore();
    warn.mockRestore();
  }
});

test("generic alerts never classify as message-too-long", async () => {
  for (const text of [
    "Something went wrong. Visit help.openai.com for help.",
    "The message you submitted was too longg, please edit it and resubmit.",
    "Please reduce the length of your message.",
  ]) {
    await expect(throwIfChatGptMessageTooLongToast(toastPage(text) as never)).resolves.toBeUndefined();
  }
  await expect(throwIfChatGptMessageTooLongToast(toastPage(undefined) as never)).resolves.toBeUndefined();
});

test("deterministic size verdicts surface themselves instead of the partial-failure wrapper", () => {
  const session = {
    runtime: { submission: { phase: "send_activated", lastAcknowledgedMultipartStage: 1 } },
  } as never;
  const messageTooLong = new ChatGptWebAdapterError("toast rejection", {
    status: 400, errorType: "invalid_request_error", code: "chatgpt_message_too_long",
    retryable: false, submissionRejected: true,
  });
  expect(submittedTurnFailure(session, messageTooLong)).toBe(messageTooLong);
  // Any other mid-multipart failure keeps the replay-safety wrapper and its cause.
  const generic = submittedTurnFailure(session, new Error("boom"));
  expect((generic as ChatGptWebAdapterError).code).toBe("chatgpt_multipart_partial_failure");
  expect((generic as ChatGptWebAdapterError).retryable).toBe(false);
});

test("pre-final failure classifier: transient transport classes are restartable", () => {
  // 1/2: ChatGPT's transient terminal UI (Something went wrong — live trace 79f75e1d6435 family)
  // mints upstream_server_error and is restartable before the final part.
  expect(classifyMultipartPreFinalFailure(new ChatGptWebAdapterError("terminal ui", {
    status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
  }))).toEqual({ classification: "restartable_transport", failureCategory: "something_went_wrong", errorCode: "upstream_server_error" });
  // 5: accepted-turn recovery failure on the owned surface (the historical 218 trace failure).
  expect(classifyMultipartPreFinalFailure(new ChatGptRecoveryExhaustedError(
    "CDP_SESSION_LOST",
    "ChatGPT could not recover the accepted turn on its owned browser surface",
  )).classification).toBe("restartable_transport");
  expect(classifyMultipartPreFinalFailure(new ChatGptRecoveryExhaustedError(
    "DOM_TEMPORARILY_UNRESPONSIVE",
    "ChatGPT accepted the message, but its DOM remained unresponsive",
  )).failureCategory).toBe("observation_recovery_failure");
  // 6: transient browser surface loss.
  expect(classifyMultipartPreFinalFailure(new ChatGptWebAdapterError("tab closed", {
    status: 499, errorType: "client_closed_request", code: "chatgpt_browser_tab_closed", retryable: false,
  })).classification).toBe("restartable_transport");
  // 7: size rejection stays restartable.
  expect(classifyMultipartPreFinalFailure(new ChatGptWebAdapterError("toast", {
    status: 400, errorType: "invalid_request_error", code: "chatgpt_message_too_long",
    retryable: false, submissionRejected: true,
  }))).toEqual({ classification: "restartable_transport", failureCategory: "message_too_long", errorCode: "chatgpt_message_too_long" });
  // 3/4: acknowledgement timeout family.
  expect(classifyMultipartPreFinalFailure(
    new Error("ChatGPT browser stage timed out: multipart_stage_4_acknowledgement"),
  ).failureCategory).toBe("stage_acknowledgement_timeout");
});

test("pre-final failure classifier: deterministic, security, and unknown failures never restart", () => {
  // 15: authentication.
  expect(classifyMultipartPreFinalFailure(new ChatGptWebAdapterError("expired", {
    status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false,
  }))).toEqual({ classification: "security_integrity", failureCategory: "authentication_required", errorCode: "chatgpt_session_expired" });
  // 12: user cancellation, both shapes.
  expect(classifyMultipartPreFinalFailure(new ChatGptWebAdapterError("cancelled", {
    status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false,
  })).classification).toBe("security_integrity");
  expect(classifyMultipartPreFinalFailure(new DOMException("aborted", "AbortError")).classification)
    .toBe("security_integrity");
  // 9/13/14/16: deterministic and unknown failures fail closed.
  for (const error of [
    new ChatGptWebAdapterError("budget", { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false }),
    new ChatGptWebAdapterError("stopped", { status: 502, errorType: "server_error", code: "chatgpt_stopped_thinking", retryable: false }),
    new ChatGptWebAdapterError("limited", { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true }),
    new Error("permission profile is inconsistent"),
    new Error("ChatGPT opened another user turn while the bound assistant response was detached"),
    new Error("boom"),
  ]) {
    expect(classifyMultipartPreFinalFailure(error).classification).not.toBe("restartable_transport");
  }
  expect(classifyMultipartPreFinalFailure(new Error("permission profile is inconsistent")).classification)
    .toBe("unknown_fail_closed");
});

test("single safe transaction restart: eligibility decision logic", () => {
  const sizeRejection = new ChatGptWebAdapterError("toast rejection", {
    status: 400, errorType: "invalid_request_error", code: "chatgpt_message_too_long",
    retryable: false, submissionRejected: true,
  });
  const ackTimeout = new Error("ChatGPT browser stage timed out: multipart_stage_2_acknowledgement");
  const wentWrong = new ChatGptWebAdapterError("terminal ui", {
    status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true,
  });
  // G: a first inert-stage failure of every restartable class qualifies.
  expect(eligibleForMultipartTransactionRestart(sizeRejection, 0, 0).eligible).toBe(true);
  expect(eligibleForMultipartTransactionRestart(ackTimeout, 0, 0).eligible).toBe(true);
  expect(eligibleForMultipartTransactionRestart(wentWrong, 0, 0).eligible).toBe(true);
  // H: the second failure is terminal — at most ONE automatic restart, no third attempt.
  expect(eligibleForMultipartTransactionRestart(sizeRejection, 1, 0)).toEqual({ eligible: false });
  expect(eligibleForMultipartTransactionRestart(wentWrong, 1, 0)).toEqual({ eligible: false });
  // I/J: any tool delivery (final execution activity) forbids the restart.
  expect(eligibleForMultipartTransactionRestart(sizeRejection, 0, 1)).toEqual({ eligible: false });
  expect(eligibleForMultipartTransactionRestart(ackTimeout, 0, 3)).toEqual({ eligible: false });
  // Everything else stays terminal: generic errors, stopped-thinking, aborts.
  expect(eligibleForMultipartTransactionRestart(new Error("boom"), 0, 0)).toEqual({ eligible: false });
  expect(eligibleForMultipartTransactionRestart(
    new ChatGptWebAdapterError("stopped", { status: 502, errorType: "server_error", code: "chatgpt_stopped_thinking", retryable: false }),
    0, 0,
  )).toEqual({ eligible: false });
  expect(eligibleForMultipartTransactionRestart(new DOMException("aborted", "AbortError"), 0, 0))
    .toEqual({ eligible: false });
});

test("journal reset safety proof is asserted, never assumed (fail closed)", () => {
  expect(() => assertMultipartRestartSafety({
    finalWasSent: false, toolsDelivered: 0, completionCommitted: false,
  })).not.toThrow();
  expect(() => assertMultipartRestartSafety({
    finalWasSent: true, toolsDelivered: 0, completionCommitted: false,
  })).toThrow(/execution safety proof violated/);
  expect(() => assertMultipartRestartSafety({
    finalWasSent: false, toolsDelivered: 1, completionCommitted: false,
  })).toThrow(/execution safety proof violated/);
  expect(() => assertMultipartRestartSafety({
    finalWasSent: false, toolsDelivered: 0, completionCommitted: true,
  })).toThrow(/execution safety proof violated/);
});
