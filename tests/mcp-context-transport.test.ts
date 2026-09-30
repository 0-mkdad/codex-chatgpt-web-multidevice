import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_WEB_MCP_CONTEXT_CHUNK_CHARS,
  assertChatGptWebMcpContextTransport,
  ChatGptWebMcpContextIncompleteError,
  chatGptWebMcpContextChunk,
  chatGptWebMcpContextChunks,
  chatGptWebMcpContextReadQuery,
  createChatGptWebMcpContextTransport,
} from "../src/adapters/chatgpt-web/context-transport";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";
import { compiledChatGptWebMaxMessageChars, estimateCompiledChatGptWebMessageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateTokens } from "../src/lib/token-estimate";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";

const roots: string[] = [];
const capabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
  experimentalBiggerContext: true,
};

test("context chunking reconstructs byte-for-byte across synthetic sizes without splitting surrogates", () => {
  for (const size of [70_000, 130_000, 500_000, 1_000_000]) {
    const text = ("x".repeat(31) + "😀").repeat(Math.ceil(size / 32)).slice(0, size);
    const transport = createChatGptWebMcpContextTransport(text);
    expect(transport.chars).toBe(text.length);
    const chunks = chatGptWebMcpContextChunks(transport);
    expect(chunks.reduce((total, chunk) => total + chunk.length, 0)).toBe(text.length);
    expect(chunks.join("")).toBe(text);
    // No chunk may end with an unpaired leading surrogate.
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      if (last >= 0xD800 && last <= 0xDBFF) throw new Error("chunk split a surrogate pair");
    }
    for (const [index, chunk] of chunks.entries()) {
      const served = chatGptWebMcpContextChunk(transport, transport.contextId, index);
      expect(served.text).toBe(chunk);
      expect(served.total_chunks).toBe(chunks.length);
      expect(served.next_chunk).toBe(index + 1 < chunks.length ? index + 1 : null);
    }
  }
});

test("context identity binds to the exact payload and rejects mismatches", () => {
  const transport = createChatGptWebMcpContextTransport("a".repeat(70_000));
  const other = createChatGptWebMcpContextTransport("a".repeat(70_000 - 1) + "b");
  expect(transport.contextId).not.toBe(other.contextId);
  expect(transport.contextId).toMatch(/^ctx_[0-9a-f]{32}$/);
  expect(() => chatGptWebMcpContextChunk(transport, other.contextId, 0))
    .toThrow("does not match this turn");
  expect(() => assertChatGptWebMcpContextTransport({ ...transport, text: transport.text.slice(1) }))
    .toThrow("does not match its payload");
  expect(() => chatGptWebMcpContextChunk(transport, transport.contextId, 999_999))
    .toThrow("out of range");
});

