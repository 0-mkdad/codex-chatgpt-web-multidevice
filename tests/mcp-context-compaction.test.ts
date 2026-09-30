import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatGptWebMcpContextIncompleteError,
  chatGptWebMcpContextChunks,
  createChatGptWebMcpContextTransport,
} from "../src/adapters/chatgpt-web/context-transport";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";
import { ChatGptCompactionHandoffStore } from "../src/adapters/chatgpt-web/compaction-handoff";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

const roots: string[] = [];
const capabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
  experimentalBiggerContext: true,
};

const largeCompactionParsed = {
  modelId: "gpt-5.6-sol",
  stream: true,
  options: { reasoning: "high" },
  _compactionRequest: true,
  context: {
    systemPrompt: [],
    messages: [{ role: "user", content: "ctx ".repeat(40_000), timestamp: 1 }],
  },
} as never;

function captureTraceLines(): { lines: string[]; info: { mockRestore: () => void }; warn: { mockRestore: () => void } } {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const info = spyOn(console, "info").mockImplementation(capture);
  const warn = spyOn(console, "warn").mockImplementation(capture);
  return { lines, info, warn };
}

test("large compaction selects MCP context with purpose=compaction; small compaction stays inline", () => {
  const compiled = compileChatGptWebPrompt(
    largeCompactionParsed as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(compiled.contextTransport).toBeDefined();
  expect(compiled.contextTransportSummary).toBeDefined();
  expect(compiled.contextTransportSummary!.totalChunks).toBeGreaterThan(1);
  expect(compiled.contextTransportSummary!.logicalContextWindow).toBe(270_000);
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.text).toContain("<codex_mcp_context_manifest>");
  expect(compiled.text).toContain("Local tools are unavailable for this compaction turn");

  // The production compaction capabilities disable local tools; the transport still engages and
  // the composer carries the summarization-only contract.
  const readOnly = compileChatGptWebPrompt(
    largeCompactionParsed as Parameters<typeof compileChatGptWebPrompt>[0],
    { ...capabilities, localToolsEnabled: false },
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(readOnly.contextTransport).toBeDefined();
  expect(readOnly.multipart).toBeUndefined();
  expect(readOnly.text).toContain("Local tools are unavailable for this compaction turn");

  // Small compaction stays inline: the envelope never reaches the transport threshold.
  const small = compileChatGptWebPrompt(
    {
      modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" }, _compactionRequest: true,
      context: { systemPrompt: [], messages: [{ role: "user", content: "tiny", timestamp: 1 }] },
    } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(small.contextTransport).toBeUndefined();
  expect(small.contextTransportSummary).toBeUndefined();
});

test("compaction transport keeps full canonical token accounting and the logical window", () => {
  const compiled = compileChatGptWebPrompt(
    largeCompactionParsed as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  const canonicalTokens = 10_000;
  expect(estimateCompiledChatGptWebInputTokens(compiled, "gpt-5.6-sol"))
    .toBeGreaterThan(compiled.contextTransport!.chars / 6);
  expect(compiled.contextTransportSummary!.estimatedTokens).toBeGreaterThan(canonicalTokens);
  expect(compiled.contextTransportSummary!.logicalContextWindow).toBe(270_000);
  expect(JSON.stringify(compiled.contextTransportSummary)).not.toContain("ctx ");
});

test("compaction purpose keeps execution locked forever and never emits the unlock boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-compaction-lock-"));
  roots.push(root);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const { lines, info, warn } = captureTraceLines();
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [{ name: "exec_command", description: "Command", parameters: { type: "object" } }],
    };
    const token = await broker.register(environment, 600_000, "mcp-compaction");
    const transport = createChatGptWebMcpContextTransport("compact-body ".repeat(8_000).slice(0, 70_000));
    const chunks = chatGptWebMcpContextChunks(transport);
    await broker.setContextTransport(token, transport, {
      modelId: "gpt-5.6-sol", reasoning: "high", purpose: "compaction",
    });
    const claimed = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token, activityId: "activity_mcp_compact_0000001" },
    );
    await callTurnBroker(socketPath, {
      method: "activity_complete", token, activityId: "activity_mcp_compact_0000001",
    });

    // Pre-completeness: the completeness gate rejects execution.
    await expect(callTurnBroker(socketPath, {
      method: "invoke", bindingId: claimed.bindingId,
      wireName: "exec_command", arguments: { cmd: "pwd" },
    })).rejects.toThrow("execution is locked");

    // Read every chunk: completeness is reached.
    for (let chunk = 0; chunk < chunks.length; chunk += 1) {
      await callTurnBroker(socketPath, {
        method: "context_read", bindingId: claimed.bindingId,
        contextId: transport.contextId, chunk,
      });
    }

    // Post-completeness: compaction execution stays locked by purpose, and the unlock boundary
    // is never emitted for a compaction turn.
    await expect(callTurnBroker(socketPath, {
      method: "invoke", bindingId: claimed.bindingId,
      wireName: "exec_command", arguments: { cmd: "pwd" },
    })).rejects.toThrow("locked for compaction turns");
    const names = lines
      .filter(line => line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX))
      .map(line => (JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as { event: string }).event);
    expect(names).not.toContain("mcp_context_execution_unlocked");

    // The summary acceptance fence works on the same channel: commit succeeds after completion.
    const revision = await broker.beginCompletionFence(token);
    expect(revision).toBeDefined();
    expect(broker.commitCompletionFence(token, revision!)).toBe(true);
  } finally {
    info.mockRestore();
    warn.mockRestore();
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });
});

