import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import {
  CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS,
  CHATGPT_LUNA_CHECKPOINT_MARKER,
  CHATGPT_RESUME_CHECKPOINT_MARKER,
  ChatGptLunaCheckpointStore,
  ChatGptLunaCheckpointStream,
  ChatGptResumeCheckpointStore,
  ChatGptResumeCheckpointStream,
  hashChatGptLunaAnswer,
  type ChatGptLunaCheckpoint,
} from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const checkpoint: ChatGptLunaCheckpoint = {
  version: 1,
  objective: "Finish the requested repository audit.",
  state: ["The transport was inspected."],
  evidence: ["tests/rolling-checkpoint.test.ts covers the stream boundary."],
  decisions: ["Use an exact-parent checkpoint only on Luna."],
  pending: ["Inspect the remaining files."],
};

function message(role: "developer" | "user" | "assistant", text: string, turnId: string): Record<string, unknown> {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function request(
  threadId: string,
  turnId: string,
  input: Record<string, unknown>[],
) {
  return parseRequest({
    model: "gpt-5.6-luna",
    input,
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  });
}

function resumeRequest(
  threadId: string,
  turnId: string,
  input: Record<string, unknown>[],
  reasoning = "high",
) {
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    input,
    stream: true,
    reasoning: { effort: reasoning },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  });
  parsed.modelId = "gpt-5.6-sol";
  parsed.options.reasoning = reasoning;
  return parsed;
}

test("Luna checkpoint stream hides a marker split across arbitrary DOM deltas", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const checkpointText = "Objective:\nFinish the requested repository audit.\nPending:\n- Inspect remaining files.";
  const raw = `Visible answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${checkpointText}`;
  let visible = "";
  for (let index = 0; index < raw.length; index += (index % 7) + 1) {
    const next = raw.slice(index, index + (index % 7) + 1);
    visible += stream.push(next);
  }
  const completed = stream.finish(raw);
  expect(visible).toBe("Visible answer.");
  expect(completed.answer).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary: checkpointText });
  expect(completed.captured.answerHash).toBe(hashChatGptLunaAnswer("Visible answer."));
  expect(visible).not.toContain("CHECKPOINT");
});

test("Luna checkpoint marker survives the real ChatGPT DOM-to-Markdown serializer", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const domCheckpoint = "State:\n- Inspect src/foo_bar.ts and preserve *literal* [evidence].";
  const segments = [
    { key: "answer", html: "<p>Visible answer.</p>", text: "Visible answer.", streamable: true },
    {
      key: "marker",
      html: `<p>${CHATGPT_LUNA_CHECKPOINT_MARKER}</p>`,
      text: CHATGPT_LUNA_CHECKPOINT_MARKER,
      streamable: true,
    },
    {
      key: "checkpoint",
      html: `<p>${domCheckpoint}</p>`,
      text: domCheckpoint,
      streamable: false,
    },
  ];
  const stream = new ChatGptLunaCheckpointStream();
  const delta = buffer.observe(segments, 0);
  const final = buffer.finish();
  let visible = stream.push(delta);
  visible += stream.push(final.delta);
  const raw = `Visible answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${domCheckpoint}`;
  const completed = stream.finish(raw);
  expect(final.markdown).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(final.markdown).toContain("foo\\_bar.ts");
  expect(visible).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary: domCheckpoint });
});

test("Luna checkpoint treats a malformed quoted payload as opaque semantic state", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const checkpointText = `{"version":1,"objective":"Preserve an opaque record.","state":["A field contains "unescaped quoted text"."],"evidence":[],"decisions":[],"pending":[]}`;
  const raw = `OK.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${checkpointText}`;
  stream.push(raw);

  expect(stream.finish(raw)).toEqual({
    answer: "OK.",
    captured: {
      checkpoint: { version: 2, summary: checkpointText },
      answerHash: hashChatGptLunaAnswer("OK."),
    },
  });
});

test("Luna checkpoint stream preserves the answer and skips the cache when the model omits its private tail", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const visible = stream.push("A normal answer without a checkpoint.");
  expect(visible).toBe("");
  expect(stream.finishOptional("A normal answer without a checkpoint.")).toEqual({
    answer: "A normal answer without a checkpoint.",
    visibleRemainder: "A normal answer without a checkpoint.",
  });
});

