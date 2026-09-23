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

test("turn journal expires bounded restart checkpoints", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-turn-journal-ttl-"));
  roots.push(root);
  const path = join(root, "turn-journal.json");
  let now = 1_000;
  const journal = new ChatGptTurnJournal(path, () => now, 100);
  journal.recordSubmission("namespace:old-turn", "send_activated", { traceId: "trace-old" });
  now = 1_101;
  expect(journal.checkpoint("namespace:old-turn")).toBeUndefined();
});
