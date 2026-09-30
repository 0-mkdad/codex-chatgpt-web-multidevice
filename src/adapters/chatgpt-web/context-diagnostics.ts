import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { estimateTokens, estimateTokensForTransportValidation } from "../../lib/token-estimate";
import { estimateChatGptWebImageTokens, compiledChatGptWebMessages } from "./input-tokens";
import { chatGptWebMcpContextChunks } from "./context-transport";
import { formatChatGptWebMultipartStage, type CompiledChatGptWebPrompt } from "./prompt";
import { skillFileTokens } from "./skill-attachments";

const DIAGNOSTIC_TRANSACTION = `ctx_${"0".repeat(32)}`;
const RESUME_CHECKPOINT_PREFIX = "[Verified local cumulative task checkpoint from the exact preceding Codex history.]";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function sized(text: string): { charUnits: number; estimatedTokens: number; conservativeTokens: number; hash: string } {
  return {
    charUnits: text.length,
    estimatedTokens: estimateTokens(text),
    conservativeTokens: estimateTokensForTransportValidation(text),
    hash: digest(text),
  };
}

function nativeTurnId(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const metadata = record(body?.client_metadata);
  const value = metadata?.["x-codex-turn-metadata"];
  if (typeof value !== "string") return undefined;
  try {
    const turn = record(JSON.parse(value));
    return typeof turn?.turn_id === "string" ? turn.turn_id : undefined;
  } catch {
    return undefined;
  }
}

function itemTurnId(value: unknown): string | undefined {
  const item = record(value);
  const metadata = record(item?.internal_chat_message_metadata_passthrough);
  return typeof metadata?.turn_id === "string" ? metadata.turn_id : undefined;
}

function itemLabel(value: unknown): { type: string; role?: string } {
  const item = record(value);
  return {
    type: typeof item?.type === "string" ? item.type : "message",
    ...(typeof item?.role === "string" ? { role: item.role } : {}),
  };
}

/** Return count-only evidence suitable for opt-in logs. This function never returns source text. */
export function buildChatGptWebContextDiagnostics(
  traceId: string,
  canonical: CodexParsedRequest,
  preparedInput: CodexParsedRequest,
  compiled: CompiledChatGptWebPrompt,
): Record<string, unknown> {
  const canonicalBody = record(canonical._rawBody);
  const canonicalRawInput = Array.isArray(canonicalBody?.input)
    ? canonicalBody.input
    : canonical.context.messages;
  const preparedBody = record(preparedInput._rawBody);
  const preparedRawInput = Array.isArray(preparedBody?.input)
    ? preparedBody.input
    : preparedInput.context.messages;
  const turnId = nativeTurnId(canonical);
  const fullRawText = serialized(canonicalRawInput);
  const precompileText = serialized({
    systemPrompt: canonical.context.systemPrompt ?? [],
    messages: canonical.context.messages,
    tools: canonical.context.tools ?? [],
  });
  const preparedSourceText = serialized(preparedRawInput);
  const labels = new Map<string, number>();
  for (const value of canonicalRawInput) {
    const item = itemLabel(value);
    const key = item.role ? `${item.type}:${item.role}` : item.type;
    labels.set(key, (labels.get(key) ?? 0) + 1);
  }
  const sizedRecords = canonicalRawInput.map((value, index) => {
    const text = serialized(value);
    const label = itemLabel(value);
    return {
      index,
      ...label,
      ...sized(text),
      turn: itemTurnId(value) === turnId ? "current" : "prior",
    };
  });
  const largestRecords = [...sizedRecords]
    .sort((left, right) => right.charUnits - left.charUnits)
    .slice(0, 8);
  const currentRecords = canonicalRawInput.filter(value => itemTurnId(value) === turnId);
  const assistantRecords = canonicalRawInput.filter(value => {
    const label = itemLabel(value);
    return label.role === "assistant" || label.type === "agent_message";
  });
  const toolResults = canonicalRawInput.filter(value => /(?:function_call|custom_tool_call)_output/.test(itemLabel(value).type));
  const checkpointRecords = preparedRawInput.filter(value => serialized(value).includes(RESUME_CHECKPOINT_PREFIX));
  const messages = compiledChatGptWebMessages(compiled);
  const multipartParts = compiled.multipart?.parts;
  const formattedMessages = messages.map((text, index) => {
    const payload = multipartParts?.[index];
    return {
      stage: multipartParts ? (index === messages.length - 1 ? "commit" : index + 1) : "inline",
      ...sized(text),
      payloadCharUnits: payload?.length,
      wrapperCharUnits: payload === undefined ? undefined : text.length - payload.length,
      payloadHash: payload === undefined ? undefined : digest(payload),
    };
  });
  const acknowledgementSizes = multipartParts
    ? multipartParts.slice(0, -1).map((payload, index) => {
      const stage = formatChatGptWebMultipartStage(
        payload,
        DIAGNOSTIC_TRANSACTION,
        index + 1,
        multipartParts.length,
      );
      return { stage: index + 1, ...sized(stage.acknowledgement) };
    })
    : [];
  const skillText = (compiled.skillFiles ?? []).map(file => serialized(file));
  const toolSchemaText = serialized(canonical.context.tools ?? []);
  const systemPromptText = serialized(canonical.context.systemPrompt ?? []);
  const currentText = serialized(currentRecords);
  const assistantText = serialized(assistantRecords);
  const toolResultText = serialized(toolResults);
  const checkpointText = serialized(checkpointRecords);
  const stageTotals = formattedMessages.reduce((total, message) => ({
    charUnits: total.charUnits + message.charUnits,
    estimatedTokens: total.estimatedTokens + message.estimatedTokens,
    conservativeTokens: total.conservativeTokens + message.conservativeTokens,
  }), { charUnits: 0, estimatedTokens: 0, conservativeTokens: 0 });

  return {
    traceId,
    modelId: canonical.modelId,
    recordCount: canonicalRawInput.length,
    recordCounts: Object.fromEntries([...labels.entries()].sort(([a], [b]) => a.localeCompare(b))),
    rawHistory: sized(fullRawText),
    precompileContext: sized(precompileText),
    preparedSource: sized(preparedSourceText),
    currentDelta: { recordCount: currentRecords.length, ...sized(currentText) },
    assistantOutput: { recordCount: assistantRecords.length, ...sized(assistantText) },
    toolResults: { recordCount: toolResults.length, ...sized(toolResultText) },
    checkpoint: { recordCount: checkpointRecords.length, ...sized(checkpointText) },
    largestRecords,
    toolSchema: { count: canonical.context.tools?.length ?? 0, ...sized(toolSchemaText) },
    systemPrompt: { count: canonical.context.systemPrompt?.length ?? 0, ...sized(systemPromptText) },
    attachments: {
      imageCount: compiled.images.length,
      imageCharUnits: compiled.images.reduce((sum, image) => sum + image.imageUrl.length, 0),
      imageTokenReserve: estimateChatGptWebImageTokens(compiled),
      skillFileCount: compiled.skillFiles?.length ?? 0,
      skillCharUnits: skillText.reduce((sum, text) => sum + text.length, 0),
      skillTokens: skillFileTokens(compiled.skillFiles, canonical.modelId),
    },
    multipart: multipartParts ? {
      partCount: multipartParts.length,
      payloads: multipartParts.map((payload, index) => ({ part: index + 1, ...sized(payload) })),
      commitInstructions: compiled.multipart ? sized(compiled.multipart.commit) : undefined,
      acknowledgements: acknowledgementSizes,
    } : undefined,
    formattedMessages,
    formattedTotals: stageTotals,
    maximumFormattedCharUnits: Math.max(0, ...formattedMessages.map(message => message.charUnits)),
    maximumFormattedConservativeTokens: Math.max(0, ...formattedMessages.map(message => message.conservativeTokens)),
  };
}