test("compile keeps large cold Full replay out of the composer and counts full canonical tokens", () => {
  const parsed = {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: [],
      messages: [{ role: "user", content: "ctx ".repeat(40_000), timestamp: 1 }],
    },
  } as never;
  const compiled = compileChatGptWebPrompt(
    parsed as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(compiled.contextTransport).toBeDefined();
  expect(compiled.contextTransport!.text).toContain("ctx ");
  expect(compiled.text).not.toContain("ctx ctx ctx");
  expect(compiled.text).toContain("codex_web_context_read:");
  expect(compiled.text).toContain("<codex_mcp_context_manifest>");
  expect(compiled.text.length).toBeLessThan(compiled.contextTransport!.chars);
  // Full canonical accounting survives the small composer message.
  expect(estimateCompiledChatGptWebInputTokens(compiled, "gpt-5.6-sol"))
    .toBeGreaterThan(estimateTokensFixtureFloor());
  function estimateTokensFixtureFloor(): number { return 30_000; }
  // Small turns and compaction requests never take the MCP branch.
  const small = compileChatGptWebPrompt(
    {
      modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
      context: { systemPrompt: [], messages: [{ role: "user", content: "tiny", timestamp: 1 }] },
    } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(small.contextTransport).toBeUndefined();
  // v6.1.9: a large compaction with a registered broker token rides the MCP context primitive
  // (purpose=compaction) instead of fragmenting into multipart stages.
  const compaction = compileChatGptWebPrompt(
    { ...(parsed as Record<string, unknown>), _compactionRequest: true } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(compaction.contextTransport).toBeDefined();
  expect(compaction.contextTransportSummary).toBeDefined();
  expect(compaction.multipart).toBeUndefined();
  // Without a broker token (no trusted environment) the compaction falls back to multipart.
  const compactionCapabilities = { ...capabilities, localToolsEnabled: false };
  const compactionFallback = compileChatGptWebPrompt(
    { ...(parsed as Record<string, unknown>), _compactionRequest: true } as Parameters<typeof compileChatGptWebPrompt>[0],
    compactionCapabilities,
    undefined,
    { experimentalMultipartParts: 6 },
  );
  expect(compactionFallback.contextTransport).toBeUndefined();
  expect(compactionFallback.multipart).toBeDefined();
});

test("broker locks execution and completion until every context chunk was read", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-context-"));
  roots.push(root);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [{ name: "exec_command", description: "Command", parameters: { type: "object" } }],
    };
    const token = await broker.register(environment, 600_000, "mcp-context");
    const transport = createChatGptWebMcpContextTransport("chunk-body ".repeat(20_000).slice(0, 70_000));
    const chunks = chatGptWebMcpContextChunks(transport);
    await broker.setContextTransport(token, transport);

    const claimed = await callTurnBroker<{ bindingId: string; contextTransport: { contextId: string; sha256: string; chars: number; chunkChars: number } }>(
      socketPath, { method: "claim", token, activityId: "activity_mcp_context_0000001" },
    );
    expect(claimed.contextTransport?.contextId).toBe(transport.contextId);
    expect(claimed.contextTransport?.sha256).toBe(transport.sha256);
    expect(claimed.contextTransport?.chunkChars).toBe(chunks.length ? CHATGPT_WEB_MCP_CONTEXT_CHUNK_CHARS : 0);

    // Execution is locked before the first chunk read.
    await expect(callTurnBroker(socketPath, {
      method: "invoke", bindingId: claimed.bindingId,
      wireName: "exec_command", arguments: { cmd: "pwd" },
    })).rejects.toThrow("execution is locked");
    await expect(callTurnBroker(socketPath, {
      method: "owner_completion_fence_commit", token, revision: 0,
    })).rejects.toThrow("locked until every MCP context chunk");
    // A wrong context id or an out-of-range chunk cannot harvest the payload.
    await expect(callTurnBroker(socketPath, {
      method: "context_read", bindingId: claimed.bindingId,
      contextId: "ctx_" + "0".repeat(32), chunk: 0,
    })).rejects.toThrow("does not match this turn");
    await expect(callTurnBroker(socketPath, {
      method: "context_read", bindingId: claimed.bindingId,
      contextId: transport.contextId, chunk: chunks.length + 5,
    })).rejects.toThrow("out of range");

    // Sequential reads are the only allowed operation; completeness unlocks execution.
    let reconstructed = "";
    for (let chunk = 0; chunk < chunks.length; chunk += 1) {
      const served = await callTurnBroker<{ text: string; next_chunk: number | null; sha256: string }>(
        socketPath, {
          method: "context_read", bindingId: claimed.bindingId,
          contextId: transport.contextId, chunk,
        },
      );
      expect(served.sha256).toBe(transport.sha256);
      reconstructed += served.text;
    }
    expect(reconstructed).toBe(transport.text);
    // After completeness the ordinary Full-harness tool path unlocks: the queued call is
    // delivered to the adapter like any normal turn.
    const delivery = broker.nextToolBatch(token);
    const invokeCall = callTurnBroker(socketPath, {
      method: "invoke", bindingId: claimed.bindingId,
      wireName: "exec_command", arguments: { cmd: "pwd" },
    }, 10_000);
    const [delivered] = await delivery;
    expect(delivered!.wireName).toBe("exec_command");
    broker.completeTool(token, delivered!.callId, { content: [{ type: "text", text: "ok" }] });
    await expect(invokeCall).resolves.toBeDefined();
  } finally {
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });
});

