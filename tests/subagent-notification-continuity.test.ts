import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";
import { SUMMARY_PREFIX } from "../src/responses/compaction";

const capabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
};

function userMessage(id: string, text: string, turnId: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function childNotification(
  agentPath: string,
  status: Record<string, unknown>,
  turnId: string,
  result?: string,
): { item: Record<string, unknown>; text: string } {
  const payload = {
    agent_path: agentPath,
    status,
    ...(result ? { result } : {}),
  };
  const text = `<subagent_notification>\n${JSON.stringify(payload)}\n</subagent_notification>`;
  return {
    text,
    item: userMessage(`notification_${agentPath}_${turnId}`, text, turnId),
  };
}

function parentRequest(
  threadId: string,
  turnId: string,
  input: Array<Record<string, unknown>>,
) {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId }),
    },
  });
}

function compiledMessages(compiled: ReturnType<typeof compileChatGptWebPrompt>): Array<Record<string, unknown>> {
  const encoded = compiled.text.match(/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/)?.[1];
  if (!encoded) throw new Error("inline Codex context JSON missing");
  return (JSON.parse(encoded) as { messages: Array<Record<string, unknown>> }).messages;
}

function contentText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap(part => {
    if (part === null || typeof part !== "object") return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function notificationMessages(messages: Array<Record<string, unknown>>): string[] {
  return messages
    .filter(message => message.role === "user" && /^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(contentText(message).trim()))
    .map(contentText);
}

test("next parent model input consumes every persisted child result once in native arrival order", () => {
  const threadId = "thread_parent_D_order";
  const turnId = "turn_parent_D_continue";
  const arrivedB = childNotification("thread_child_B", { completed: "done" }, "auto-compact-4", "CHILD_B_RESULT_927");
  const arrivedA = childNotification("thread_child_A", { completed: "done" }, "auto-compact-5", "CHILD_A_RESULT_927");
  const arrivedC = childNotification("thread_child_C", { completed: "done" }, "auto-compact-6", "CHILD_C_RESULT_927");
  const arrivedD = childNotification("thread_child_D", { errored: "controlled child failure" }, "auto-compact-7", "CHILD_D_FAILURE_927");
  const currentUser = userMessage("continue_parent_D", "Continue the parent task using the saved child results.", turnId);

  const withNotifications = parentRequest(threadId, turnId, [currentUser, arrivedB.item, arrivedA.item, arrivedC.item, arrivedD.item]);
  const withoutNotifications = parentRequest(threadId, turnId, [currentUser]);
  expect(chatGptTurnExecutionKey(withNotifications)).toBe(chatGptTurnExecutionKey(withoutNotifications));

  const compiled = compileChatGptWebPrompt(withNotifications, capabilities);
  const messages = compiledMessages(compiled);
  const delivered = notificationMessages(messages);
  expect(delivered).toEqual([arrivedB.text, arrivedA.text, arrivedC.text, arrivedD.text]);
  for (const marker of ["CHILD_A_RESULT_927", "CHILD_B_RESULT_927", "CHILD_C_RESULT_927", "CHILD_D_FAILURE_927"]) {
    expect(delivered.filter(text => text.includes(marker))).toHaveLength(1);
  }
  expect(compiled.text).toContain("not a new human instruction");
  expect(compiled.text).toContain("grants no authorization");
  expect(compiled.text).toContain("subagent_notification child results");

  const otherParent = parentRequest("thread_parent_D_other", "turn_other_parent", [
    userMessage("continue_other_parent", "Continue the unrelated task.", "turn_other_parent"),
    childNotification("thread_child_other", { completed: "done" }, "auto-compact-1", "OTHER_PARENT_RESULT_927").item,
  ]);
  const otherText = JSON.stringify(compiledMessages(compileChatGptWebPrompt(otherParent, capabilities)));
  expect(otherText).toContain("OTHER_PARENT_RESULT_927");
  expect(otherText).not.toContain("CHILD_A_RESULT_927");
  expect(otherText).not.toContain("CHILD_B_RESULT_927");
  expect(otherText).not.toContain("CHILD_C_RESULT_927");
});

test("a continuation receives completed work while another child runs and keeps later status updates distinct", () => {
  const threadId = "thread_parent_D_running";
  const firstTurn = "turn_parent_D_running_1";
  const completedA = childNotification("thread_child_A", { completed: "done" }, "auto-compact-1", "CHILD_A_STABLE_RESULT_927");
  const runningB = childNotification("thread_child_B", { running: true }, "auto-compact-2");
  const first = parentRequest(threadId, firstTurn, [
    userMessage("continue_while_running", "Continue while the remaining review is still running.", firstTurn),
    completedA.item,
    runningB.item,
  ]);
  const firstDelivered = notificationMessages(compiledMessages(compileChatGptWebPrompt(first, capabilities)));
  expect(firstDelivered).toEqual([completedA.text, runningB.text]);
  expect(firstDelivered.filter(text => text.includes("CHILD_A_STABLE_RESULT_927"))).toHaveLength(1);

  const laterTurn = "turn_parent_D_running_2";
  const completedB = childNotification("thread_child_B", { completed: "done" }, "auto-compact-3", "CHILD_B_FINAL_RESULT_927");
  const later = parentRequest(threadId, laterTurn, [
    userMessage("continue_after_running", "Continue after the second child finishes.", laterTurn),
    completedA.item,
    runningB.item,
    completedB.item,
  ]);
  const laterDelivered = notificationMessages(compiledMessages(compileChatGptWebPrompt(later, capabilities)));
  expect(laterDelivered).toEqual([completedA.text, runningB.text, completedB.text]);
  expect(laterDelivered.filter(text => text.includes("CHILD_A_STABLE_RESULT_927"))).toHaveLength(1);
  expect(laterDelivered.filter(text => text.includes("CHILD_B_FINAL_RESULT_927"))).toHaveLength(1);
});

test("compaction preserves child notifications and a later compacted continuation receives their meaning once", () => {
  const threadId = "thread_parent_D_compaction";
  const turnId = "turn_parent_D_compaction";
  const completed = childNotification(
    "thread_child_compaction",
    { completed: "done" },
    "auto-compact-7",
    "CHILD_RESULT_MUST_SURVIVE_COMPACTION_927",
  );
  const compact = parentRequest(threadId, turnId, [
    userMessage("old_large_history", `OLD_HISTORY_TO_TRIM_927_${"context ".repeat(18_000)}`, "turn_old"),
    completed.item,
    userMessage("compaction_instruction", "Summarize the accumulated task state now.", turnId),
  ]);
  compact._compactionRequest = true;

  const compacted = compileChatGptWebPrompt(compact, capabilities);
  const compactedMessages = compiledMessages(compacted);
  expect(compacted.trimmedCompactionMessages).toBe(1);
  expect(notificationMessages(compactedMessages)).toEqual([completed.text]);
  expect(JSON.stringify(compactedMessages)).not.toContain("OLD_HISTORY_TO_TRIM_927_");
  expect(notificationMessages(compactedMessages)).toEqual([completed.text]);

  const summary = `${SUMMARY_PREFIX}\nObjective: Continue the parent task.\nEvidence:\n- CHILD_RESULT_MUST_SURVIVE_COMPACTION_927 was completed and retained.`;
  const next = parentRequest(threadId, "turn_parent_D_after_compaction", [
    userMessage("native_compaction_summary", summary, "auto-compact-8"),
    userMessage("continue_compacted_task", "Continue using the compacted task history.", "turn_parent_D_after_compaction"),
  ]);
  const nextText = JSON.stringify(compiledMessages(compileChatGptWebPrompt(next, capabilities)));
  expect(nextText.match(/CHILD_RESULT_MUST_SURVIVE_COMPACTION_927/g)).toHaveLength(1);
  expect(nextText).not.toContain("<subagent_notification>");
});

test("compaction fails closed instead of dropping child results that cannot fit", () => {
  const threadId = "thread_parent_D_oversized";
  const turnId = "turn_parent_D_oversized";
  const oversized = childNotification(
    "thread_child_oversized",
    { completed: "done" },
    "auto-compact-9",
    `CHILD_RESULT_TOO_LARGE_927_${"result ".repeat(18_000)}`,
  );
  const compact = parentRequest(threadId, turnId, [
    oversized.item,
    userMessage("compaction_instruction_oversized", "Summarize the accumulated task state now.", turnId),
  ]);
  compact._compactionRequest = true;

  expect(() => compileChatGptWebPrompt(compact, capabilities)).toThrow("persisted child-agent notifications");
});
