import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens, estimateTokensForTransportValidation } from "../../lib/token-estimate";
import {
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type ChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
} from "./prompt";

/**
 * The Free/Luna product accepted measured browser inputs at 25,400 and 28,547 estimated tokens,
 * but rejected the same shape at 32,283 before producing a response. This is a ChatGPT browser
 * transport boundary, not Luna's model context window, and applies to normal and checkpoint turns.
 */
export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 28_000;

const TOKEN_ESTIMATE_TRANSACTION = `ctx_${"0".repeat(32)}`;

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt): string[] {
  if (!compiled.multipart) return [compiled.text];
  return [
    ...compiled.multipart.parts.slice(0, -1).map((payload, index) => (
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).text
    )),
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
  ];
}

export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(message => message.length));
}

export interface ChatGptWebMultipartPrefixTokens {
  stageMessageTokens: readonly number[];
  acknowledgementTokens: readonly number[];
  cumulativeStageInputTokens: readonly number[];
  maxStageMessageTokens: number;
  maxCumulativeStageInputTokens: number;
  finalMessageTokens: number;
  finalCumulativeInputTokens: number;
}

/**
 * Conservative physical transcript size for a multipart transaction. Every later request sees
 * all prior stage messages plus their assistant acknowledgements inside the same conversation.
 */
export function estimateChatGptWebMultipartPrefixTokens(
  stages: readonly ChatGptWebMultipartStage[],
  finalMessage: string,
  modelId: string,
  finalSkillTokens = 0,
  finalImageTokens = 0,
): ChatGptWebMultipartPrefixTokens {
  let cumulativeInputTokens = CHATGPT_WEB_PLATFORM_RESERVE_TOKENS;
  const stageMessageTokens: number[] = [];
  const acknowledgementTokens: number[] = [];
  const cumulativeStageInputTokens: number[] = [];
  for (const stage of stages) {
    const stageTokens = estimateTokensForTransportValidation(stage.text, modelId);
    stageMessageTokens.push(stageTokens);
    cumulativeInputTokens += stageTokens;
    cumulativeStageInputTokens.push(cumulativeInputTokens);
    const ackTokens = estimateTokensForTransportValidation(stage.acknowledgement, modelId);
    acknowledgementTokens.push(ackTokens);
    cumulativeInputTokens += ackTokens;
  }
  const finalMessageTokens = estimateTokensForTransportValidation(finalMessage, modelId) + finalSkillTokens;
  return {
    stageMessageTokens,
    acknowledgementTokens,
    cumulativeStageInputTokens,
    maxStageMessageTokens: stageMessageTokens.length ? Math.max(...stageMessageTokens) : 0,
    maxCumulativeStageInputTokens: cumulativeStageInputTokens.length
      ? Math.max(...cumulativeStageInputTokens)
      : CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    finalMessageTokens,
    finalCumulativeInputTokens: cumulativeInputTokens + finalMessageTokens + finalImageTokens,
  };
}

export function estimateCompiledChatGptWebMultipartPrefixTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): ChatGptWebMultipartPrefixTokens | undefined {
  if (!compiled.multipart) return undefined;
  const stages = compiled.multipart.parts.slice(0, -1).map((payload, index) => (
    formatChatGptWebMultipartStage(
      payload,
      TOKEN_ESTIMATE_TRANSACTION,
      index + 1,
      compiled.multipart!.parts.length,
    )
  ));
  return estimateChatGptWebMultipartPrefixTokens(
    stages,
    formatChatGptWebMultipartCommit(compiled.multipart, TOKEN_ESTIMATE_TRANSACTION),
    modelId,
    skillFileTokens(compiled.skillFiles, modelId),
    estimateChatGptWebImageTokens(compiled),
  );
}

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const messages = compiledChatGptWebMessages(compiled);
  return Math.max(...messages.map((message, index) => estimateTokens(message, modelId)
    + (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0)));
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const messageTokens = compiledChatGptWebMessages(compiled)
    .reduce((total, message) => total + estimateTokens(message, modelId), 0);
  const acknowledgementTokens = compiled.multipart
    ? compiled.multipart.parts.slice(0, -1).reduce((total, payload, index) => total + estimateTokens(
      formatChatGptWebMultipartStage(
        payload,
        TOKEN_ESTIMATE_TRANSACTION,
        index + 1,
        compiled.multipart!.parts.length,
      ).acknowledgement,
      modelId,
    ), 0)
    : 0;
  // Large Full-mode turns keep the canonical context out of the composer and deliver it through
  // MCP context chunks instead. It still enters the model context and must therefore count
  // toward Codex usage/compaction decisions even though the visible browser message is small.
  const mcpContextTokens = compiled.contextTransport
    ? estimateTokens(compiled.contextTransport.text, modelId)
    : 0;
  return CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + messageTokens + acknowledgementTokens
    + mcpContextTokens + imageTokens + skillFileTokens(compiled.skillFiles, modelId);
}

/** Conservative token count for physical browser context validation, including every wrapper. */
export function estimateCompiledChatGptWebTransportInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const multipartPrefix = estimateCompiledChatGptWebMultipartPrefixTokens(compiled, modelId);
  if (multipartPrefix) return multipartPrefix.finalCumulativeInputTokens;
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const messages = compiledChatGptWebMessages(compiled);
  const messageTokens = messages.reduce(
    (total, message) => total + estimateTokensForTransportValidation(message, modelId),
    0,
  );
  return CHATGPT_WEB_PLATFORM_RESERVE_TOKENS
    + messageTokens
    + imageTokens
    + skillFileTokens(compiled.skillFiles, modelId);
}

/** Conservative count of the largest complete composer message, including its attachments. */
export function estimateCompiledChatGptWebTransportMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const messages = compiledChatGptWebMessages(compiled);
  return Math.max(...messages.map((message, index) => estimateTokensForTransportValidation(message, modelId)
    + (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0)));
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}
