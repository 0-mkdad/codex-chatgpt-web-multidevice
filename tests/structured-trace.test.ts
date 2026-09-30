import { expect, spyOn, test } from "bun:test";
import {
  CHATGPT_WEB_STRUCTURED_TRACE_PREFIX,
  chatGptWebTraceHash,
  emitChatGptWebStructuredTrace,
} from "../src/adapters/chatgpt-web/structured-trace";

test("structured tracing preserves diagnostics while dropping content and credentials", () => {
  const lines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    emitChatGptWebStructuredTrace("context_planned", {
      traceId: "trace-safe",
      modelId: "gpt-5.6-sol",
      stageIndex: 2,
      estimatedTokens: 42_000,
      prompt: "PRIVATE PROMPT",
      content: "PRIVATE CONTENT",
      message: "PRIVATE MESSAGE",
      authorization: "Bearer PRIVATE_TOKEN",
      controlToken: "PRIVATE CONTROL TOKEN",
      nested: {
        retryCount: 3,
        headers: { cookie: "PRIVATE COOKIE" },
      },
    });
  } finally {
    info.mockRestore();
  }

  expect(lines).toHaveLength(1);
  expect(lines[0]!.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX)).toBe(true);
  const encoded = lines[0]!;
  expect(encoded).toContain("context_planned");
  expect(encoded).toContain("gpt-5.6-sol");
  expect(encoded).toContain("42000");
  expect(encoded).toContain("retryCount");
  expect(encoded).not.toContain("PRIVATE");
  const parsed = JSON.parse(encoded.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length));
  expect(parsed).toMatchObject({
    version: 1,
    level: "info",
    event: "context_planned",
    detail: {
      traceId: "trace-safe",
      modelId: "gpt-5.6-sol",
      stageIndex: 2,
      estimatedTokens: 42_000,
      nested: { retryCount: 3 },
    },
  });
});

test("structured trace identity hashes are deterministic and irreversible in the log value", () => {
  const identity = "thread_private_identifier_123456789";
  const first = chatGptWebTraceHash(identity);
  expect(first).toBe(chatGptWebTraceHash(identity));
  expect(first).toMatch(/^[a-f0-9]{16}$/);
  expect(first).not.toContain(identity);
  expect(chatGptWebTraceHash(undefined)).toBeUndefined();
});
