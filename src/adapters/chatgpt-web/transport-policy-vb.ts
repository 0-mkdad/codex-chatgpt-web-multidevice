import { emitChatGptWebStructuredTrace } from "./structured-trace";
import {
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  CHATGPT_WEB_PLUS_REASONING_MESSAGE_TOKEN_LIMIT,
  CHATGPT_WEB_TRANSPORT_TOKEN_SAFETY_MARGIN,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
  type ChatGptWebAccountCapabilities,
  type ChatGptWebBackendModel,
} from "../../chatgpt-web-models";

/**
 * V-B experiment (2026-09-25). When true, Bigger Context planning and browser preflight use the
 * v6.1.0 transport semantics: per-stage budgets from resolveChatGptWebMessageTokenBudget (raw
 * measured boundaries, no extra margins) and a cumulative transport allowance of
 * baseContextWindow * min(partCount, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER). The stricter
 * post-v6.1.0 policy is still evaluated as a shadow and logged for comparison; it never gates a
 * submission while this flag is true. Flip to false to restore the stricter policy without any
 * further code changes.
 */
export const CHATGPT_WEB_TRANSPORT_POLICY_VB = true;

/**
 * Per-message transport token cap exactly as the stricter (pre-V-B) policy resolved it, including
 * the 32,000-token Plus Medium/High edge that the V-B transport limits no longer enforce.
 */
function currentPolicyTransportTokenLimit(
  backendModel: ChatGptWebBackendModel,
  effort: "low" | "medium" | "high" | "xhigh" | "max",
  capabilities: ChatGptWebAccountCapabilities,
): number | undefined {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) return undefined;
  const plusMediumHigh = !capabilities.proAvailable
    && (effort === "medium" || effort === "high" || (effort === "xhigh" && capabilities.extraHighAvailable));
  if (plusMediumHigh) return CHATGPT_WEB_PLUS_REASONING_MESSAGE_TOKEN_LIMIT;
  return resolveChatGptWebTransportLimits(backendModel, effort, capabilities).browserMessageTokenLimit;
}

/** Safe one-message budget exactly as the stricter (pre-V-B) policy computed it. */
export function chatGptWebCurrentPolicySafeMessageTokenBudget(
  backendModel: ChatGptWebBackendModel,
  effort: "low" | "medium" | "high" | "xhigh" | "max",
  capabilities: ChatGptWebAccountCapabilities,
  imageTokens = 0,
): number {
  const { contextWindow } = resolveChatGptWebContextLimits(
    backendModel, effort, { ...capabilities, experimentalBiggerContext: false },
  );
  const tokenLimit = currentPolicyTransportTokenLimit(backendModel, effort, capabilities);
  return Math.max(0, Math.min(
    contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - imageTokens - 1,
    tokenLimit ?? Infinity,
  ) - CHATGPT_WEB_TRANSPORT_TOKEN_SAFETY_MARGIN);
}

/** Base (unmultiplied) context window for the model/effort, used by the cumulative gates. */
export function chatGptWebBaseContextWindow(
  backendModel: ChatGptWebBackendModel,
  effort: "low" | "medium" | "high" | "xhigh" | "max",
  capabilities: ChatGptWebAccountCapabilities,
): number {
  return resolveChatGptWebContextLimits(
    backendModel, effort, { ...capabilities, experimentalBiggerContext: false },
  ).contextWindow;
}

export interface ChatGptWebTransportPolicyDecision {
  phase: "plan" | "compaction-plan" | "compaction-trim" | "preflight";
  logicalContextWindow: number;
  logicalAutoCompactTokenLimit: number;
  baseContextWindow: number;
  chosenParts?: number | "single";
  vbVerdict?: string;
  vbCumulativeAllowance?: number;
  vbEstimatedCumulativeInputTokens?: number;
  currentVerdict?: string;
  currentRejectReason?: string;
  currentMaxCumulativeStageInputTokens?: number;
  currentStagingContextWindow?: number;
  currentFinalCumulativeInputTokens?: number;
  perStage?: Array<{
    part: number;
    kind: "stage" | "final";
    tokens: number;
    chars: number;
    vbBudgetTokens?: number;
    currentBudgetTokens?: number;
  }>;
  compaction?: {
    encodedJsonBytes: number;
    byteBudget: number;
    trimmedMessages: number;
  };
}

/**
 * V-B comparison log. Records numbers and verdicts only; never prompt or response content.
 */
export function emitChatGptWebTransportPolicyDecision(
  decision: ChatGptWebTransportPolicyDecision,
): void {
  console.info(`[chatgpt-web] transport_policy_vb ${JSON.stringify(decision)}`);
  emitChatGptWebStructuredTrace("transport_policy_vb", {
    policy: CHATGPT_WEB_TRANSPORT_POLICY_VB ? "vb-legacy" : "current",
    ...decision,
  });
}