/** Small always-on trace payload. It contains only counts, sizes, estimates, and stage labels. */
export function buildChatGptWebStructuredTraceContext(
  traceId: string,
  canonical: CodexParsedRequest,
  preparedInput: CodexParsedRequest,
  compiled: CompiledChatGptWebPrompt,
): Record<string, unknown> {
  const metrics = buildChatGptWebContextDiagnostics(traceId, canonical, preparedInput, compiled) as JsonRecord;
  const metric = (key: string): JsonRecord => record(metrics[key]) ?? {};
  const multipart = record(metrics.multipart);
  const formattedMessages = Array.isArray(metrics.formattedMessages)
    ? metrics.formattedMessages.flatMap(value => {
      const candidate = record(value);
      if (!candidate) return [];
      return [{
        stage: candidate.stage,
        charUnits: candidate.charUnits,
        estimatedTokens: candidate.estimatedTokens,
        conservativeTokens: candidate.conservativeTokens,
        payloadCharUnits: candidate.payloadCharUnits,
        wrapperCharUnits: candidate.wrapperCharUnits,
      }];
    })
    : [];
  return {
    traceId,
    modelId: canonical.modelId,
    reasoning: canonical.options.reasoning,
    recordCount: metrics.recordCount,
    transport: compiled.contextTransport
      ? "MCP_CONTEXT"
      : compiled.multipart ? "multipart" : "inline",
    ...(compiled.contextTransport ? {
      context: {
        totalChunks: chatGptWebMcpContextChunks(compiled.contextTransport).length,
        chunkChars: compiled.contextTransport.chunkChars,
        chars: compiled.contextTransport.chars,
        bytes: compiled.contextTransport.bytes,
        estimatedTokens: estimateTokens(compiled.contextTransport.text),
      },
    } : {}),
    rawHistory: {
      charUnits: metric("rawHistory").charUnits,
      estimatedTokens: metric("rawHistory").estimatedTokens,
      conservativeTokens: metric("rawHistory").conservativeTokens,
    },
    currentDelta: {
      recordCount: metric("currentDelta").recordCount,
      charUnits: metric("currentDelta").charUnits,
      estimatedTokens: metric("currentDelta").estimatedTokens,
      conservativeTokens: metric("currentDelta").conservativeTokens,
    },
    attachments: metrics.attachments,
    multipart: multipart ? {
      partCount: multipart.partCount,
      stages: formattedMessages,
    } : undefined,
    formattedTotals: metrics.formattedTotals,
    maximumFormattedCharUnits: metrics.maximumFormattedCharUnits,
    maximumFormattedConservativeTokens: metrics.maximumFormattedConservativeTokens,
  };
}
