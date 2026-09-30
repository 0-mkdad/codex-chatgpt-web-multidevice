import { describe, expect, test } from "bun:test";
import {
  chatGptSendDisabledError,
  classifyChatGptSendDisabled,
} from "../src/adapters/chatgpt-web/send-disabled";
import { classifyChatGptRecovery } from "../src/adapters/chatgpt-web/recovery-classification";

/**
 * v6.1.11 send-disabled reason taxonomy. The deadline path (send button never enables after the
 * full prompt is attached) previously threw a plain Error, so the generic recovery layer retried
 * blind. These fixtures pin the reason/evidence/retryable matrix and the recovery gate: a
 * quota-exhausted classification must never enter the generic retry loop, and an unknown state
 * must never be reported as a confirmed cause.
 */
describe("send-disabled classification", () => {
  test("usage exhausted is inferred and non-retryable", () => {
    const classification = classifyChatGptSendDisabled({
      sendButtonAttached: true,
      usageLimitNoticeVisible: true,
    });
    expect(classification).toEqual({ reason: "usage_exhausted", evidence: "inferred", retryable: false });
  });

  test("rate limit is directly observed and stays retryable through the circuit", () => {
    const classification = classifyChatGptSendDisabled({
      sendButtonAttached: true,
      rateLimitNoticeVisible: true,
    });
    expect(classification).toEqual({ reason: "rate_limited", evidence: "directly_observed", retryable: true });
  });

  test("streaming composer busy is directly observed and retryable", () => {
    const classification = classifyChatGptSendDisabled({
      sendButtonAttached: true,
      streamingIndicatorVisible: true,
    });
    expect(classification).toEqual({ reason: "composer_busy", evidence: "directly_observed", retryable: true });
  });

  test("model unavailable is directly observed and retryable", () => {
    const classification = classifyChatGptSendDisabled({
      sendButtonAttached: true,
      modelUnavailableNoticeVisible: true,
    });
    expect(classification).toEqual({ reason: "model_unavailable", evidence: "directly_observed", retryable: true });
  });

  test("missing send control is a directly observed DOM regression and non-retryable", () => {
    const classification = classifyChatGptSendDisabled({ sendButtonAttached: false });
    expect(classification).toEqual({ reason: "dom_regression", evidence: "directly_observed", retryable: false });
  });

  test("generic unknown state stays unknown and is never promoted to a confirmed cause", () => {
    const classification = classifyChatGptSendDisabled({ sendButtonAttached: true });
    expect(classification).toEqual({ reason: "unknown_send_disabled", evidence: "unknown", retryable: true });
    const error = chatGptSendDisabledError(classification);
    expect(error.code).toBe("unknown_send_disabled");
    expect(error.message).toContain("evidence: unknown");
    expect(error.message).not.toContain("quota");
  });

  test("account and provider restrictions are inferred from notices with their own retryability", () => {
    expect(classifyChatGptSendDisabled({
      sendButtonAttached: true,
      accountRestrictedNoticeVisible: true,
    })).toEqual({ reason: "account_restricted", evidence: "inferred", retryable: false });
    expect(classifyChatGptSendDisabled({
      sendButtonAttached: true,
      providerUnavailableNoticeVisible: true,
    })).toEqual({ reason: "provider_unavailable", evidence: "inferred", retryable: true });
  });

  test("usage_exhausted never enters the generic retry loop via the recovery classifier", () => {
    const error = chatGptSendDisabledError(classifyChatGptSendDisabled({
      sendButtonAttached: true,
      usageLimitNoticeVisible: true,
    }));
    expect(error.retryable).toBe(false);
    const recovery = classifyChatGptRecovery(error, { submissionPhase: "prepared" });
    expect(recovery.class).toBe("CHATGPT_TERMINAL_ERROR");
    expect(recovery.mayResubmit).toBe(false);
    // The adapter's retry gate is retryable && mayResubmit — both false here.
  });

  test("retryable send-disabled reasons keep the transient pre-send retry path", () => {
    for (const observations of [
      { sendButtonAttached: true, streamingIndicatorVisible: true },
      { sendButtonAttached: true, modelUnavailableNoticeVisible: true },
      { sendButtonAttached: true },
    ]) {
      const error = chatGptSendDisabledError(classifyChatGptSendDisabled(observations));
      expect(error.retryable).toBe(true);
      const recovery = classifyChatGptRecovery(error, { submissionPhase: "prepared" });
      expect(recovery.class).toBe("CHATGPT_TRANSIENT_SERVER_ERROR");
      expect(recovery.mayResubmit).toBe(true);
    }
  });

  test("non-retryable reasons land in CHATGPT_TERMINAL_ERROR for every submission phase", () => {
    for (const phase of [undefined, "prepared"] as const) {
      const error = chatGptSendDisabledError(classifyChatGptSendDisabled({
        sendButtonAttached: false,
      }));
      const recovery = classifyChatGptRecovery(error, { submissionPhase: phase });
      expect(recovery.mayResubmit).toBe(false);
      expect(recovery.retryable).toBe(false);
    }
  });
});
