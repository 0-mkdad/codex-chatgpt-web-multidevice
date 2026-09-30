import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chatGptEnvironmentResolutionProbes,
  extractChatGptMidTurnEnvironmentClaim,
  extractChatGptTurnEnvironment,
  matchChatGptNoCwdEnvironmentDelta,
} from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest } from "../src/types";

const root = resolve(process.cwd());
const vizRoot = resolve(tmpdir(), "codex-viz-fixture-output");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

const workspaceWriteProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry><entry access="read"><path>${root}/.git</path></entry></file_system></permission_profile>`;

const readOnlyProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile>`;

/** The exact no-cwd midnight shape observed from Codex Desktop 0.155.0-alpha.9.2 (2026-09-30). */
function managedNoCwdDeltaXml(profileXml: string, roots: string[]): string {
  return `<environment_context>
  <current_date>2026-09-30</current_date>
  <timezone>Europe/Berlin</timezone>
  <filesystem><workspace_roots>${roots.map(path => `<root>${path}</root>`).join("")}</workspace_roots>${profileXml}</filesystem>
</environment_context>`;
}

function currentWire(options: { sandbox?: string; workspaces?: string[] } = {}): CodexParsedRequest {
  const workspaces = options.workspaces ?? [root];
  const turnMetadata = {
    thread_id: "thread_current",
    turn_id: "turn_current",
    sandbox: options.sandbox ?? "none",
    workspaces: Object.fromEntries(workspaces.map(path => [path, { has_changes: true }])),
  };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the workspace", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [
        {
          type: "message",
          id: "msg_context",
          role: "user",
          content: [{ type: "input_text", text: environmentXml }],
        },
        {
          type: "message",
          id: "msg_active",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace" }],
        },
      ],
    },
  };
}

const rolloutThreadId = "01a06c66-4232-7ae1-9108-69b5f70e0671";
const rolloutTurnId = "01a06c66-4380-75c6-a0df-318f890ef6de";
const rolloutParentId = "01a06c66-18ad-73e1-a641-9b114f2ed10c";
const rolloutAgent = "/root/rollout_child";

function managedWorkspaceWriteEntries(): Array<Record<string, unknown>> {
  return [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    { path: { type: "path", path: root }, access: "write" },
    { path: { type: "path", path: vizRoot }, access: "write" },
    { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
    { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
    { path: { type: "path", path: join(root, ".git") }, access: "read", missing_path_behavior: "skip" },
  ];
}

function workspaceWriteTurnContext(): Record<string, unknown> {
  return {
    type: "turn_context",
    payload: {
      turn_id: rolloutTurnId,
      cwd: root,
      workspace_roots: [root, vizRoot],
      approval_policy: "on-request",
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [vizRoot],
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
      file_system_sandbox_policy: { kind: "restricted", entries: managedWorkspaceWriteEntries() },
      permission_profile: {
        type: "managed",
        network: "restricted",
        file_system: { type: "restricted", entries: managedWorkspaceWriteEntries() },
      },
    },
  };
}

function workspaceWriteLineage(options: { subagent: boolean; sandboxMode?: string }): CodexParsedRequest {
  const turnMetadata: Record<string, unknown> = {
    request_kind: "turn",
    thread_id: rolloutThreadId,
    turn_id: rolloutTurnId,
    ...(options.subagent
      ? { parent_thread_id: rolloutParentId, agent_name: rolloutAgent, subagent_kind: "thread_spawn" }
      : { agent_name: "/root" }),
    sandbox_mode: options.sandboxMode ?? "workspace-write",
    workspaces: { [root]: { has_changes: true }, [vizRoot]: { has_changes: false } },
  };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Audit the repository", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [
        {
          type: "message",
          id: "msg_active",
          role: "user",
          content: [{ type: "input_text", text: "Audit the repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
        },
      ],
    },
  };
}

function midnightDeltaFixture(options: {
  subagent: boolean;
  deltaXml: string;
  sandboxMode?: string;
  turnContext?: Record<string, unknown>;
}): { codexHome: string; request: CodexParsedRequest; rolloutPath: string } {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-midnight-delta-"));
  temporaryRoots.push(codexHome);
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "29",
    `rollout-2026-09-29T22-19-14-${rolloutThreadId}.jsonl`);
  mkdirSync(join(codexHome, "sessions", "2026", "09", "29"), { recursive: true });
  const sessionMeta = options.subagent
    ? {
      type: "session_meta",
      payload: {
        id: rolloutThreadId,
        parent_thread_id: rolloutParentId,
        cwd: root,
        source: { subagent: { thread_spawn: { parent_thread_id: rolloutParentId, depth: 1, agent_path: rolloutAgent } } },
        thread_source: "subagent",
        agent_path: rolloutAgent,
      },
    }
    : {
      type: "session_meta",
      payload: { id: rolloutThreadId, cwd: root, source: "vscode" },
    };
  writeFileSync(rolloutPath, [
    JSON.stringify(sessionMeta),
    JSON.stringify(options.turnContext ?? workspaceWriteTurnContext()),
  ].join("\n") + "\n");
  const request = workspaceWriteLineage({ subagent: options.subagent, sandboxMode: options.sandboxMode });
  const body = request._rawBody as { input: Array<Record<string, unknown>> };
  body.input.push(
    { type: "function_call", id: "fc_midnight", call_id: "call_midnight", name: "fixture", arguments: "{}" },
    { type: "function_call_output", call_id: "call_midnight", output: "done" },
    {
      type: "message",
      id: "msg_midnight_delta",
      role: "user",
      content: [{ type: "input_text", text: options.deltaXml }],
      internal_chat_message_metadata_passthrough: { turn_id: rolloutTurnId },
    },
  );
  return { codexHome, request, rolloutPath };
}