test("Luna checkpoint stream still rejects a marker that was lost by Markdown serialization", () => {
  const stream = new ChatGptLunaCheckpointStream();
  stream.push("A normal answer whose Markdown stream omitted the marker.");
  expect(() => stream.finishOptional(
    `A normal answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\nState:\n- preserved only in DOM text`,
  )).toThrow("not preserved in the Markdown stream");
});

test("Luna prompt requests the strict private checkpoint only when capture is enabled", () => {
  const parsed = request("thread_prompt", "turn_prompt", [message("user", "Inspect it.", "turn_prompt")]);
  const capabilities = { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false };
  const normal = compileChatGptWebPrompt(parsed, capabilities);
  const rolling = compileChatGptWebPrompt(parsed, capabilities, undefined, { captureLunaCheckpoint: true });
  expect(normal.text).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(rolling.text).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(rolling.text).toContain("Do not write JSON");
  expect(rolling.text).toContain("never permit an empty checkpoint");
  expect(rolling.text).toContain("Objective:");
  expect(rolling.text).toContain(`${CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS.toLocaleString("en-US")} tokens`);
});

test("Luna checkpoint replaces only exact-parent history and preserves the current native turn", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-luna-checkpoint-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_luna_checkpoint";
  const sourceTurnId = "turn_source";
  const originalTask = `Original task ${"x".repeat(40_000)}`;
  const source = request(threadId, sourceTurnId, [
    message("developer", "Current operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
  ]);
  const answer = "Completed the first step.";
  const store = new ChatGptLunaCheckpointStore(path);
  const textCheckpoint: ChatGptLunaCheckpoint = {
    version: 2,
    summary: "Objective:\nFinish the requested repository audit.\nPending:\n- Inspect the remaining files.",
  };
  store.commit(source, { checkpoint: textCheckpoint, answerHash: hashChatGptLunaAnswer(answer) }, answer);

  const nextTurnId = "turn_next";
  const next = request(threadId, nextTurnId, [
    message("developer", "Old operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("developer", "Fresh operational contract", nextTurnId),
    message("user", "Continue with the second step", nextTurnId),
  ]);
  const applied = new ChatGptLunaCheckpointStore(path).apply(next);
  expect(applied.applied).toBe(true);
  expect(extractChatGptTurnUserRevision(applied.parsed)).toEqual(
    extractChatGptTurnUserRevision(next),
  );
  const encoded = JSON.stringify(applied.parsed.context.messages);
  expect(encoded).toContain("Compressed Luna task history");
  expect(encoded).toContain("Fresh operational contract");
  expect(encoded).toContain("Continue with the second step");
  expect(encoded).not.toContain("Old operational contract");
  expect(encoded).not.toContain("Original task");
  const capabilities = { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false };
  expect(estimateChatGptWebInputTokens(applied.parsed, capabilities))
    .toBeLessThan(estimateChatGptWebInputTokens(next, capabilities));

  const continued = request(threadId, nextTurnId, [
    message("developer", "Old operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("developer", "Fresh operational contract", nextTurnId),
    message("user", "Continue with the second step", nextTurnId),
    message("assistant", "Current-turn progress commentary", nextTurnId),
    {
      type: "function_call",
      call_id: "call_luna_current",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    },
    {
      type: "function_call_output",
      call_id: "call_luna_current",
      output: "current tool evidence",
    },
  ]);
  const appliedContinuation = store.apply(continued);
  expect(appliedContinuation.applied).toBe(true);
  const continuedEncoded = JSON.stringify(appliedContinuation.parsed.context.messages);
  expect(continuedEncoded).toContain("Current-turn progress commentary");
  expect(continuedEncoded).toContain("current tool evidence");
  expect(continuedEncoded).not.toContain("Original task");
  expect(estimateChatGptWebInputTokens(appliedContinuation.parsed, capabilities))
    .toBeGreaterThan(estimateChatGptWebInputTokens(applied.parsed, capabilities));

  const branch = request(threadId, "turn_branch", [
    message("assistant", "A different parent answer.", sourceTurnId),
    message("user", "Continue on another branch", "turn_branch"),
  ]);
  const rejected = new ChatGptLunaCheckpointStore(path).apply(branch);
  expect(rejected.applied).toBe(false);
  expect(rejected.reason).toContain("exact parent");

  const repeatedAnswerWithoutCheckpoint = request(threadId, "turn_after_repeat", [
    message("assistant", answer, "turn_without_checkpoint"),
    message("user", "Continue after the repeated answer", "turn_after_repeat"),
  ]);
  const stale = new ChatGptLunaCheckpointStore(path).apply(repeatedAnswerWithoutCheckpoint);
  expect(stale.applied).toBe(false);
  expect(stale.reason).toContain("source turn");
});

test("Luna checkpoint preserves the server-resolved backend model when the raw body carries a route slug", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-luna-route-checkpoint-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_luna_route";
  const sourceTurnId = "turn_route_source";
  const source = request(threadId, sourceTurnId, [message("user", "Start", sourceTurnId)]);
  const answer = "Started.";
  const store = new ChatGptLunaCheckpointStore(path);
  store.commit(source, { checkpoint, answerHash: hashChatGptLunaAnswer(answer) }, answer);

  const nextTurnId = "turn_route_next";
  const next = request(threadId, nextTurnId, [
    message("assistant", answer, sourceTurnId),
    message("user", "Continue", nextTurnId),
  ]);
  (next._rawBody as { model: string }).model = "chatgpt-web/luna";
  next.modelId = "gpt-5.6-luna";
  next.options.reasoning = "low";

  const applied = store.apply(next);
  expect(applied.applied).toBeTrue();
  expect(applied.parsed.modelId).toBe("gpt-5.6-luna");
  expect(applied.parsed.options.reasoning).toBe("low");
});

test("resume checkpoint stream hides its private tail from the visible answer", () => {
  const stream = new ChatGptResumeCheckpointStream();
  const summary = "Objective:\nResume the exact repository task.\nExact Data:\n- SHA 0123456789abcdef";
  const raw = `Visible answer.\n\n${CHATGPT_RESUME_CHECKPOINT_MARKER}\n${summary}`;
  let visible = "";
  for (let index = 0; index < raw.length; index += 9) visible += stream.push(raw.slice(index, index + 9));
  const completed = stream.finish(raw);
  expect(visible).toBe("Visible answer.");
  expect(completed.answer).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary });
  expect(completed.captured.answerHash).toBe(hashChatGptLunaAnswer("Visible answer."));
});

