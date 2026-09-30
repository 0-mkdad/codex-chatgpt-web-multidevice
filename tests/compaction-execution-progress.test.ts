import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  chatGptWebMcpContextChunks,
  createChatGptWebMcpContextTransport,
} from "../src/adapters/chatgpt-web/context-transport";
import { cancelStructuredCompactionTrace } from "../src/adapters/chatgpt-web/compaction-handoff";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

/**
 * Package A regression suite: the compaction execution deadline is a MEANINGFUL-PROGRESS stall
 * window, not an absolute admission wall clock.
 *
 * Live trace 778f6003a008_fresh (2026-09-27) proved the old behavior: three runs of one 26-chunk
 * MCP_CONTEXT compaction each fired `compaction_execution_timeout` at exactly admission+300s —
 * once while the contiguous frontier was still advancing (22/26) and once 71s after
 * contextReadComplete=true. The deadline is now re-armed by the same authoritative forward
 * progress the broker already computes for the channel lease: a NEW contiguous frontier advance
 * refreshes the active phase budget, and the completion transition starts the fresh
 * generation/settlement budget. Duplicate and out-of-order reads deliver nothing, so a stalled
 * reconstruction still dies at the budget (no immortal operations).
 *
 * The broker-level tests drive context_read over the real broker wire protocol (the same path
 * the MCP server uses). The adapter-level tests drive the broker dispatch in-process: the
 * handler, frontier discrimination, and deadline wiring are identical, and Bun's Windows
 * named-pipe data delivery proved unreliable under this suite's concurrent adapter load
 * (connections open, writes never surface server-side) — the wire path itself remains covered
 * by tests/mcp-context-transport.test.ts and the live acceptance.
 */

type ProgressEvent = { kind: "chunk" | "complete"; contiguousThrough?: number; totalChunks?: number };

type BrokerDispatch = (request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

function brokerEnvironment(root: string) {
  return {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Command", parameters: { type: "object" } }],
  };
}

function dispatchOf(broker: TurnBroker): BrokerDispatch {
  return (request, signal) => (broker as unknown as { dispatch: BrokerDispatch }).dispatch(
    { id: `test_${Math.random().toString(36).slice(2)}`, ...request },
    signal,
  );
}

test("context progress fires on unique contiguous frontier advances and on completion only", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-exec-progress-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const token = await broker.register(brokerEnvironment(root), 600_000, "exec-progress-broker");
    const transport = createChatGptWebMcpContextTransport("progress-body ".repeat(10_000).slice(0, 140_000));
    const chunks = chatGptWebMcpContextChunks(transport);
    expect(chunks.length).toBe(5);
    const events: ProgressEvent[] = [];
    await broker.setContextTransport(token, transport, {
      purpose: "compaction",
      onContextProgress: info => events.push({ ...info }),
    });
    const claimed = await callTurnBroker<{ bindingId: string; contextTransport: { contextId: string } }>(
      socketPath, { method: "claim", token, activityId: "activity_exec_progress_broker001" },
    );
    const read = (chunk: number) => callTurnBroker(socketPath, {
      method: "context_read", bindingId: claimed.bindingId, contextId: claimed.contextTransport.contextId, chunk,
    });
    await read(0); // frontier 0 → 1: chunk event
    await read(0); // duplicate: no event
    await read(2); // out of order, frontier stays 1: no event
    await read(1); // frontier 1 → 3: chunk event
    await read(0); // duplicate: no event
    await read(3); // frontier 3 → 4: chunk event
    await read(4); // frontier 4 → 5 AND completion: chunk + complete events
    expect(events.filter(event => event.kind === "chunk").map(event => event.contiguousThrough))
      .toEqual([1, 3, 4, 5]);
    const completions = events.filter(event => event.kind === "complete");
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ totalChunks: 5 });
  } finally {
    await TurnBroker.forSocket(socketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a throwing progress callback never fails the context read", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-exec-throw-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  try {
    const token = await broker.register(brokerEnvironment(root), 600_000, "exec-progress-throw");
    const transport = createChatGptWebMcpContextTransport("throw-body ".repeat(9_000).slice(0, 70_000));
    let notifications = 0;
    await broker.setContextTransport(token, transport, {
      purpose: "compaction",
      onContextProgress: () => {
        notifications += 1;
        throw new Error("deadline owner exploded");
      },
    });
    const claimed = await callTurnBroker<{ bindingId: string; contextTransport: { contextId: string } }>(
      socketPath, { method: "claim", token, activityId: "activity_exec_progress_throw001" },
    );
    const served = await callTurnBroker<{ text: string; next_chunk: number | null }>(socketPath, {
      method: "context_read", bindingId: claimed.bindingId,
      contextId: claimed.contextTransport.contextId, chunk: 0,
    });
    expect(served.text.length).toBeGreaterThan(0);
    expect(notifications).toBe(1);
  } finally {
    await TurnBroker.forSocket(socketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

const EXECUTION_BUDGET_MS = 100;
// Gaps sit INSIDE the budget window: meaningful progress must arrive within the stall
// window, while the TOTAL operation far exceeds the absolute admission deadline.
const FRONTIER_GAP_MS = 80;

function providerConfig(root: string): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `browser://exec-progress-${Math.random().toString(36).slice(2)}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      experimentalBiggerContext: true,
      experimentalFreshConversationPerTurn: true,
      turnTimeoutMs: EXECUTION_BUDGET_MS,
    },
  };
}

function environmentXml(root: string): string {
  return `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
}

function compactionRequest(root: string): CodexParsedRequest {
  const suffix = Math.random().toString(36).slice(2, 8);
  const threadId = `thread_exec_progress_${suffix}`;
  const sourceTurnId = `turn_source_exec_${suffix}`;
  const activeTurnId = `turn_compact_exec_${suffix}`;
  const request = parseRequest({
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "ctx ".repeat(40_000) }],
        internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environmentXml(root) }],
        internal_chat_message_metadata_passthrough: { turn_id: activeTurnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Produce the compaction summary for the audited context." }],
        internal_chat_message_metadata_passthrough: { turn_id: activeTurnId },
      },
    ],
    stream: true,
    reasoning: { effort: "high" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        turn_id: activeTurnId,
      }),
    },
  }) as CodexParsedRequest;
  request.modelId = "gpt-5.6-sol";
  request.options.reasoning = "high";
  (request as { _compactionRequest: boolean })._compactionRequest = true;
  return request;
}