test("context transport is immutable after the turn is bound", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-context-immutable-"));
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
    const token = await broker.register(environment, 600_000, "mcp-immutable");
    await broker.setContextTransport(token, createChatGptWebMcpContextTransport("payload-".repeat(8_000)));
    const claimed = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token, activityId: "activity_mcp_immutable_00001" },
    );
    await expect(broker.setContextTransport(token, createChatGptWebMcpContextTransport("other")))
      .rejects.toThrow("cannot change after the turn is already bound");
    expect(claimed.bindingId).toBeTruthy();
  } finally {
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });
});

test("chunk size stays at the reference 32,768-character boundary", () => {
  expect(CHATGPT_WEB_MCP_CONTEXT_CHUNK_CHARS).toBe(32_768);
  expect(chatGptWebMcpContextReadQuery("ctx_abc")).toBe("codex_web_context_read:ctx_abc");
});

test("context telemetry proves installed → chunks → complete → execution unlocked, with metadata only", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-context-telemetry-"));
  roots.push(root);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const info = spyOn(console, "info").mockImplementation(capture);
  const warn = spyOn(console, "warn").mockImplementation(capture);
  const secretMarker = "TELEMETRY-PRIVATE-PAYLOAD-MARKER";
  const transport = createChatGptWebMcpContextTransport(
    (secretMarker + " ").repeat(4_000).slice(0, 70_000),
  );
  const chunks = chatGptWebMcpContextChunks(transport);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [{ name: "exec_command", description: "Command", parameters: { type: "object" } }],
    };
    const token = await broker.register(environment, 600_000, "mcp-telemetry");
    await broker.setContextTransport(token, transport, { modelId: "gpt-5.6-sol", reasoning: "high" });

    const claimed = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token, activityId: "activity_mcp_telemetry_00001" },
    );

    const read = (chunk: number, contextId = transport.contextId) =>
      callTurnBroker<unknown>(socketPath, {
        method: "context_read", bindingId: claimed.bindingId, contextId, chunk,
      });

    // Fail-closed rejections must carry structured, privacy-safe observability.
    await expect(read(0, "ctx_" + "0".repeat(32))).rejects.toThrow("does not match this turn");
    await expect(read(chunks.length + 5)).rejects.toThrow("out of range");
    await expect(callTurnBroker(socketPath, {
      method: "invoke", bindingId: claimed.bindingId,
      wireName: "exec_command", arguments: { cmd: "pwd" },
    })).rejects.toThrow("execution is locked");
    await expect(callTurnBroker(socketPath, {
      method: "owner_completion_fence_commit", token, revision: 0,
    })).rejects.toThrow("locked until every MCP context chunk");

    // Read every chunk, with one duplicate reread, in order.
    for (let chunk = 0; chunk < chunks.length; chunk += 1) {
      await read(chunk);
      if (chunk === 0) await read(chunk);
    }

    const unlock = callTurnBroker(socketPath, {
      method: "invoke", bindingId: claimed.bindingId,
      wireName: "exec_command", arguments: { cmd: "pwd" },
    }, 10_000);
    const [delivered] = await broker.nextToolBatch(token);
    expect(delivered!.wireName).toBe("exec_command");
    broker.completeTool(token, delivered!.callId, { content: [{ type: "text", text: "ok" }] });
    await expect(unlock).resolves.toBeDefined();
  } finally {
    info.mockRestore();
    warn.mockRestore();
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });

  const events = lines
    .filter(line => line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX))
    .map(line => JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as {
      event: string;
      detail: Record<string, unknown>;
    })
    .filter(record => record.event.startsWith("mcp_context_"));
  const names = events.map(record => record.event);
  const indexOf = (event: string, occurrence = 0): number => {
    const found: number[] = [];
    names.forEach((name, index) => {
      if (name === event) found.push(index);
    });
    if (found[occurrence] === undefined) throw new Error(`missing trace event: ${event} #${occurrence}`);
    return found[occurrence]!;
  };

  // Strict ordering invariant for one large MCP context turn.
  expect(indexOf("mcp_context_transport_installed"))
    .toBeLessThan(indexOf("mcp_context_read_rejected"));
  expect(indexOf("mcp_context_chunk_read", 0))
    .toBeGreaterThan(indexOf("mcp_context_transport_installed"));
  expect(indexOf("mcp_context_complete"))
    .toBeGreaterThan(indexOf("mcp_context_chunk_read", chunks.length));
  expect(indexOf("mcp_context_execution_unlocked"))
    .toBeGreaterThan(indexOf("mcp_context_complete"));

  const installed = events[indexOf("mcp_context_transport_installed")]!.detail;
  expect(installed).toMatchObject({
    transport: "MCP_CONTEXT",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    chars: transport.chars,
    bytes: transport.bytes,
    chunkChars: CHATGPT_WEB_MCP_CONTEXT_CHUNK_CHARS,
    totalChunks: chunks.length,
  });
  expect(installed.estimatedTokens).toBeGreaterThan(0);
  expect(installed.contextIdHash).toMatch(/^[a-f0-9]{16}$/);

  const reads = events.filter(record => record.event === "mcp_context_chunk_read");
  expect(reads).toHaveLength(chunks.length + 1);
  expect(reads[0]!.detail).toMatchObject({
    chunkIndex: 0,
    totalChunks: chunks.length,
    contiguousThrough: 1,
    contextReadComplete: false,
  });
  expect(reads[1]!.detail).toMatchObject({ chunkIndex: 0, duplicateRead: true, contiguousThrough: 1 });
  const lastRead = reads[reads.length - 1]!.detail;
  expect(lastRead).toMatchObject({
    chunkIndex: chunks.length - 1,
    contextReadComplete: true,
    contiguousThrough: chunks.length,
  });
  for (const readEvent of reads) expect(readEvent.detail.elapsedMs).toBeGreaterThanOrEqual(0);

  const complete = events.filter(record => record.event === "mcp_context_complete");
  expect(complete).toHaveLength(1);
  expect(complete[0]!.detail).toMatchObject({
    totalChunks: chunks.length,
    chars: transport.chars,
    bytes: transport.bytes,
    transport: "MCP_CONTEXT",
  });
  expect(complete[0]!.detail.estimatedTokens).toBeGreaterThan(0);
  expect(complete[0]!.detail.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(complete[0]!.detail).not.toHaveProperty("contextReadComplete");

  const rejections = events.filter(record => record.event === "mcp_context_read_rejected");
  expect(rejections.map(record => record.detail.reason)).toEqual([
    "context_id_mismatch",
    "chunk_out_of_range",
  ]);
  expect(events.filter(record => record.event === "mcp_context_execution_rejected")[0]!.detail)
    .toMatchObject({ totalChunks: chunks.length, chunksRead: 0 });
  expect(events.filter(record => record.event === "mcp_context_completion_rejected")[0]!.detail)
    .toMatchObject({ totalChunks: chunks.length, chunksRead: 0 });

  const unlocked = events.filter(record => record.event === "mcp_context_execution_unlocked");
  expect(unlocked).toHaveLength(1);
  expect(unlocked[0]!.detail).toMatchObject({
    totalChunks: chunks.length,
    contextReadComplete: true,
  });

  // Telemetry is metadata only: no canonical context text, chunk text, or raw context id.
  const serialized = lines.join("\n");
  expect(serialized).not.toContain(secretMarker);
  expect(serialized).not.toContain(transport.contextId);
  expect(serialized).not.toContain("chunk-body");
});

