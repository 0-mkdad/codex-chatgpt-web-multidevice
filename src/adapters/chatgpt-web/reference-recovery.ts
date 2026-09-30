/** A transport control answer, never a user-facing task result or an authorization token. */
export const CHATGPT_TURN_REFERENCE_RECOVERY_MARKER = "CODEX_TURN_REFERENCE_RECOVERY_REQUESTED";
export const CODEX_TURN_REFERENCE_RECOVERY_WIRE_NAME = "codex.control.turn_reference_recovery";

export type TurnReferenceRecoveryState =
  | "active_browser_turn"
  | "tool_reference_rejected"
  | "fencing_source_generation"
  | "source_quiescent"
  | "reconciling_tool_history"
  | "recovery_safe"
  | "fresh_turn_registered"
  | "fresh_turn_submitted"
  | "continuation_active"
  | "terminal"
  | "outcome_uncertain";

const NEXT: Record<TurnReferenceRecoveryState, readonly TurnReferenceRecoveryState[]> = {
  active_browser_turn: ["tool_reference_rejected"],
  tool_reference_rejected: ["fencing_source_generation"],
  fencing_source_generation: ["source_quiescent", "outcome_uncertain"],
  source_quiescent: ["reconciling_tool_history"],
  reconciling_tool_history: ["recovery_safe", "outcome_uncertain"],
  recovery_safe: ["fresh_turn_registered"],
  fresh_turn_registered: ["fresh_turn_submitted"],
  fresh_turn_submitted: ["continuation_active"],
  continuation_active: ["terminal"],
  terminal: [],
  outcome_uncertain: ["terminal"],
};

/** Local orchestration state only. It never authorizes a broker claim or a native tool. */
export class TurnReferenceRecoveryMachine {
  private current: TurnReferenceRecoveryState;

  constructor(initial: "active_browser_turn" | "continuation_active" = "active_browser_turn") {
    this.current = initial;
  }

  get state(): TurnReferenceRecoveryState { return this.current; }

  advance(next: TurnReferenceRecoveryState): void {
    if (!NEXT[this.current].includes(next)) {
      throw new Error(`turn_reference_recovery_invalid_transition: ${this.current} -> ${next}`);
    }
    this.current = next;
  }

  fail(): void {
    this.current = "terminal";
  }
}

export function isTurnReferenceRecoveryAnswer(answer: string): boolean {
  return answer.trim() === CHATGPT_TURN_REFERENCE_RECOVERY_MARKER;
}