test("partial context cannot produce an accepted compaction summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-compaction-partial-"));
  roots.push(root);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const environment = {
      cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const token = await broker.register(environment, 600_000, "mcp-compaction-partial");
    const transport = createChatGptWebMcpContextTransport("partial ".repeat(12_000).slice(0, 70_000));
    const chunks = chatGptWebMcpContextChunks(transport);
    await broker.setContextTransport(token, transport, { purpose: "compaction" });
    const revision = await broker.beginCompletionFence(token);
    expect(revision).toBeDefined();

    // Read all but the final chunk, then attempt the acceptance commit: rejected fail-closed.
    for (let chunk = 0; chunk < chunks.length - 1; chunk += 1) {
      await callTurnBroker(socketPath, {
        method: "context_read", bindingId: (await callTurnBroker<{ bindingId: string }>(
          socketPath, { method: "claim", token, activityId: "activity_mcp_partial_0000001" },
        )).bindingId,
        contextId: transport.contextId, chunk,
      });
    }
    let rejected: unknown;
    try {
      broker.commitCompletionFence(token, revision!);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(ChatGptWebMcpContextIncompleteError);
    expect((rejected as { code?: string }).code).toBe("codex_mcp_context_incomplete");
  } finally {
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });
});

test("compaction handoff store is idempotent, conflict-safe, and gates replays", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-compaction-store-"));
  roots.push(root);
  const storePath = join(root, "compaction-handoffs.json");
  const store = new ChatGptCompactionHandoffStore(storePath);
  const key = "namespace:compaction-key";

  // Disconnect before handoff: nothing committed, a retry is allowed to run.
  expect(store.lookup(key)).toBeUndefined();

  // First commit succeeds; a retry after commit receives the SAME summary without replay.
  expect(store.commit(key, "committed summary v1", "trace-a")).toEqual({ duplicate: false });
  const committed = store.lookup(key);
  expect(committed?.summary).toBe("committed summary v1");

  // Duplicate handoff is idempotent for the same summary...
  expect(store.commit(key, "committed summary v1", "trace-b")).toEqual({ duplicate: true });
  // ...and fails closed for a DIFFERENT summary (no two competing compacted histories).
  expect(() => store.commit(key, "competing summary", "trace-c")).toThrow("handoff conflict");

  // Durability: a fresh store instance over the same file answers the retry without browser work.
  const reopened = new ChatGptCompactionHandoffStore(storePath);
  expect(reopened.lookup(key)?.summary).toBe("committed summary v1");
  rmSync(root, { recursive: true, force: true });
});
