import { expect, test } from "bun:test";
import { TurnReferenceRecoveryMachine } from "../src/adapters/chatgpt-web/reference-recovery";
import { classifyTurnReferenceFailureCode } from "../src/adapters/chatgpt-web/turn-broker";

test("turn reference classification keeps the 36-char regression unknown without weakening malformed input", () => {
  const unknown36 = `turn_${"A".repeat(31)}`;
  const unknown37 = `turn_${"B".repeat(32)}`;
  expect(unknown36).toHaveLength(36);
  expect(unknown37).toHaveLength(37);
  expect(classifyTurnReferenceFailureCode(unknown36, "native")).toBe("unknown_turn_reference");
  expect(classifyTurnReferenceFailureCode(unknown37, "native")).toBe("unknown_turn_reference");
  expect(classifyTurnReferenceFailureCode(` ${unknown37}`, "native")).toBe("turn_reference_invalid_shape");
  expect(classifyTurnReferenceFailureCode("turn_bad!reference", "native")).toBe("turn_reference_invalid_shape");
  expect(classifyTurnReferenceFailureCode(unknown37, "native", "retired-trace")).toBe("retired_turn_reference");
});

test("fresh-turn recovery state cannot skip the source fence or reconciliation", () => {
  const recovery = new TurnReferenceRecoveryMachine();
  expect(() => recovery.advance("fresh_turn_registered")).toThrow("invalid_transition");
  recovery.advance("tool_reference_rejected");
  recovery.advance("fencing_source_generation");
  expect(() => recovery.advance("recovery_safe")).toThrow("invalid_transition");
  recovery.advance("source_quiescent");
  recovery.advance("reconciling_tool_history");
  recovery.advance("recovery_safe");
  recovery.advance("fresh_turn_registered");
  recovery.advance("fresh_turn_submitted");
  recovery.advance("continuation_active");
  recovery.advance("terminal");
  expect(() => recovery.advance("fresh_turn_registered")).toThrow("invalid_transition");

  const resumed = new TurnReferenceRecoveryMachine("continuation_active");
  resumed.advance("terminal");
  expect(resumed.state).toBe("terminal");
});

test("unknown tool outcome is terminal for automatic recovery", () => {
  const recovery = new TurnReferenceRecoveryMachine();
  recovery.advance("tool_reference_rejected");
  recovery.advance("fencing_source_generation");
  recovery.advance("outcome_uncertain");
  expect(() => recovery.advance("fresh_turn_registered")).toThrow("invalid_transition");
  recovery.fail();
  expect(recovery.state).toBe("terminal");
});
