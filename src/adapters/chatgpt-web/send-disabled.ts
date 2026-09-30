import { ChatGptWebAdapterError } from "./adapter-error";

/**
 * Explicit reason taxonomy for the moment the ChatGPT send control never enables after the
 * complete prompt was attached. Before this module the failure surfaced as a generic error and
 * the generic recovery layer retried blind (3 retries + backoff) even when retrying could not
 * help. The classifier never claims certainty the DOM cannot provide: text-derived notices are
 * `inferred`, presence probes are `directly_observed`, and anything else stays `unknown`.
 */
export type ChatGptSendDisabledReason =
  | "usage_exhausted"
  | "rate_limited"
  | "composer_busy"
  | "model_unavailable"
  | "account_restricted"
  | "provider_unavailable"
  | "dom_regression"
  | "unknown_send_disabled";

export type ChatGptSendDisabledEvidence = "directly_observed" | "inferred" | "unknown";

export interface ChatGptSendDisabledObservations {
  /** The send control is still attached and rendered (directly observed). */
  sendButtonAttached: boolean;
  /** A visible usage/limit notice (DOM text claim — never certainty). */
  usageLimitNoticeVisible?: boolean;
  /** A visible rate-limit dialog or equivalent (directly observed surface). */
  rateLimitNoticeVisible?: boolean;
  /** A visible model/effort unavailable notice. */
  modelUnavailableNoticeVisible?: boolean;
  /** A visible account/subscription restriction notice. */
  accountRestrictedNoticeVisible?: boolean;
  /** A visible provider/capacity outage notice. */
  providerUnavailableNoticeVisible?: boolean;
  /** A visible streaming/busy indicator on the composer (directly observed). */
  streamingIndicatorVisible?: boolean;
}

export interface ChatGptSendDisabledClassification {
  reason: ChatGptSendDisabledReason;
  evidence: ChatGptSendDisabledEvidence;
  retryable: boolean;
}

/**
 * Precedence: notices (what ChatGPT says) before structural probes (what is rendered) before the
 * unknown fallback. `usage_exhausted` is deliberately `inferred` (a DOM notice is a claim, not a
 * metering fact) and deliberately non-retryable: no generic recovery loop may burn retries
 * against a quota that will not return within the retry budget. Quota recovery stays
 * event/timer based elsewhere; this module only stops the blind loop.
 */
export function classifyChatGptSendDisabled(
  observations: ChatGptSendDisabledObservations,
): ChatGptSendDisabledClassification {
  if (observations.usageLimitNoticeVisible === true) {
    return { reason: "usage_exhausted", evidence: "inferred", retryable: false };
  }
  if (observations.rateLimitNoticeVisible === true) {
    return { reason: "rate_limited", evidence: "directly_observed", retryable: true };
  }
  if (observations.modelUnavailableNoticeVisible === true) {
    return { reason: "model_unavailable", evidence: "directly_observed", retryable: true };
  }
  if (observations.accountRestrictedNoticeVisible === true) {
    return { reason: "account_restricted", evidence: "inferred", retryable: false };
  }
  if (observations.providerUnavailableNoticeVisible === true) {
    return { reason: "provider_unavailable", evidence: "inferred", retryable: true };
  }
  if (observations.sendButtonAttached === false) {
    return { reason: "dom_regression", evidence: "directly_observed", retryable: false };
  }
  if (observations.streamingIndicatorVisible === true) {
    return { reason: "composer_busy", evidence: "directly_observed", retryable: true };
  }
  return { reason: "unknown_send_disabled", evidence: "unknown", retryable: true };
}

export function chatGptSendDisabledError(
  classification: ChatGptSendDisabledClassification,
): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT send remained disabled after the complete prompt was attached `
      + `(reason: ${classification.reason}, evidence: ${classification.evidence})`,
    {
      status: 503,
      errorType: "server_error",
      code: classification.reason,
      retryable: classification.retryable,
    },
  );
}