test("resume checkpoint survives a store restart and replaces exact history with checkpoint plus delta", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_checkpoint";
  const sourceTurnId = "turn_resume_source";
  const originalTask = `Production audit ${"x".repeat(180_000)}`;
  const source = resumeRequest(threadId, sourceTurnId, [
    message("developer", "Preserve every safety invariant.", sourceTurnId),
    message("user", originalTask, sourceTurnId),
  ]);
  const answer = "Baseline audit completed.";
  const resumeCheckpoint: ChatGptLunaCheckpoint = {
    version: 2,
    summary: [
      "Objective:",
      "Resume the performance pass.",
      "Exact Data:",
      "- SHA 089ea199e5941555fc04142ae406dd17e1555309",
      "Pending:",
      "- Continue latency work.",
    ].join("\n"),
  };
  new ChatGptResumeCheckpointStore(path).commit(
    source,
    { checkpoint: resumeCheckpoint, answerHash: hashChatGptLunaAnswer(answer) },
    answer,
  );

  const persisted = readFileSync(path, "utf8");
  expect(persisted).toContain("089ea199e5941555fc04142ae406dd17e1555309");
  expect(persisted).toContain("sourceHistoryHash");
  expect(persisted).toContain("sourcePriorHistoryHash");
  expect(persisted).toContain("sourceTurnInputHash");
  expect(persisted).not.toContain(originalTask);

  const nextTurnId = "turn_resume_next";
  const next = resumeRequest(threadId, nextTurnId, [
    message("developer", "Preserve every safety invariant.", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("developer", "Keep Temporary Chat as the privacy default.", nextTurnId),
    message("user", "Continue from the checkpoint.", nextTurnId),
  ]);
  const applied = new ChatGptResumeCheckpointStore(path).apply(next);
  expect(applied.applied).toBeTrue();
  expect(extractChatGptTurnUserRevision(applied.parsed)).toEqual(extractChatGptTurnUserRevision(next));
  const encoded = JSON.stringify(applied.parsed.context.messages);
  expect(encoded).toContain("Verified local cumulative task checkpoint");
  expect(encoded).toContain("089ea199e5941555fc04142ae406dd17e1555309");
  expect(encoded).toContain("Keep Temporary Chat as the privacy default.");
  expect(encoded).toContain("Continue from the checkpoint.");
  expect(encoded).not.toContain(originalTask);
});

