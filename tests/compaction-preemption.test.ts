import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatGptCompactionPreemptedError,
  chatGptExecutionOutcomeUncertainError,
  ChatGptWebAdapterError,
} from "../src/adapters/chatgpt-web/adapter-error";
import {
  COMPACTION_PREEMPTION_GRACE_MS,
  preemptCompactionSource,
} from "../src/adapters/chatgpt-web/compaction-preemption";
import { ChatGptTurnSession, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptTurnJournal } from "../src/adapters/chatgpt-web/turn-journal";
import type { ChatGptTurnRuntime } from "../src/adapters/chatgpt-web/turn-execution";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRuntimeHarness() {
  const browser = deferred<string>();
  const physical = deferred<void>();
  const cancels: (Error | undefined)[] = [];
  const runtime = {
    browser: browser.promise,
    physicalSettlement: physical.promise,
    conversationKey: "conv-1",
    cancel: (reason?: Error) => {
      cancels.push(reason);
      // Mirror the real turn helper: the browser outcome rejects with the cancel reason while
      // the physical settlement always resolves (cleanup must never block preemption).
      browser.reject(reason ?? new Error("cancelled"));
      physical.resolve();
    },
  } as unknown as ChatGptTurnRuntime;
  return {
    runtime,
    cancels,
    settleFinal(answer = "answer") {
      browser.resolve(answer);
      physical.resolve();
    },
    settleError(error = new Error("own failure")) {
      browser.reject(error);
      physical.resolve();
    },
  };
}

function makeEntry(harness: ReturnType<typeof makeRuntimeHarness>, key: string, nativeThreadId?: string): ChatGptTurnSession {
  const sessions = new ChatGptTurnSessions();
  const session = sessions.getOrCreate(key, () => harness.runtime, `trace-${key}`, "owner-1", undefined, nativeThreadId);
  sessionsMap.set(key, { sessions, session });
  return session;
}

const sessionsMap = new Map<string, { sessions: ChatGptTurnSessions; session: ChatGptTurnSession }>();

function outstandingRequest(callId: string) {
  return { callId, wireName: "exec_command", freeform: false, arguments: {} };
}

function traceEvents(): string[] {
  const raw = (console.info as ReturnType<typeof spyOn>).mock.calls
    .map((call: unknown[]) => String(call[0]));
  return raw.filter((line: string) => line.includes("[chatgpt-web-trace]"));
}

let infoSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  infoSpy = spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  sessionsMap.clear();
});