interface Harness {
  events: AdapterEvent[];
  done: Promise<void>;
  traceDetail: () => Array<{ event: string; detail: Record<string, unknown> }>;
  logs: () => { warn: string[]; error: string[] };
  compactionTraceId: () => string;
  restore: () => Promise<void>;
}

/**
 * Drives the real fresh-conversation MCP compaction closure with a stubbed browser worker.
 * The stub performs the admission contract (onSlotGranted), installs the real MCP context
 * transport through prepare(), and hands the broker turn token plus the in-process broker
 * dispatch to `browserPhase`, which plays the reserved context reader: it controls exactly
 * when unique frontier progress happens.
 */
async function startHarness(
  root: string,
  browserPhase: (context: { dispatch: BrokerDispatch; token: string }) => Promise<string>,
): Promise<Harness> {
  const config = providerConfig(root);
  const socketPath = config.chatgptWeb!.brokerSocketPath!;
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const worker = ChatGptBrowserWorker.forProvider(config);
  const originalRun = worker.run.bind(worker);
  const workerHost = worker as unknown as { run: (turn: BrowserTurn) => Promise<string> };
  const events: AdapterEvent[] = [];
  const traceLines: string[] = [];
  const warnLines: string[] = [];
  const errorLines: string[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX)) traceLines.push(line);
  });
  const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnLines.push(args.map(String).join(" "));
  });
  const error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String).join(" "));
  });
  let compactionTraceId = "";

  workerHost.run = async turn => {
    compactionTraceId = turn.traceId;
    // The admission contract: arms the execution stall deadline exactly like the real worker.
    await turn.onSlotGranted?.();
    const prepared = await turn.prepare();
    prepared.release();
    const token = /turn_token (\S+)/.exec(prepared.text)?.[1] ?? "";
    if (!token) throw new Error("compaction manifest did not carry the broker turn token");
    return browserPhase({ dispatch: dispatchOf(broker), token });
  };

  const runTurn = createChatGptWebAdapter(config).runTurn!(
    compactionRequest(root),
    { headers: new Headers() },
    event => events.push(event),
  );

  return {
    events,
    done: runTurn.then(() => undefined, () => undefined),
    traceDetail: () => traceLines.map(line => JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as { event: string; detail: Record<string, unknown> }),
    logs: () => ({ warn: warnLines, error: errorLines }),
    compactionTraceId: () => compactionTraceId,
    restore: async () => {
      await runTurn.catch(() => {});
      workerHost.run = originalRun;
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      chatGptTurnSessions.clear();
      await TurnBroker.forSocket(socketPath).close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("unique contiguous frontier progress keeps the admitted compaction alive past the execution budget", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-exec-progress-live-"));
  const startedAt = performance.now();
  const harness = await startHarness(root, async ({ dispatch, token }) => {
    const claimed = await dispatch({ method: "claim", token, activityId: "activity_exec_progress_live0001" }) as {
      bindingId: string;
      contextTransport: { contextId: string };
    };
    // Reserved context reads spaced inside the 100ms execution budget but totalling far
    // beyond it: under the old absolute-admission deadline the compaction died at 100ms
    // after admission even though unique frontier progress kept arriving.
    let next: number | null = 0;
    while (next !== null) {
      const served = await dispatch({
        method: "context_read", bindingId: claimed.bindingId,
        contextId: claimed.contextTransport.contextId, chunk: next,
      }) as { next_chunk: number | null };
      next = served.next_chunk;
      if (next !== null) await Bun.sleep(FRONTIER_GAP_MS);
    }
    // Release the reserved reader activity so the server-side completeness fence can commit.
    await dispatch({ method: "activity_complete", token, activityId: "activity_exec_progress_live0001" });
    // Generation phase: the completion transition started a fresh budget; settle inside it.
    await Bun.sleep(EXECUTION_BUDGET_MS / 4);
    return "COMPACTED SUMMARY: the audited context was reconstructed and condensed.";
  });
  try {
    await harness.done;
    const elapsed = performance.now() - startedAt;
    // The operation ran several refresh windows long: proof the deadline is a stall window
    // refreshed by frontier progress, not an admission wall clock (the old code would have
    // fired at EXECUTION_BUDGET_MS after admission, within the first gap).
    expect(elapsed).toBeGreaterThan(EXECUTION_BUDGET_MS + FRONTIER_GAP_MS * 2);
    expect(harness.events.some(event => event.type === "error")).toBeFalse();
    expect(harness.events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(harness.events.some(event => event.type === "text_delta"
      && event.text.includes("COMPACTED SUMMARY"))).toBeTrue();
    const progressEvents = harness.traceDetail().filter(event => event.event === "compaction_execution_progress");
    const installed = harness.traceDetail().find(event => event.event === "mcp_context_transport_installed");
    const totalChunks = installed?.detail.totalChunks as number;
    expect(totalChunks).toBeGreaterThan(1);
    expect(progressEvents.filter(event => event.detail.kind === "chunk").map(event => event.detail.contiguousThrough))
      .toEqual(Array.from({ length: totalChunks }, (_, index) => index + 1));
    expect(progressEvents.filter(event => event.detail.kind === "complete")).toHaveLength(1);
    const traceEvents = harness.traceDetail().map(event => event.event);
    expect(traceEvents).toContain("compaction_result_observed");
    expect(traceEvents).toContain("compaction_handoff_started");
    expect(traceEvents).toContain("compaction_handoff_committed");
  } finally {
    await harness.restore();
  }
});

test("duplicate context reads do not refresh the execution deadline: the stalled compaction still times out", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-exec-progress-dup-"));
  let compactionTraceId = "";
  const harness = await startHarness(root, async ({ dispatch, token }) => {
    const claimed = await dispatch({ method: "claim", token, activityId: "activity_exec_progress_dup0001" }) as {
      bindingId: string;
      contextTransport: { contextId: string };
    };
    await dispatch({
      method: "context_read", bindingId: claimed.bindingId,
      contextId: claimed.contextTransport.contextId, chunk: 0,
    });
    // Only duplicate reads from here on: they must not re-arm the deadline, so the operation
    // dies at the budget after the last unique frontier advance.
    for (let index = 0; index < 12; index += 1) {
      await Bun.sleep(EXECUTION_BUDGET_MS / 8);
      await dispatch({
        method: "context_read", bindingId: claimed.bindingId,
        contextId: claimed.contextTransport.contextId, chunk: 0,
      }).catch(() => {});
    }
    return "never reached: the deadline must fire first";
  });
  try {
    compactionTraceId = harness.compactionTraceId();
    await harness.done;
    expect(harness.events.at(-1)).toMatchObject({
      type: "error",
      code: "compaction_execution_timeout",
      status: 409,
      retryable: false,
    });
    expect(harness.events.filter(event => event.type === "error")).toHaveLength(1);
    expect(harness.events.some(event => event.type === "done")).toBeFalse();
    // The stall window ran from the last unique frontier advance, not from repeated duplicates.
    const progressEvents = harness.traceDetail().filter(event => event.event === "compaction_execution_progress");
    expect(progressEvents.filter(event => event.detail.kind === "chunk")).toHaveLength(1);
  } finally {
    if (compactionTraceId) await cancelStructuredCompactionTrace(compactionTraceId, new Error("test cleanup"));
    await harness.restore();
  }
});

test("a no-progress admitted compaction still times out with the typed execution error", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-exec-progress-stall-"));
  let compactionTraceId = "";
  const harness = await startHarness(root, async () => {
    // Admission happened (slot granted + submission-level arming) but nothing ever progresses.
    await Bun.sleep(FRONTIER_GAP_MS * 3);
    return "never reached: the deadline must fire first";
  });
  try {
    compactionTraceId = harness.compactionTraceId();
    await harness.done;
    expect(harness.events.at(-1)).toMatchObject({
      type: "error",
      code: "compaction_execution_timeout",
      status: 409,
      retryable: false,
    });
    expect(harness.events.filter(event => event.type === "error")).toHaveLength(1);
    const progressEvents = harness.traceDetail().filter(event => event.event === "compaction_execution_progress");
    expect(progressEvents).toHaveLength(0);
  } finally {
    if (compactionTraceId) await cancelStructuredCompactionTrace(compactionTraceId, new Error("test cleanup"));
    await harness.restore();
  }
});

