import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  CHATGPT_CONTINUATION_CREDIT_REASONS,
  chatGptContinuationCreditTtlMs,
  clearChatGptContinuationCredits,
  grantChatGptContinuationCredit,
  takeChatGptContinuationCredit,
} from "../src/adapters/chatgpt-web/continuation-credits";
import { CHATGPT_WEB_STRUCTURED_TRACE_PREFIX } from "../src/adapters/chatgpt-web/structured-trace";

const traceEvents = (lines: string[]) => lines
  .filter(line => line.startsWith(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX))
  .map(line => JSON.parse(line.slice(CHATGPT_WEB_STRUCTURED_TRACE_PREFIX.length)) as {
    event: string;
    detail: Record<string, unknown>;
  });

afterEach(() => clearChatGptContinuationCredits());

describe("continuation credit expiry telemetry", () => {
  test("grant then consume within the TTL emits no expiry event", () => {
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    try {
      expect(grantChatGptContinuationCredit("thread_live", CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer, 1000)).toBe(true);
      const consumed = takeChatGptContinuationCredit("thread_live", 1000 + chatGptContinuationCreditTtlMs() - 1);
      expect(consumed).toEqual({ reason: CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer, ageMs: chatGptContinuationCreditTtlMs() - 1 });
      expect(traceEvents(lines).filter(event => event.event === "continuation_credit_expired")).toHaveLength(0);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("grant then expire at the TTL boundary emits exactly one expiry event with diagnostics", () => {
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    try {
      expect(grantChatGptContinuationCredit("thread_starved", CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff, 1000)).toBe(true);
      const consumed = takeChatGptContinuationCredit("thread_starved", 1000 + chatGptContinuationCreditTtlMs() + 1);
      expect(consumed).toBeUndefined();
      const expiries = traceEvents(lines).filter(event => event.event === "continuation_credit_expired");
      expect(expiries).toHaveLength(1);
      const detail = expiries[0]!.detail;
      expect(detail.observed).toBe("ttl_exceeded");
      expect(detail.reason).toBe(CHATGPT_CONTINUATION_CREDIT_REASONS.compactionHandoff);
      expect(detail.ageMs).toBe(chatGptContinuationCreditTtlMs() + 1);
      expect(detail.ttlMs).toBe(chatGptContinuationCreditTtlMs());
      expect(detail.nativeThreadHash).toBeString();
      // No raw thread identifier and no duplicated expiry on a repeat take.
      expect(detail).not.toHaveProperty("threadId");
      expect(takeChatGptContinuationCredit("thread_starved", 1000 + chatGptContinuationCreditTtlMs() + 2)).toBeUndefined();
      expect(traceEvents(lines).filter(event => event.event === "continuation_credit_expired")).toHaveLength(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("a backward clock jump is reported as clock skew, not TTL expiry", () => {
    const lines: string[] = [];
    const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => { lines.push(String(args[0])); });
    try {
      grantChatGptContinuationCredit("thread_clock", CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer, 10_000);
      takeChatGptContinuationCredit("thread_clock", 9_000);
      const expiries = traceEvents(lines).filter(event => event.event === "continuation_credit_expired");
      expect(expiries).toHaveLength(1);
      expect(expiries[0]!.detail.observed).toBe("clock_skew");
      expect(expiries[0]!.detail.ageMs).toBe(-1000);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("the boundary just before expiry still consumes", () => {
    grantChatGptContinuationCredit("thread_edge", CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer, 5000);
    expect(takeChatGptContinuationCredit("thread_edge", 5000 + chatGptContinuationCreditTtlMs())).toEqual({
      reason: CHATGPT_CONTINUATION_CREDIT_REASONS.interruptSteer,
      ageMs: chatGptContinuationCreditTtlMs(),
    });
  });
});
