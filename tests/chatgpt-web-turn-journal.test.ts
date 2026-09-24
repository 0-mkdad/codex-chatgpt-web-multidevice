import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptTurnJournal } from "../src/adapters/chatgpt-web/turn-journal";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("turn journal survives a process-style reload without persisting browser content or authority", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-turn-journal-"));
  roots.push(root);
  const path = join(root, "runtime", "turn-journal.json");
  const executionKey = "namespace:execution-key";
  const nativeThreadId = "thread-secret-value";
  const nativeTurnId = "turn-secret-value";
  const conversationKey = "conversation-secret-value";
  const toolCallId = "call-secret-value";
  const answer = "private final answer body";

  const first = new ChatGptTurnJournal(path, () => 1_000);
  first.recordSubmission(executionKey, "send_activated", {
    traceId: "trace_123",
    nativeThreadId,
    nativeTurnId,
    conversationKey,
    retryCount: 2,
  });
  first.recordSubmission(executionKey, "accepted", { traceId: "trace_123" });
  first.recordOutstandingToolCalls(executionKey, [toolCallId]);
  first.recordEvents(executionKey, [{ type: "text_delta", text: answer, phase: "final_answer" }]);
  first.recordToolResult(executionKey, toolCallId);
  first.recordTerminal(executionKey, "final", { response: answer });

  const serialized = readFileSync(path, "utf8");
  for (const secret of [executionKey, nativeThreadId, nativeTurnId, conversationKey, toolCallId, answer]) {
    expect(serialized).not.toContain(secret);
  }

  const reloaded = new ChatGptTurnJournal(path, () => 1_001);
  expect(reloaded.checkpoint(executionKey)).toMatchObject({
    traceId: "trace_123",
    provider: "chatgpt-web",
    submissionPhase: "accepted",
    completion: "final",
    eventSequence: 1,
    retryCount: 2,
    outstandingToolCallHashes: [],
  });
  expect(reloaded.checkpoint(executionKey)?.responseHash).toMatch(/^[a-f0-9]{64}$/);
});

test("running post-Send tombstones do not silently expire while terminal checkpoints do", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-turn-journal-ttl-"));
  roots.push(root);
  const path = join(root, "turn-journal.json");
  let now = 1_000;
  const journal = new ChatGptTurnJournal(path, () => now, 100);
  journal.recordSubmission("namespace:running-turn", "send_activated", { traceId: "trace-running" });
  journal.recordSubmission("namespace:terminal-turn", "accepted", { traceId: "trace-terminal" });
  journal.recordTerminal("namespace:terminal-turn", "final");
  now = 1_101;
  expect(journal.checkpoint("namespace:running-turn")).toMatchObject({
    completion: "running",
    submissionPhase: "send_activated",
  });
  expect(journal.checkpoint("namespace:terminal-turn")).toBeUndefined();
  const reloaded = new ChatGptTurnJournal(path, () => now, 100);
  expect(reloaded.checkpoint("namespace:running-turn")).toMatchObject({ completion: "running" });
});

test("journal evicts terminal checkpoints before a live accepted duplicate-suppression tombstone", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-turn-journal-capacity-"));
  roots.push(root);
  const path = join(root, "turn-journal.json");
  let now = 1_000;
  const journal = new ChatGptTurnJournal(path, () => now++);
  const liveKey = "namespace:live-accepted";
  journal.recordSubmission(liveKey, "accepted", { traceId: "trace-live" });
  for (let index = 0; index < 300; index += 1) {
    const key = `namespace:terminal-${index}`;
    journal.recordSubmission(key, "accepted", { traceId: `trace-terminal-${index}` });
    journal.recordTerminal(key, "final");
  }
  expect(journal.checkpoint(liveKey)).toMatchObject({ completion: "running", submissionPhase: "accepted" });
  const reloaded = new ChatGptTurnJournal(path, () => now);
  expect(reloaded.checkpoint(liveKey)).toMatchObject({ completion: "running", submissionPhase: "accepted" });
  expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).entries)).toHaveLength(256);
  expect(reloaded.checkpoint("namespace:terminal-0")).toBeUndefined();
});

test("journal saturation with only running post-Send checkpoints fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-turn-journal-saturated-"));
  roots.push(root);
  const path = join(root, "turn-journal.json");
  const journal = new ChatGptTurnJournal(path, () => 1_000);
  for (let index = 0; index < 256; index += 1) {
    journal.recordSubmission(`namespace:running-${index}`, "accepted", { traceId: `trace-running-${index}` });
  }
  expect(() => journal.recordSubmission("namespace:running-overflow", "send_activated", { traceId: "trace-overflow" }))
    .toThrow("refusing to evict duplicate-suppression state");
  const reloaded = new ChatGptTurnJournal(path, () => 2_000);
  expect(reloaded.checkpoint("namespace:running-0")).toMatchObject({ completion: "running" });
  expect(reloaded.checkpoint("namespace:running-255")).toMatchObject({ completion: "running" });
});