test("resume checkpoint rejects changed earlier history even when source input and parent answer are unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-prior-history-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_prior_history";
  const sourceTurnId = "turn_resume_source";
  const source = resumeRequest(threadId, sourceTurnId, [
    message("user", "Earlier constraint: keep all tests.", "turn_earlier"),
    message("user", "Inspect the repository.", sourceTurnId),
  ]);
  const answer = "Repository work completed.";
  new ChatGptResumeCheckpointStore(path).commit(source, {
    checkpoint: {
      version: 2,
      summary: "Objective:\nContinue the verified repository task.",
    },
    answerHash: hashChatGptLunaAnswer(answer),
  }, answer);

  const changedHistory = resumeRequest(threadId, "turn_resume_next", [
    message("user", "Earlier constraint: skip all tests.", "turn_earlier"),
    message("user", "Inspect the repository.", sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("user", "Continue.", "turn_resume_next"),
  ]);
  const store = new ChatGptResumeCheckpointStore(path);
  expect(store.hasCandidate(changedHistory)).toBeTrue();
  const result = store.apply(changedHistory);
  expect(result.applied).toBeFalse();
  expect(result.reason).toContain("history prefix diverged");
  expect(result.parsed.context.messages).toEqual(changedHistory.context.messages);
});

test("resume checkpoint tolerates same-turn tool rounds between the source instruction and final answer", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-tool-rounds-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_tool_rounds";
  const sourceTurnId = "turn_resume_source";
  const source = resumeRequest(threadId, sourceTurnId, [
    message("user", "Inspect the repository and continue through tool rounds.", sourceTurnId),
  ]);
  const answer = "Repository work completed.";
  const checkpointValue: ChatGptLunaCheckpoint = {
    version: 2,
    summary: "Objective:\nContinue the verified repository task.\nPending:\n- Wait for the next instruction.",
  };
  new ChatGptResumeCheckpointStore(path).commit(
    source,
    { checkpoint: checkpointValue, answerHash: hashChatGptLunaAnswer(answer) },
    answer,
  );

  const next = resumeRequest(threadId, "turn_resume_next", [
    message("user", "Inspect the repository and continue through tool rounds.", sourceTurnId),
    message("assistant", "Checking the relevant files.", sourceTurnId),
    {
      type: "reasoning",
      summary: [],
      content: [],
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    {
      type: "function_call",
      name: "read_file",
      call_id: "call_resume_1",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    {
      type: "function_call_output",
      call_id: "call_resume_1",
      output: "tool result",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    message("assistant", answer, sourceTurnId),
    message("user", "Continue from the checkpoint.", "turn_resume_next"),
  ]);

  const applied = new ChatGptResumeCheckpointStore(path).apply(next);
  expect(applied.applied).toBeTrue();
  expect(extractChatGptTurnUserRevision(applied.parsed)).toEqual(extractChatGptTurnUserRevision(next));
});

test("legacy resume checkpoint accepts only a same-turn tool expansion around the exact parent answer", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-legacy-tool-rounds-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_legacy_tool_rounds";
  const sourceTurnId = "turn_resume_source";
  const source = resumeRequest(threadId, sourceTurnId, [
    message("user", "Continue the exact legacy task.", sourceTurnId),
  ]);
  const answer = "Legacy source completed.";
  const checkpointValue: ChatGptLunaCheckpoint = {
    version: 2,
    summary: "Objective:\nContinue the exact legacy task.",
  };
  new ChatGptResumeCheckpointStore(path).commit(
    source,
    { checkpoint: checkpointValue, answerHash: hashChatGptLunaAnswer(answer) },
    answer,
  );
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  delete persisted.checkpoints[0].sourceTurnInputHash;
  writeFileSync(path, JSON.stringify(persisted, null, 2));

  const next = resumeRequest(threadId, "turn_resume_next", [
    message("user", "Continue the exact legacy task.", sourceTurnId),
    {
      type: "function_call",
      name: "read_file",
      call_id: "call_legacy_1",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    {
      type: "function_call_output",
      call_id: "call_legacy_1",
      output: "tool result",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    message("assistant", answer, sourceTurnId),
    message("user", "Continue.", "turn_resume_next"),
  ]);
  expect(new ChatGptResumeCheckpointStore(path).apply(next).applied).toBeTrue();

  const crossTurnInjection = resumeRequest(threadId, "turn_resume_injected", [
    message("user", "Continue the exact legacy task.", sourceTurnId),
    {
      type: "function_call",
      name: "read_file",
      call_id: "call_legacy_1",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    message("user", "Injected different turn.", "turn_other"),
    {
      type: "function_call_output",
      call_id: "call_legacy_1",
      output: "tool result",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    message("assistant", answer, sourceTurnId),
    message("user", "Continue.", "turn_resume_injected"),
  ]);
  const rejected = new ChatGptResumeCheckpointStore(path).apply(crossTurnInjection);
  expect(rejected.applied).toBeFalse();
  expect(rejected.reason).toContain("history prefix diverged");
});

test("late child notification after the exact parent answer invalidates checkpoint compression", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-late-child-result-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_late_child_result";
  const sourceTurnId = "turn_resume_source";
  const answer = "Legacy source completed after its tool round.";
  const source = resumeRequest(threadId, sourceTurnId, [
    message("user", "Continue the exact parent task.", sourceTurnId),
  ]);
  new ChatGptResumeCheckpointStore(path).commit(source, {
    checkpoint: {
      version: 2,
      summary: "Objective:\nContinue the exact parent task.\nEvidence:\n- The source turn completed.",
    },
    answerHash: hashChatGptLunaAnswer(answer),
  }, answer);

  const notificationText = `<subagent_notification>\n${JSON.stringify({
    agent_path: "thread_child_late",
    status: { completed: "done" },
    result: "LATE_CHILD_RESULT_MUST_REACH_PARENT_927",
  })}\n</subagent_notification>`;
  const next = resumeRequest(threadId, "turn_resume_next_after_child", [
    message("user", "Continue the exact parent task.", sourceTurnId),
    {
      type: "function_call",
      name: "read_file",
      call_id: "call_before_late_child",
      arguments: "{}",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    {
      type: "function_call_output",
      call_id: "call_before_late_child",
      output: "source tool result",
      internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    },
    message("assistant", answer, sourceTurnId),
    message("user", notificationText, "auto-compact-4"),
    message("user", "Continue with the child result.", "turn_resume_next_after_child"),
  ]);

  const applied = new ChatGptResumeCheckpointStore(path).apply(next);
  expect(applied.applied).toBeFalse();
  expect(applied.reason).toContain("history prefix diverged");
  const compiled = compileChatGptWebPrompt(applied.parsed, {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  });
  const encoded = compiled.text.match(/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/)?.[1];
  if (!encoded) throw new Error("inline Codex context JSON missing");
  const modelMessages = (JSON.parse(encoded) as { messages: Array<{ content?: unknown }> }).messages;
  const delivered = modelMessages.flatMap(item => {
    if (typeof item.content === "string") return [item.content];
    if (!Array.isArray(item.content)) return [];
    return item.content.flatMap(part => (
      part !== null && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
        ? [(part as Record<string, string>).text]
        : []
    ));
  });
  expect(delivered.filter(text => text === notificationText)).toHaveLength(1);
  expect(JSON.stringify(applied.parsed.context.messages)).not.toContain("Verified local cumulative task checkpoint");
});

test("resume checkpoint fails closed on divergent history, model effort changes, or corrupt local state", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-invalid-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_invalid";
  const sourceTurnId = "turn_resume_source";
  const answer = "Completed source turn.";
  const source = resumeRequest(threadId, sourceTurnId, [
    message("user", "Original exact task", sourceTurnId),
  ]);
  const checkpointValue: ChatGptLunaCheckpoint = { version: 2, summary: "Objective:\nContinue exact task." };
  new ChatGptResumeCheckpointStore(path).commit(
    source,
    { checkpoint: checkpointValue, answerHash: hashChatGptLunaAnswer(answer) },
    answer,
  );

  const divergent = resumeRequest(threadId, "turn_next", [
    message("user", "Modified task history", sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("user", "Continue", "turn_next"),
  ]);
  const divergentStore = new ChatGptResumeCheckpointStore(path);
  expect(divergentStore.hasCandidate(divergent)).toBeTrue();
  const rejected = divergentStore.apply(divergent);
  expect(rejected.applied).toBeFalse();
  expect(rejected.reason).toContain("source turn input diverged");

  const changedEffort = resumeRequest(threadId, "turn_next_effort", [
    message("user", "Original exact task", sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("user", "Continue", "turn_next_effort"),
  ], "medium");
  const effortStore = new ChatGptResumeCheckpointStore(path);
  expect(effortStore.hasCandidate(changedEffort)).toBeFalse();
  const effortRejected = effortStore.apply(changedEffort);
  expect(effortRejected.applied).toBeFalse();
  expect(effortRejected.reason).toContain("model contract");

  writeFileSync(path, "{ definitely not valid json");
  const corruptFallback = new ChatGptResumeCheckpointStore(path).apply(resumeRequest(threadId, "turn_after_corrupt", [
    message("user", "Original exact task", sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("user", "Continue safely", "turn_after_corrupt"),
  ]));
  expect(corruptFallback.applied).toBeFalse();
  expect(corruptFallback.reason).toContain("store unavailable");
});

test("checkpoint plus delta recovers after repeated native compactions and bounds twenty turns with large tool results", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-bounded-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_bounded";
  const seedTurnId = "turn_resume_seed";
  const oldHistory = Array.from({ length: 6 }, (_, index) => message(
    "user",
    "INITIAL_HISTORY_" + index + "_" + "source code ".repeat(4_000),
    "turn_old_" + index,
  ));
  const seedUser = message("user", "Summarize the initial coding history.", seedTurnId);
  const seedAnswer = "The initial history was summarized.";
  const seed = resumeRequest(threadId, seedTurnId, [...oldHistory, seedUser]);
  new ChatGptResumeCheckpointStore(path).commit(seed, {
    checkpoint: { version: 2, summary: "Objective:\nContinue the coding task.\nPending:\n- Verify bounded resume." },
    answerHash: hashChatGptLunaAnswer(seedAnswer),
  }, seedAnswer);

  let previousTurnId = seedTurnId;
  let previousUser = seedUser;
  let previousToolItems: Record<string, unknown>[] = [];
  let previousAnswer = seedAnswer;
  let canonicalInput: Record<string, unknown>[] = [
    ...oldHistory,
    seedUser,
    message("assistant", seedAnswer, seedTurnId),
    message("user", "Continue turn 0.", "turn_resume_bounded_0"),
  ];
  const capabilities = {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  };
  let peakCanonicalChars = 0;
  let peakPreparedTokens = 0;

  for (let index = 0; index < 20; index += 1) {
    const turnId = "turn_resume_bounded_" + index;
    if (index === 6 || index === 13) {
      canonicalInput = [
        message(
          "developer",
          "NATIVE_COMPACTION_SUMMARY_EPOCH_" + index + ": prior work and decisions retained.",
          "turn_compaction_" + index,
        ),
        previousUser,
        ...previousToolItems,
        message("assistant", previousAnswer, previousTurnId),
        message("user", "Continue after compaction " + index + ".", turnId),
      ];
    }

    const parsed = resumeRequest(threadId, turnId, canonicalInput);
    const applied = new ChatGptResumeCheckpointStore(path).apply(parsed);
    if (index === 6 || index === 13) {
      expect(applied.applied).toBeFalse();
      expect(applied.reason).toContain("history prefix diverged");
      expect(JSON.stringify(applied.parsed.context.messages)).toContain("NATIVE_COMPACTION_SUMMARY_EPOCH_" + index);
      expect(JSON.stringify(applied.parsed.context.messages)).not.toContain("Verified local cumulative task checkpoint");
    } else {
      expect(applied.applied).toBeTrue();
      expect(applied.parsed.context.messages).toHaveLength(2);
      const preparedTokens = estimateChatGptWebInputTokens(applied.parsed, capabilities);
      peakPreparedTokens = Math.max(peakPreparedTokens, preparedTokens);
      expect(preparedTokens).toBeLessThan(12_000);
    }

    const callId = "call_large_result_" + index;
    const toolItems: Record<string, unknown>[] = [
      {
        type: "function_call",
        name: "exec_command",
        call_id: callId,
        arguments: "{}",
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ result: "TOOL_RESULT_SENTINEL_" + index + "_" + "x".repeat(20_000) }),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ];
    const answer = "Turn " + index + " completed with its tool result preserved in the local checkpoint.";
    const executedInput = [...canonicalInput, ...toolItems];
    const executed = resumeRequest(threadId, turnId, executedInput);
    new ChatGptResumeCheckpointStore(path).commit(executed, {
      checkpoint: {
        version: 2,
        summary: [
          "Objective:", "Continue the bounded coding task.",
          "State:", "- Turn " + index + " completed after the current native history boundary.",
          "Constraints:", "- Preserve prior decisions and the current task.",
          "Evidence:", "- Large tool results were included in the source turn.",
          "Decisions:", "- Resume using the exact checkpoint and next-turn delta.",
          "Exact Data:", "- No raw tool result is stored in this summary.",
          "Pending:", "- Continue the remaining bounded-turn checks.",
        ].join("\n"),
      },
      answerHash: hashChatGptLunaAnswer(answer),
    }, answer);

    previousTurnId = turnId;
    previousUser = canonicalInput.findLast(item => (
      (item.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined)?.turn_id === turnId
    ))!;
    previousToolItems = toolItems;
    previousAnswer = answer;
    const nextTurnId = "turn_resume_bounded_" + (index + 1);
    canonicalInput = [
      ...executedInput,
      message("assistant", answer, turnId),
      message("user", "Continue turn " + (index + 1) + ".", nextTurnId),
    ];
    peakCanonicalChars = Math.max(peakCanonicalChars, JSON.stringify(canonicalInput).length);
  }

  const persisted = readFileSync(path, "utf8");
  expect(persisted).not.toContain("INITIAL_HISTORY_");
  expect(persisted).not.toContain("TOOL_RESULT_SENTINEL_");
  expect(peakCanonicalChars).toBeGreaterThan(peakPreparedTokens * 20);
  expect(peakPreparedTokens).toBeLessThan(12_000);
});

test("resume checkpoint turns a long restart replay into a one-message checkpoint plus delta payload", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-resume-checkpoint-multipart-"));
  roots.push(root);
  const path = join(root, "resume-checkpoints.json");
  const threadId = "thread_resume_multipart";
  const sourceTurnId = "turn_resume_source";
  const originalTask = Array.from({ length: 8 }, (_, index) => message(
    "user",
    `Large task segment ${index + 1}: ${"word ".repeat(6_000)}`,
    sourceTurnId,
  ));
  const source = resumeRequest(threadId, sourceTurnId, originalTask);
  const answer = "Long task state established.";
  const checkpointValue: ChatGptLunaCheckpoint = {
    version: 2,
    summary: "Objective:\nContinue the long task.\nPending:\n- Execute the next requested step.",
  };
  new ChatGptResumeCheckpointStore(path).commit(
    source,
    { checkpoint: checkpointValue, answerHash: hashChatGptLunaAnswer(answer) },
    answer,
  );
  const next = resumeRequest(threadId, "turn_resume_next", [
    ...originalTask,
    message("assistant", answer, sourceTurnId),
    message("user", "Continue now.", "turn_resume_next"),
  ]);
  const capabilities = {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  };
  const before = resolveBiggerContextMultipartParts(next, capabilities);
  const applied = new ChatGptResumeCheckpointStore(path).apply(next);
  expect(applied.applied).toBeTrue();
  const after = resolveBiggerContextMultipartParts(applied.parsed, capabilities);
  // V-B: the restored 81,807-token single-message budget carries the whole replay inline.
  expect(before).toBeUndefined();
  expect(after).toBeUndefined();
});