test("completion fence rejects incomplete context in-process and over the wire, and commits only after the final chunk", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-context-fence-"));
  roots.push(root);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [{ name: "exec_command", description: "Command", parameters: { type: "object" } }],
    };
    const token = await broker.register(environment, 600_000, "mcp-fence");
    const transport = createChatGptWebMcpContextTransport("fence-body ".repeat(8_000).slice(0, 70_000));
    const chunks = chatGptWebMcpContextChunks(transport);
    await broker.setContextTransport(token, transport);
    const claimed = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token, activityId: "activity_mcp_fence_000000001" },
    );
    // Settle the claim's activity lease so the completion fence can begin.
    await callTurnBroker(socketPath, {
      method: "activity_complete", token, activityId: "activity_mcp_fence_000000001",
    });

    // Authoritative in-process rejection before any chunk is read.
    const revision = await broker.beginCompletionFence(token);
    expect(revision).toBeDefined();
    let rejected: unknown;
    try {
      broker.commitCompletionFence(token, revision!);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(ChatGptWebMcpContextIncompleteError);
    expect((rejected as Error).message).toContain("locked until every MCP context chunk");
    expect((rejected as { code?: string }).code).toBe("codex_mcp_context_incomplete");

    // The wire path inherits the identical invariant from the same method.
    await expect(callTurnBroker(socketPath, {
      method: "owner_completion_fence_commit", token, revision: revision!,
    })).rejects.toThrow("locked until every MCP context chunk");

    // A rejected commit must not have committed the fence: the channel is still live and bound,
    // and execution stays locked instead of reaching a terminal committed state.
    const stillBound = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token, activityId: "activity_mcp_fence_000000002" },
    );
    expect(stillBound.bindingId).toBe(claimed.bindingId);
    await callTurnBroker(socketPath, {
      method: "activity_complete", token, activityId: "activity_mcp_fence_000000002",
    });

    // Read every chunk; a fresh fence (activity revisions moved with the claims) now commits.
    for (let chunk = 0; chunk < chunks.length; chunk += 1) {
      await callTurnBroker(socketPath, {
        method: "context_read", bindingId: claimed.bindingId,
        contextId: transport.contextId, chunk,
      });
    }
    const freshRevision = await broker.beginCompletionFence(token);
    expect(freshRevision).toBeDefined();
    expect(broker.commitCompletionFence(token, freshRevision!)).toBe(true);
    // Idempotent duplicate commit for the same revision.
    expect(broker.commitCompletionFence(token, freshRevision!)).toBe(true);
  } finally {
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });
});

