import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptTurnJournal } from "../src/adapters/chatgpt-web/turn-journal";
import { ChatGptCompactionHandoffStore } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const corrupt = "{ broken json at all";

describe("critical store corruption diagnostics (fail-closed, no silent recovery)", () => {
  test("TurnJournal corruption names the store, the cause, and the doctor path — and stays stopped", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-corrupt-journal-"));
    temporaryRoots.push(root);
    const path = join(root, "turn-journal.json");
    writeFileSync(path, corrupt);
    const journal = new ChatGptTurnJournal(path);
    expect(() => journal.checkpoint("execution-1")).toThrow(/Critical state store "TurnJournal" failed validation/);
    expect(() => new ChatGptTurnJournal(path).checkpoint("execution-1")).toThrow(/Execution has been stopped to prevent uncertain duplicate native actions/);
    expect(() => new ChatGptTurnJournal(path).checkpoint("execution-1")).toThrow(/Run doctor/);
    expect(() => new ChatGptTurnJournal(path).checkpoint("execution-1")).toThrow(/not re-initialized or overwritten automatically/);
    // The corrupt file is still exactly there: no auto-quarantine, rename, or reset.
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  test("CompactionHandoff corruption fails closed on every contact without re-initialization", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-corrupt-handoff-"));
    temporaryRoots.push(root);
    const path = join(root, "compaction-handoffs.json");
    writeFileSync(path, JSON.stringify({ version: 1, entries: { key: { summary: 42 } } }));
    const store = new ChatGptCompactionHandoffStore(path);
    expect(() => store.lookup("execution-1")).toThrow(/Critical state store "CompactionHandoff" failed validation/);
    expect(() => store.lookup("execution-1")).toThrow(/Critical state store "CompactionHandoff" failed validation/);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ version: 1, entries: { key: { summary: 42 } } }));
  });

  test("ThreadEnvironment corruption surfaces the actionable message through resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-corrupt-threadenv-"));
    temporaryRoots.push(root);
    const path = join(root, "thread-environments.json");
    writeFileSync(path, corrupt);
    const store = new ChatGptThreadEnvironmentStore(path);
    const request = {
      modelId: "gpt-5.6-sol",
      stream: true,
      context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      options: {},
      _rawBody: {
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "thread_x", turn_id: "turn_x" }) },
        input: [{ type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      },
    } as unknown as Parameters<ChatGptThreadEnvironmentStore["resolve"]>[0];
    expect(() => store.resolve(request)).toThrow(/Critical state store "ThreadEnvironment" failed validation/);
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });

  test("a valid store keeps loading and persisting normally after the diagnostics change", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-valid-journal-"));
    temporaryRoots.push(root);
    const path = join(root, "compaction-handoffs.json");
    const store = new ChatGptCompactionHandoffStore(path);
    expect(store.commit("execution-ok", "fine", "trace")).toEqual({ duplicate: false });
    expect(store.lookup("execution-ok")?.summary).toBe("fine");
    expect(existsSync(path)).toBe(true);
    void ChatGptTurnJournal;
  });
});