describe("P0 compaction preemption", () => {
  test("grace default stays short and bounded", () => {
    expect(COMPACTION_PREEMPTION_GRACE_MS).toBeLessThanOrEqual(10_000);
  });

  test("owner settling final during grace is preserved and never aborted", async () => {
    const harness = makeRuntimeHarness();
    const key = "exec:final-during-grace";
    const session = makeEntry(harness, key, "thread-A");
    session.setOutstanding([outstandingRequest("call-1")]);
    setTimeout(() => harness.settleFinal(), 40);
    const result = await preemptCompactionSource({
      sessions: sessionsMap.get(key)!.sessions,
      executionKey: key,
      compactionTraceId: "comp-1",
      graceMs: 2_000,
      pollMs: 10,
    });
    expect(result.kind).toBe("final-preserved");
    expect(harness.cancels).toHaveLength(0);
    expect(traceEvents().some(line => line.includes("compaction_preemption_safe_boundary"))).toBe(true);
  });

  test("tool boundary during grace retires with typed retryable compaction_preempted", async () => {
    const harness = makeRuntimeHarness();
    const key = "exec:tool-boundary";
    const session = makeEntry(harness, key, "thread-A");
    session.setOutstanding([outstandingRequest("call-1")]);
    setTimeout(() => session.markResultDelivered("call-1"), 40);
    const result = await preemptCompactionSource({
      sessions: sessionsMap.get(key)!.sessions,
      executionKey: key,
      compactionTraceId: "comp-2",
      graceMs: 2_000,
      pollMs: 10,
    });
    expect(result.kind).toBe("safe-boundary");
    expect(harness.cancels).toHaveLength(1);
    const reason = harness.cancels[0] as ChatGptWebAdapterError;
    expect(reason).toBeInstanceOf(ChatGptWebAdapterError);
    expect(reason.code).toBe("compaction_preempted");
    expect(reason.retryable).toBe(true);
    expect(traceEvents().some(line => line.includes("compaction_preemption_safe_boundary"))).toBe(true);
    expect(traceEvents().some(line => line.includes("compaction_replay_blocked_uncertain"))).toBe(false);
  });

  test("grace expiry with undecided native work forces typed execution_outcome_uncertain", async () => {
    const harness = makeRuntimeHarness();
    const key = "exec:forced";
    const session = makeEntry(harness, key, "thread-A");
    session.setOutstanding([outstandingRequest("call-1")]);
    const result = await preemptCompactionSource({
      sessions: sessionsMap.get(key)!.sessions,
      executionKey: key,
      compactionTraceId: "comp-3",
      graceMs: 80,
      pollMs: 10,
    });
    expect(result.kind).toBe("forced");
    expect((result as { uncertain: boolean }).uncertain).toBe(true);
    const reason = harness.cancels[0] as ChatGptWebAdapterError;
    expect(reason.code).toBe("execution_outcome_uncertain");
    expect(reason.retryable).toBe(false);
    expect(traceEvents().some(line => line.includes("compaction_preemption_forced"))).toBe(true);
    expect(traceEvents().some(line => line.includes("compaction_replay_blocked_uncertain"))).toBe(true);
  });

  test("owner settling an error during grace is treated as cleanup, not an uncertain result", async () => {
    const harness = makeRuntimeHarness();
    const key = "exec:owner-error";
    const session = makeEntry(harness, key, "thread-A");
    session.setOutstanding([outstandingRequest("call-1")]);
    setTimeout(() => harness.settleError(), 10);
    const result = await preemptCompactionSource({
      sessions: sessionsMap.get(key)!.sessions,
      executionKey: key,
      compactionTraceId: "comp-4",
      graceMs: 2_000,
      pollMs: 10,
    });
    // The client already knows the turn failed on its own, so this stays a clean typed
    // preemption: no undecided-native-work failure mode may be manufactured here.
    expect(result.kind).toBe("safe-boundary");
    expect(harness.cancels.at(-1) as ChatGptWebAdapterError).toBeInstanceOf(ChatGptWebAdapterError);
    expect((harness.cancels.at(-1) as ChatGptWebAdapterError).code).toBe("compaction_preempted");
    expect(traceEvents().some(line => line.includes('"boundary":"settled_error"'))).toBe(true);
  });

  test("parent interrupt after a clean preemption resolves the durable marker as cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-preempt-interrupt-"));
    try {
      const harness = makeRuntimeHarness();
      const key = "exec:interrupted";
      const session = makeEntry(harness, key, "thread-A");
      const journalPath = join(root, "turn-journal.json");
      const journal = new ChatGptTurnJournal(journalPath);
      journal.recordSubmission(key, "accepted", { traceId: "trace-exec:interrupted", nativeThreadId: "thread-A" });
      session.setOutstanding([outstandingRequest("call-1")]);
      setTimeout(() => session.markResultDelivered("call-1"), 30);
      await preemptCompactionSource({
        sessions: sessionsMap.get(key)!.sessions,
        executionKey: key,
        compactionTraceId: "comp-5",
        graceMs: 2_000,
        pollMs: 10,
        journal,
      });
      const pending = journal.compactionPreemption(key);
      expect(pending?.phase).toBe("preempted");
      expect(pending?.resolvedAt).toBeUndefined();
      // Parent interrupt: the client cancels the preempted turn.
      journal.recordTerminal(key, "cancelled");
      const resolved = journal.compactionPreemption(key);
      expect(resolved?.phase).toBe("cancelled");
      expect(resolved?.resolvedAt).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("client replay re-arms then completes the durable marker via execution-key dedup", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-preempt-replay-"));
    try {
      const harness = makeRuntimeHarness();
      const key = "exec:replayed";
      const session = makeEntry(harness, key, "thread-A");
      const journalPath = join(root, "turn-journal.json");
      const journal = new ChatGptTurnJournal(journalPath);
      journal.recordSubmission(key, "accepted", { traceId: "trace-exec:replayed", nativeThreadId: "thread-A" });
      session.setOutstanding([outstandingRequest("call-1")]);
      setTimeout(() => session.markResultDelivered("call-1"), 30);
      await preemptCompactionSource({
        sessions: sessionsMap.get(key)!.sessions,
        executionKey: key,
        compactionTraceId: "comp-6",
        graceMs: 2_000,
        pollMs: 10,
        journal,
      });
      // The client retry lands on the exact same execution key (dedup-proven replay).
      journal.recordSubmission(key, "accepted", { traceId: "trace-exec:replayed", nativeThreadId: "thread-A" });
      expect(journal.compactionPreemption(key)?.phase).toBe("replaying");
      expect(traceEvents().some(line => line.includes("compaction_replay_started"))).toBe(true);
      journal.recordTerminal(key, "final", { response: "replayed answer" });
      const resolved = journal.compactionPreemption(key);
      expect(resolved?.phase).toBe("replay_completed");
      expect(resolved?.resolvedAt).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocked-uncertain markers refuse replay arming", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-preempt-blocked-"));
    try {
      const harness = makeRuntimeHarness();
      const key = "exec:blocked";
      const session = makeEntry(harness, key, "thread-A");
      const journalPath = join(root, "turn-journal.json");
      const journal = new ChatGptTurnJournal(journalPath);
      journal.recordSubmission(key, "accepted", { traceId: "trace-exec:blocked", nativeThreadId: "thread-A" });
      session.setOutstanding([outstandingRequest("call-1")]);
      const result = await preemptCompactionSource({
        sessions: sessionsMap.get(key)!.sessions,
        executionKey: key,
        compactionTraceId: "comp-7",
        graceMs: 60,
        pollMs: 10,
        journal,
      });
      expect(result.kind).toBe("forced");
      expect(journal.compactionPreemption(key)?.phase).toBe("replay_blocked_uncertain");
      expect(journal.compactionPreemption(key)?.pendingNativeExecutions).toBe(1);
      // Even if the client retried anyway, the blocked marker must not re-arm as a replay.
      journal.recordSubmission(key, "accepted", { traceId: "trace-exec:blocked", nativeThreadId: "thread-A" });
      expect(journal.compactionPreemption(key)?.phase).toBe("replay_blocked_uncertain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parent and child preemption markers stay independent", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-preempt-independent-"));
    try {
      const parentHarness = makeRuntimeHarness();
      const childHarness = makeRuntimeHarness();
      const parentKey = "exec:parent";
      const childKey = "exec:child";
      const parentSession = makeEntry(parentHarness, parentKey, "thread-parent");
      const childSession = makeEntry(childHarness, childKey, "thread-child");
      const journal = new ChatGptTurnJournal(join(root, "turn-journal.json"));
      const parentSessions = sessionsMap.get(parentKey)!.sessions;
      journal.recordSubmission(parentKey, "accepted", { traceId: "trace-exec:parent", nativeThreadId: "thread-parent" });
      journal.recordSubmission(childKey, "accepted", { traceId: "trace-exec:child", nativeThreadId: "thread-child" });
      parentSession.setOutstanding([outstandingRequest("call-p")]);
      setTimeout(() => parentSession.markResultDelivered("call-p"), 30);
      await preemptCompactionSource({
        sessions: parentSessions,
        executionKey: parentKey,
        compactionTraceId: "comp-parent",
        graceMs: 2_000,
        pollMs: 10,
        journal,
      });
      childSession.setOutstanding([outstandingRequest("call-c")]);
      setTimeout(() => childSession.markResultDelivered("call-c"), 30);
      await preemptCompactionSource({
        sessions: sessionsMap.get(childKey)!.sessions,
        executionKey: childKey,
        compactionTraceId: "comp-child",
        graceMs: 2_000,
        pollMs: 10,
        journal,
      });
      expect(parentHarness.cancels).toHaveLength(1);
      expect(childHarness.cancels).toHaveLength(1);
      expect(journal.compactionPreemption(parentKey)?.traceId).toBe("trace-exec:parent");
      expect(journal.compactionPreemption(childKey)?.traceId).toBe("trace-exec:child");
      journal.recordTerminal(childKey, "final", { response: "child done" });
      expect(journal.compactionPreemption(childKey)?.resolvedAt).toBeDefined();
      expect(journal.compactionPreemption(parentKey)?.resolvedAt).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("durable marker survives restart and TTL prune until terminal resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-preempt-durable-"));
    try {
      const harness = makeRuntimeHarness();
      const key = "exec:durable";
      makeEntry(harness, key, "thread-A");
      const journalPath = join(root, "turn-journal.json");
      let clock = 1_000_000;
      const now = () => clock;
      const journal = new ChatGptTurnJournal(journalPath, now, 60_000);
      journal.recordSubmission(key, "accepted", { traceId: "trace-exec:durable", nativeThreadId: "thread-A" });
      journal.recordCompactionPreemption(key, {
        traceId: "trace-exec:durable",
        nativeThreadId: "thread-A",
        pendingNativeExecutions: 2,
        forced: true,
        blockedUncertain: false,
      });
      expect(journal.compactionPreemption(key)?.phase).toBe("preempted");
      // Simulate a daemon restart: a fresh journal over the same store.
      const reloaded = new ChatGptTurnJournal(journalPath, now, 60_000);
      expect(reloaded.compactionPreemption(key)?.pendingNativeExecutions).toBe(2);
      // TTL expiry must NOT drop the unresolved marker.
      clock += 10 * 60_000;
      reloaded.checkpoint(key);
      expect(reloaded.compactionPreemption(key)?.phase).toBe("preempted");
      // Terminal resolution releases it to normal pruning.
      reloaded.recordTerminal(key, "cancelled");
      expect(reloaded.compactionPreemption(key)?.resolvedAt).toBeDefined();
      clock += 10 * 60_000;
      reloaded.checkpoint(key);
      expect(reloaded.compactionPreemption(key)).toBeUndefined();
      const persisted = JSON.parse(readFileSync(journalPath, "utf8"));
      expect(persisted.version).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("typed preemption errors carry the documented classification", () => {
    const clean = chatGptCompactionPreemptedError();
    expect(clean.code).toBe("compaction_preempted");
    expect(clean.retryable).toBe(true);
    const uncertain = chatGptExecutionOutcomeUncertainError(2);
    expect(uncertain.code).toBe("execution_outcome_uncertain");
    expect(uncertain.retryable).toBe(false);
    expect(uncertain.message).toContain("2 undecided native execution(s)");
  });
});