test("Temporary Chat checkpoint capture rides MCP_CONTEXT for large cold replay while routing stays intact", () => {
  const parsed = {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: [],
      messages: [{ role: "user", content: "ctx ".repeat(40_000), timestamp: 1 }],
    },
  } as never;
  // Large cold Temporary Chat replay with private resume-checkpoint capture: MCP_CONTEXT wins.
  const mcp = compileChatGptWebPrompt(
    parsed as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6, captureResumeCheckpoint: true },
  );
  expect(mcp.contextTransport).toBeDefined();
  expect(mcp.text).toContain("<codex_mcp_context_manifest>");
  expect(mcp.text).not.toContain("ctx ctx ctx");
  // The payload-free summary crosses the helper protocol: logical window resolved for the
  // Bigger-Context-eligible configuration, canonical estimate carried, no payload text anywhere.
  expect(mcp.contextTransportSummary).toBeDefined();
  expect(mcp.contextTransportSummary!.totalChunks).toBe(chatGptWebMcpContextChunks(mcp.contextTransport!).length);
  expect(mcp.contextTransportSummary!.estimatedTokens).toBeGreaterThan(10_000);
  expect(mcp.contextTransportSummary!.logicalContextWindow).toBeGreaterThan(0);
  expect(JSON.stringify(mcp.contextTransportSummary)).not.toContain("ctx ");
  // Checkpoint capture coexists: the private tail is still instructed and the payload stays small.
  expect(mcp.text).toContain("private cumulative task checkpoint");
  expect(mcp.text.length).toBeLessThan(mcp.contextTransport!.chars);

  // Small turns (including small checkpoint+delta continuations) remain inline: the planner
  // resolves no multipart parts for them and the envelope stays below the transport threshold.
  const small = compileChatGptWebPrompt(
    {
      modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
      context: { systemPrompt: [], messages: [{ role: "user", content: "tiny", timestamp: 1 }] },
    } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { captureResumeCheckpoint: true },
  );
  expect(small.contextTransport).toBeUndefined();
  expect(small.multipart).toBeUndefined();

  // Compaction rides the MCP transport with purpose=compaction (v6.1.9), and resume capture stays
  // invalid for compaction turns.
  expect(() => compileChatGptWebPrompt(
    { ...(parsed as Record<string, unknown>), _compactionRequest: true } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6, captureResumeCheckpoint: true },
  )).toThrow("Resume checkpoints are supported only for normal non-Luna ChatGPT turns");
  const compaction = compileChatGptWebPrompt(
    { ...(parsed as Record<string, unknown>), _compactionRequest: true } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6 },
  );
  expect(compaction.contextTransport).toBeDefined();
  expect(compaction.text).toContain("Local tools are unavailable for this compaction turn");

  // Zero Risk remains unchanged: manual control never takes multipart or MCP context transport.
  expect(() => compileChatGptWebPrompt(
    parsed as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "request_fixture",
    { manualControl: true, experimentalMultipartParts: 6 },
  )).toThrow("Zero Risk does not support rolling or multipart browser transport");
});

