import { ChatGptWebAdapterError } from "./adapter-error";

export type ChatGptSubmissionPhase = "prepared" | "send_activated" | "accepted";

export type ChatGptRecoveryClass =
  | "PRE_SUBMISSION_FAILURE"
  | "SUBMISSION_AMBIGUOUS"
  | "TURN_ACCEPTED"
  | "STREAM_OBSERVER_LOST"
  | "CDP_SESSION_LOST"
  | "DOM_TEMPORARILY_UNRESPONSIVE"
  | "CHATGPT_RESPONSE_STALLED"
  | "MCP_PROGRESS_STALLED"
  | "TUNNEL_NOT_READY"
  | "TUNNEL_TRANSPORT_LOST"
  | "CHATGPT_RATE_LIMITED"
  | "CHATGPT_TRANSIENT_SERVER_ERROR"
  | "CHATGPT_TERMINAL_ERROR"
  | "CLIENT_STREAM_DISCONNECTED"
  | "TURN_CANCELLED";

export interface ChatGptRecoveryDecision {
  class: ChatGptRecoveryClass;
  retryable: boolean;
  mayResubmit: boolean;
  mayReconnectObserver: boolean;
  mayReconnectCdp: boolean;
  preserveBrowserOwner: boolean;
  preserveTools: boolean;
  cooldownRequired: boolean;
  terminal: boolean;
}

export interface ChatGptRecoveryContext {
  submissionPhase?: ChatGptSubmissionPhase;
  hint?: ChatGptRecoveryClass;
  clientDisconnected?: boolean;
}

function postSend(phase: ChatGptSubmissionPhase | undefined): boolean {
  return phase === "send_activated" || phase === "accepted";
}

function decision(
  recoveryClass: ChatGptRecoveryClass,
  phase: ChatGptSubmissionPhase | undefined,
  options: Partial<Omit<ChatGptRecoveryDecision, "class" | "mayResubmit">> & {
    mayResubmit?: boolean;
  } = {},
): ChatGptRecoveryDecision {
  const sent = postSend(phase);
  return {
    class: recoveryClass,
    retryable: options.retryable ?? false,
    mayResubmit: options.mayResubmit ?? false,
    mayReconnectObserver: options.mayReconnectObserver ?? false,
    mayReconnectCdp: options.mayReconnectCdp ?? false,
    preserveBrowserOwner: options.preserveBrowserOwner ?? sent,
    preserveTools: options.preserveTools ?? sent,
    cooldownRequired: options.cooldownRequired ?? false,
    terminal: options.terminal ?? true,
  };
}

function hintedDecision(
  hint: ChatGptRecoveryClass,
  phase: ChatGptSubmissionPhase | undefined,
): ChatGptRecoveryDecision {
  const sent = postSend(phase);
  switch (hint) {
    case "STREAM_OBSERVER_LOST":
    case "DOM_TEMPORARILY_UNRESPONSIVE":
      return decision(hint, phase, {
        retryable: true,
        mayResubmit: !sent,
        mayReconnectObserver: sent,
        mayReconnectCdp: sent,
        terminal: !sent,
      });
    case "CDP_SESSION_LOST":
      return decision(hint, phase, {
        retryable: true,
        mayResubmit: !sent,
        mayReconnectObserver: sent,
        mayReconnectCdp: true,
        terminal: !sent,
      });
    case "CHATGPT_RESPONSE_STALLED":
    case "MCP_PROGRESS_STALLED":
      return decision(hint, phase, {
        retryable: !sent,
        mayResubmit: !sent,
        mayReconnectObserver: sent,
        mayReconnectCdp: sent,
        terminal: true,
      });
    case "TUNNEL_NOT_READY":
    case "TUNNEL_TRANSPORT_LOST":
      return decision(hint, phase, {
        retryable: !sent,
        mayResubmit: !sent,
        preserveBrowserOwner: sent,
        preserveTools: sent,
        terminal: !sent,
      });
    default:
      return decision(hint, phase);
  }
}

/**
 * Converts the existing heterogeneous error surface into a small set of recovery decisions.
 * Submission phase always wins over provider retryability for resend safety.
 */
export function classifyChatGptRecovery(
  error: unknown,
  context: ChatGptRecoveryContext = {},
): ChatGptRecoveryDecision {
  const phase = context.submissionPhase;
  const sent = postSend(phase);

  if (context.clientDisconnected) {
    return decision("CLIENT_STREAM_DISCONNECTED", phase, {
      retryable: !sent,
      mayResubmit: !sent,
      preserveBrowserOwner: sent,
      preserveTools: sent,
      terminal: !sent,
    });
  }
  if (context.hint) return hintedDecision(context.hint, phase);

  if (error instanceof DOMException && error.name === "AbortError") {
    return decision("TURN_CANCELLED", phase, {
      preserveBrowserOwner: false,
      preserveTools: false,
    });
  }

  if (error instanceof ChatGptWebAdapterError) {
    if (error.code === "rate_limit_exceeded" || error.status === 429) {
      const safeResubmit = !sent || error.submissionRejected;
      return decision("CHATGPT_RATE_LIMITED", phase, {
        retryable: error.retryable && safeResubmit,
        mayResubmit: error.retryable && safeResubmit,
        cooldownRequired: true,
      });
    }
    if (
      error.retryable
      && (error.status === 500
        || error.status === 502
        || error.status === 503
        || error.status === 504
        || error.code === "upstream_server_error"
        || error.code === "chatgpt_subscription_unavailable")
    ) {
      const safeResubmit = !sent || error.submissionRejected;
      return decision("CHATGPT_TRANSIENT_SERVER_ERROR", phase, {
        retryable: error.retryable && safeResubmit,
        mayResubmit: error.retryable && safeResubmit,
      });
    }
    return decision("CHATGPT_TERMINAL_ERROR", phase);
  }

  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "ChatGptBrowserObservationTimeoutError") {
    return hintedDecision("DOM_TEMPORARILY_UNRESPONSIVE", phase);
  }
  if (/CDP|Target page|Target closed|browser.*transport/i.test(message)) {
    return hintedDecision("CDP_SESSION_LOST", phase);
  }
  if (/tunnel.*not ready/i.test(message)) {
    return hintedDecision("TUNNEL_NOT_READY", phase);
  }
  if (/tunnel.*(disconnect|transport|closed|lost)/i.test(message)) {
    return hintedDecision("TUNNEL_TRANSPORT_LOST", phase);
  }

  if (phase === "send_activated") {
    return decision("SUBMISSION_AMBIGUOUS", phase, {
      preserveBrowserOwner: true,
      preserveTools: true,
    });
  }
  if (phase === "accepted") {
    return decision("TURN_ACCEPTED", phase, {
      preserveBrowserOwner: true,
      preserveTools: true,
    });
  }
  return decision("PRE_SUBMISSION_FAILURE", phase, {
    retryable: true,
    mayResubmit: true,
    preserveBrowserOwner: false,
    preserveTools: false,
  });
}