function traceDetailEvents(warn: ReturnType<typeof spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls.map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes("environment_resolution_failed"))
    .map((line: string) => JSON.parse(line.replace("[chatgpt-web-trace] ", "")));
}

describe("trusted current Codex environment envelope: mid-turn updates", () => {
  test("1. a normal direct turn resolves from its adjacent same-turn envelope", () => {
    expect(extractChatGptTurnEnvironment(currentWire()).cwd).toBe(root);
  });

  test("2. a same-turn skill-appended message after the prompt keeps the earlier same-turn envelope", () => {
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    body.input[1]!.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
    body.input.push(
      { type: "message", id: "msg_assistant", role: "assistant", content: [{ type: "output_text", text: "Working." }] },
      {
        type: "message", id: "msg_skill", role: "user",
        content: [{ type: "input_text", text: "<skill_invocation>do</skill_invocation>" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_current" },
      },
    );
    expect(extractChatGptTurnEnvironment(request).cwd).toBe(root);
  });

  test("3. a server-owned developer message between the envelope and the prompt is skipped", () => {
    const request = currentWire();
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    body.input.splice(1, 0, {
      type: "message",
      id: "msg_developer",
      role: "developer",
      content: [{ type: "input_text", text: "<skills_instructions>skills</skills_instructions>" }],
    });
    expect(extractChatGptTurnEnvironment(request).cwd).toBe(root);
  });

  test("4. a resumed root thread recovers its managed workspace-write authority from the current rollout", () => {
    const { codexHome, request } = midnightDeltaFixture({
      subagent: false,
      deltaXml: managedNoCwdDeltaXml(workspaceWriteProfileXml, [root, vizRoot]),
    });
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  });

  test("5. a subagent thread recovers its managed workspace-write authority from the current rollout", () => {
    const { codexHome, request } = midnightDeltaFixture({
      subagent: true,
      deltaXml: managedNoCwdDeltaXml(workspaceWriteProfileXml, [root, vizRoot]),
    });
    const environment = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request);
    expect(environment.cwd).toBe(root);
    expect(environment.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [root, vizRoot], networkAccess: false });
  });

  test("6. a compaction-flagged request with a no-cwd delta still resolves from its rollout", () => {
    const { codexHome, request } = midnightDeltaFixture({
      subagent: false,
      deltaXml: managedNoCwdDeltaXml(workspaceWriteProfileXml, [root, vizRoot]),
    });
    const compact = { ...request, _compactionRequest: true } as CodexParsedRequest;
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(compact).cwd).toBe(root);
  });

  test("7. malformed or untrusted mid-turn delta shapes stay fail-closed", () => {
    const { codexHome, request } = midnightDeltaFixture({
      subagent: true,
      deltaXml: managedNoCwdDeltaXml(workspaceWriteProfileXml, [root, vizRoot]),
    });
    const body = request._rawBody as { input: Array<Record<string, unknown>> };
    const delta = body.input.at(-1)! as { content: Array<{ text: string }> };
    const original = delta.content[0]!.text;
    for (const invalid of [
      original.replace("<current_date>", "<cwd/><current_date>"),
      original.replace(workspaceWriteProfileXml, readOnlyProfileXml + workspaceWriteProfileXml),
      original.replace(`<root>${vizRoot}</root>`, "<root>relative/path</root>"),
      original.replace(`<root>${root}</root>`, "<root>D:\\outside-untrusted-root</root>"),
      original.replace('type="managed"', 'type="external"'),
    ]) {
      delta.content[0]!.text = invalid;
      expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toThrow();
    }
    delta.content[0]!.text = original;
  });

  test("8. a no-cwd delta without current rollout proof fails closed even with a populated cache", () => {
    const warn = spyOn(console, "warn");
    try {
      const { codexHome, request, rolloutPath } = midnightDeltaFixture({
        subagent: false,
        deltaXml: managedNoCwdDeltaXml(workspaceWriteProfileXml, [root, vizRoot]),
      });
      const store = new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome);
      expect(store.resolve(request).cwd).toBe(root);
      rmSync(rolloutPath);
      expect(() => store.resolve(request)).toThrow("missing cwd");
      const events = traceDetailEvents(warn);
      expect(events.length).toBeGreaterThan(0);
      const detail = events.at(-1)!.detail as Record<string, unknown>;
      expect(detail.no_cwd_profile_delta).toBe(true);
      expect(detail.rollout_recovered).toBe(false);
      expect(detail.cached_thread_environment_present).toBe(true);
      expect(detail.rejection_reason).toBe("current_environment_claim_without_rollout_corroboration");
      expect(detail.threadHash).toBeString();
      expect(detail).not.toHaveProperty("cwd");
    } finally {
      warn.mockRestore();
    }
  });

  test("9. a same-turn full-envelope mid-turn claim recovers only through its current rollout", () => {
    const bothRootsProfileXml = `<permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry><entry access="write"><path>${vizRoot}</path></entry><entry access="write"><special>:slash_tmp</special></entry><entry access="write"><special>:tmpdir</special></entry></file_system></permission_profile>`;
    const claimXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${vizRoot}</root></workspace_roots>${bothRootsProfileXml}</filesystem>
</environment_context>`;
    const { codexHome, request } = midnightDeltaFixture({ subagent: false, deltaXml: claimXml });
    expect(extractChatGptMidTurnEnvironmentClaim(request)?.cwd).toBe(root);
    expect(new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request).cwd).toBe(root);
  });

  test("10. a conflicting mid-turn claim is rejected against its current rollout", () => {
    const otherRoot = resolve(tmpdir(), "codex-conflicting-cwd");
    const claimXml = `<environment_context>
  <cwd>${otherRoot}</cwd>
  <filesystem><workspace_roots><root>${otherRoot}</root></workspace_roots>${workspaceWriteProfileXml.replaceAll(root, otherRoot)}</filesystem>
</environment_context>`;
    const { codexHome, request } = midnightDeltaFixture({ subagent: false, deltaXml: claimXml });
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
      .toThrow("Mid-turn environment conflicts with its current Codex rollout");
  });

  test("11. a delta whose sandbox class conflicts with the request metadata fails closed", () => {
    const { codexHome, request } = midnightDeltaFixture({
      subagent: false,
      deltaXml: managedNoCwdDeltaXml(readOnlyProfileXml, [root]),
    });
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toThrow("missing cwd");
  });

  test("12. a read-only delta against a workspace-write rollout fails closed on metadata conflict", () => {
    const { codexHome, request } = midnightDeltaFixture({
      subagent: false,
      sandboxMode: "read-only",
      deltaXml: managedNoCwdDeltaXml(readOnlyProfileXml, [root]),
    });
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request))
      .toThrow("sandbox metadata conflicts with its Codex rollout");
  });

  test("13. recognizer and probes report the live no-cwd shape honestly", () => {
    const { request } = midnightDeltaFixture({
      subagent: true,
      deltaXml: managedNoCwdDeltaXml(workspaceWriteProfileXml, [root, vizRoot]),
    });
    expect(matchChatGptNoCwdEnvironmentDelta(request)).toEqual({
      sandboxType: "workspaceWrite",
      declaresWorkspaceRoots: true,
    });
    expect(chatGptEnvironmentResolutionProbes(request)).toEqual({
      environmentFragmentCount: 1,
      currentTurnFragmentCount: 1,
      currentCwdClaimPresent: false,
      currentWorkspaceRootsPresent: true,
    });
    expect(extractChatGptMidTurnEnvironmentClaim(currentWire())).toBeUndefined();
  });
});
