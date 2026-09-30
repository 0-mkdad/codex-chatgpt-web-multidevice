import { skillFileTokens } from "./skill-attachments";
import { estimateTokens, estimateTokensForTransportValidation } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebSafeComposerCharLimit,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import {
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebInputTokens,
  estimateCompiledChatGptWebMultipartPrefixTokens,
  estimateCompiledChatGptWebTransportInputTokens,
} from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
  type ChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";
import {
  chatGptWebBaseContextWindow,
  chatGptWebCurrentPolicySafeMessageTokenBudget,
  emitChatGptWebTransportPolicyDecision,
} from "./transport-policy-vb";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction always receives all six parts without passing through the legacy inline budget.
 *
 * V-B experiment (2026-09-25): the planner is restored to the v6.1.0 policy and never rejects a
 * transportable history. The stricter post-v6.1.0 policy is evaluated as a shadow and only logged
 * (see transport_policy_vb events) so a live A/B can compare both verdicts on real conversations.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const { contextWindow, autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const logical = resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, mode.effort, capabilities);
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    { experimentalMultipartParts: parts, experimentalSkillAttachments },
  );
  const compiledMemo = new Map<string, CompiledChatGptWebPrompt>();
  const compiledOnce = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => {
    const key = parts === undefined ? "inline" : String(parts);
    const existing = compiledMemo.get(key);
    if (existing) return existing;
    const value = compile(parts);
    compiledMemo.set(key, value);
    return value;
  };
  // Inert stages may use any explicitly available staging effort; execution keeps the chosen
  // effort. These are the widest stage modes used by the browser's existing selector.
  const stagingEffort = capabilities.proAvailable ? "max" : "medium";

  // v6.1.0 planning policy (authoritative in V-B): raw budgets and a cumulative allowance of the
  // base window scaled by the message count, capped at the Bigger Context multiplier.
  const vbFits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
      < contextWindow * Math.min(messages.length, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
  };

  // Shadow evaluation of the stricter post-v6.1.0 policy. Mirrors the shipped pre-V-B resolver,
  // including its conservative budgets, but only reports the verdict it would have produced.
  const currentPolicy = (): {
    verdict: string;
    reason?: string;
    maxCumulativeStageInputTokens?: number;
    stagingContextWindow?: number;
    finalCumulativeInputTokens?: number;
  } => {
    const stagingContextWindow = chatGptWebBaseContextWindow(CHATGPT_WEB_BACKEND_MODEL, stagingEffort, capabilities);
    const currentFits = (compiled: CompiledChatGptWebPrompt): boolean => {
      const messages = compiledChatGptWebMessages(compiled);
      for (const [index, text] of messages.entries()) {
        const final = index === messages.length - 1;
        const effort = final ? mode.effort : stagingEffort;
        const safeComposerCharLimit = resolveChatGptWebSafeComposerCharLimit(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
        if (safeComposerCharLimit !== undefined && text.length > safeComposerCharLimit) return false;
        const budget = chatGptWebCurrentPolicySafeMessageTokenBudget(
          CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
        );
        if (estimateTokensForTransportValidation(text, parsed.modelId) > budget) return false;
      }
      const multipartPrefix = estimateCompiledChatGptWebMultipartPrefixTokens(compiled, parsed.modelId);
      if (!multipartPrefix) {
        return estimateCompiledChatGptWebTransportInputTokens(compiled, parsed.modelId) < contextWindow;
      }
      return multipartPrefix.maxCumulativeStageInputTokens < stagingContextWindow
        && multipartPrefix.finalCumulativeInputTokens < contextWindow;
    };
    const prefixNumbers = (compiled: CompiledChatGptWebPrompt) => {
      const prefix = estimateCompiledChatGptWebMultipartPrefixTokens(compiled, parsed.modelId);
      return {
        maxCumulativeStageInputTokens: prefix?.maxCumulativeStageInputTokens,
        stagingContextWindow: prefix ? stagingContextWindow : undefined,
        finalCumulativeInputTokens: prefix?.finalCumulativeInputTokens,
      };
    };
    try {
      if (parsed._compactionRequest) {
        const compiled = compiledOnce(CHATGPT_BIGGER_CONTEXT_PARTS);
        if (currentFits(compiled)) {
          return { verdict: String(CHATGPT_BIGGER_CONTEXT_PARTS), ...prefixNumbers(compiled) };
        }
        return {
          verdict: "reject",
          reason: "current policy: compaction staging budgets exceeded",
          ...prefixNumbers(compiled),
        };
      }
      const inline = compiledOnce();
      const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
      const initialParts = biggerContextPartCount(inputTokens, autoCompactTokenLimit, false);
      if (initialParts === undefined && currentFits(inline)) return { verdict: "single" };
      const candidateParts: readonly ChatGptWebMultipartPartCount[] = initialParts === CHATGPT_BIGGER_CONTEXT_PARTS
        ? [CHATGPT_BIGGER_CONTEXT_PARTS]
        : [2, CHATGPT_BIGGER_CONTEXT_PARTS];
      for (const parts of candidateParts) {
        const compiled = compiledOnce(parts);
        if (currentFits(compiled)) {
          return { verdict: String(parts), ...prefixNumbers(compiled) };
        }
      }
      return {
        verdict: "reject",
        reason: "current policy: no candidate fits the conservative budgets",
        ...prefixNumbers(compiledOnce(CHATGPT_BIGGER_CONTEXT_PARTS)),
      };
    } catch (error) {
      return { verdict: "error", reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const emitDecision = (
    phase: "plan" | "compaction-plan",
    chosenParts: number | "single",
    vbVerdict: string,
  ): void => {
    const chosen = chosenParts === "single" ? compiledOnce() : compiledOnce(chosenParts as ChatGptWebMultipartPartCount);
    const chosenMessages = compiledChatGptWebMessages(chosen).length;
    const shadow = currentPolicy();
    emitChatGptWebTransportPolicyDecision({
      phase,
      logicalContextWindow: logical.contextWindow,
      logicalAutoCompactTokenLimit: logical.autoCompactTokenLimit,
      baseContextWindow: contextWindow,
      chosenParts,
      vbVerdict,
      vbCumulativeAllowance: contextWindow * Math.min(chosenMessages, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER),
      vbEstimatedCumulativeInputTokens: estimateCompiledChatGptWebInputTokens(chosen, parsed.modelId),
      currentVerdict: shadow.verdict,
      currentRejectReason: shadow.reason,
      currentMaxCumulativeStageInputTokens: shadow.maxCumulativeStageInputTokens,
      currentStagingContextWindow: shadow.stagingContextWindow,
      currentFinalCumulativeInputTokens: shadow.finalCumulativeInputTokens,
    });
  };

  if (parsed._compactionRequest) {
    emitDecision("compaction-plan", CHATGPT_BIGGER_CONTEXT_PARTS, String(CHATGPT_BIGGER_CONTEXT_PARTS));
    return CHATGPT_BIGGER_CONTEXT_PARTS;
  }

  const inline = compiledOnce();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, autoCompactTokenLimit, false);
  if (initialParts === CHATGPT_BIGGER_CONTEXT_PARTS) {
    emitDecision("plan", CHATGPT_BIGGER_CONTEXT_PARTS, String(CHATGPT_BIGGER_CONTEXT_PARTS));
    return initialParts;
  }
  if (initialParts === undefined && vbFits(inline)) {
    emitDecision("plan", "single", "single");
    return undefined;
  }
  const chosen: ChatGptWebMultipartPartCount = vbFits(compiledOnce(2)) ? 2 : CHATGPT_BIGGER_CONTEXT_PARTS;
  emitDecision("plan", chosen, String(chosen));
  return chosen;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
): CodexUsage {
  // This usage feeds Codex's own native context manager. Always estimate the canonical Responses
  // history passed to this function; a checkpoint+delta is only a browser transport optimization
  // and does not remove superseded items from Codex's active context.
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    experimentalSkillAttachments,
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, experimentalSkillAttachments)
      : undefined,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