test("the generation phase owns a fresh budget after context completion and still fails closed when it expires", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-exec-progress-gen-"));
  let compactionTraceId = "";
  const harness = await startHarness(root, async ({ dispatch, token }) => {
    const claimed = await dispatch({ method: "claim", token, activityId: "activity_exec_progress_gen0001" }) as {
      bindingId: string;
      contextTransport: { contextId: string };
    };
    // Ingest the full context quickly: the completion transition starts the generation budget.
    let next: number | null = 0;
    while (next !== null) {
      const served = await dispatch({
        method: "context_read", bindingId: claimed.bindingId,
        contextId: claimed.contextTransport.contextId, chunk: next,
      }) as { next_chunk: number | null };
      next = served.next_chunk;
    }
    await dispatch({ method: "activity_complete", token, activityId: "activity_exec_progress_gen0001" });
    // Never produce the summary: the generation budget must expire and fail the compaction.
    await Bun.sleep(FRONTIER_GAP_MS * 3);
    return "never reached: the generation deadline must fire first";
  });
  try {
    compactionTraceId = harness.compactionTraceId();
    await harness.done;
    expect(harness.events.at(-1)).toMatchObject({
      type: "error",
      code: "compaction_execution_timeout",
      status: 409,
      retryable: false,
    });
    const progressEvents = harness.traceDetail().filter(event => event.event === "compaction_execution_progress");
    expect(progressEvents.filter(event => event.detail.kind === "complete")).toHaveLength(1);
    expect(harness.traceDetail().map(event => event.event)).not.toContain("compaction_result_observed");
  } finally {
    if (compactionTraceId) await cancelStructuredCompactionTrace(compactionTraceId, new Error("test cleanup"));
    await harness.restore();
  }
});