test("usage counts the full canonical context while the physical composer message stays small", () => {
  const compiled = compileChatGptWebPrompt(
    {
      modelId: "gpt-5.6-sol",
      stream: true,
      options: { reasoning: "high" },
      context: {
        systemPrompt: [],
        messages: [{ role: "user", content: "ctx ".repeat(40_000), timestamp: 1 }],
      },
    } as Parameters<typeof compileChatGptWebPrompt>[0],
    capabilities,
    "turn_token_fixture",
    { experimentalMultipartParts: 6, captureResumeCheckpoint: true },
  );
  expect(compiled.contextTransport).toBeDefined();
  // Logical usage accounting includes the entire canonical payload.
  const canonicalTokens = estimateTokens(compiled.contextTransport!.text, "gpt-5.6-sol");
  expect(estimateCompiledChatGptWebInputTokens(compiled, "gpt-5.6-sol")).toBeGreaterThan(canonicalTokens);
  // Physical composer validation sees only the small bootstrap/manifest message.
  expect(estimateCompiledChatGptWebMessageTokens(compiled, "gpt-5.6-sol")).toBeLessThan(8_000);
  expect(compiledChatGptWebMaxMessageChars(compiled)).toBeLessThan(32_768);
});

test("context-read lease extends on contiguous progress only", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-mcp-context-lease-"));
  roots.push(root);
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const transport = createChatGptWebMcpContextTransport("lease-body ".repeat(8_000).slice(0, 70_000));
    const shortTtl = 300;
    const tokenA = await broker.register(environment, shortTtl, "mcp-lease-a");
    const tokenB = await broker.register(environment, shortTtl, "mcp-lease-b");
    await broker.setContextTransport(tokenA, transport);
    await broker.setContextTransport(tokenB, transport);
    const claimedA = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token: tokenA, activityId: "activity_mcp_lease_a0000001" },
    );
    const claimedB = await callTurnBroker<{ bindingId: string }>(
      socketPath, { method: "claim", token: tokenB, activityId: "activity_mcp_lease_b0000001" },
    );
    const read = (bindingId: string, chunk: number) => callTurnBroker(socketPath, {
      method: "context_read", bindingId, contextId: transport.contextId, chunk,
    });

    // A: contiguous progress extends the short lease well past its original expiry.
    await read(claimedA.bindingId, 0);
    // B: a unique but out-of-order read does not move the frontier, so nothing is extended.
    await read(claimedB.bindingId, 1);
    await new Promise(resolveSleep => setTimeout(resolveSleep, 500));

    // Trigger a prune pass; the unrefreshed channel expires while the refreshed one survives.
    await broker.register(environment, 600_000, "mcp-lease-prune-trigger");

    await expect(read(claimedA.bindingId, 1)).resolves.toBeDefined();
    await expect(read(claimedB.bindingId, 2)).rejects.toThrow(/already finished|invalid or expired/);
  } finally {
    await broker.close();
  }
  rmSync(roots.at(-1)!, { recursive: true, force: true });
});
