import { expect, test } from "bun:test";
import { buildChatGptWebContextDiagnostics } from "../src/adapters/chatgpt-web/context-diagnostics";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

test("context diagnostics report stage and record sizes without returning conversation or attachment content", () => {
  const privatePrompt = "PRIVATE_CONTEXT_DIAGNOSTIC_SENTINEL_9c63e21d";
  const privateAttachment = "PRIVATE_ATTACHMENT_DIAGNOSTIC_SENTINEL_1b427a90";
  const threadId = "thread_context_diagnostics";
  const turnId = "turn_context_diagnostics";
  const input = [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: `Prior policy ${privatePrompt}` }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_prior" },
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Current task ${privatePrompt}` }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  ];
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    input,
    stream: true,
    reasoning: { effort: "high" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  });
  parsed.modelId = CHATGPT_WEB_MODEL_ID;
  const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, {
    experimentalMultipartParts: 2,
    captureResumeCheckpoint: true,
  });
  compiled.images.push({ ref: "diagnostic-image", imageUrl: `data:image/png;base64,${privateAttachment}` });

  const diagnostics = buildChatGptWebContextDiagnostics("trace_context_diagnostics", parsed, parsed, compiled);
  const encoded = JSON.stringify(diagnostics);
  expect(encoded).not.toContain(privatePrompt);
  expect(encoded).not.toContain(privateAttachment);
  expect(diagnostics).toMatchObject({
    traceId: "trace_context_diagnostics",
    modelId: CHATGPT_WEB_MODEL_ID,
    recordCount: 2,
    multipart: { partCount: 2 },
    attachments: { imageCount: 1 },
  });
  const messages = diagnostics.formattedMessages as Array<Record<string, unknown>>;
  expect(messages).toHaveLength(2);
  expect(messages.every(message => typeof message.hash === "string" && typeof message.charUnits === "number")).toBeTrue();
  expect(messages.every(message => typeof message.wrapperCharUnits === "number" && message.wrapperCharUnits > 0)).toBeTrue();
  expect((diagnostics.largestRecords as Array<Record<string, unknown>>).every(record => !("content" in record))).toBeTrue();
});
