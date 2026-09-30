/**
 * Read-only multi-agent V1/V2 compatibility interpretation for doctor.
 *
 * The installed bridge runs routed Web subagents on `compatibility-v1` (V1), which requires
 * Codex `multi_agent = true` and `multi_agent_v2 = false`. This module only detects and
 * explains; it never edits Codex config and never downgrades V2 automatically. When evidence
 * is incomplete (missing keys, dual-form definitions, an absent integration journal) the
 * verdict honestly reports the unknown state instead of guessing.
 */
export interface SubagentCompatibilityInputs {
  /** Effective config.json subagentProtocol (already validated by loadConfig). */
  configProtocol: string;
  /** Protocol recorded by the installed integration journal, when one exists. */
  journalProtocol?: string;
  journalPresent: boolean;
  tomlMultiAgentPresent: boolean;
  tomlMultiAgent?: boolean;
  tomlMultiAgentV2Present: boolean;
  tomlMultiAgentV2?: boolean;
  /** Codex TOML could not be parsed (e.g. multi_agent_v2 defined as both scalar and table). */
  tomlError?: string;
}

export interface SubagentCompatibilityVerdict {
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

export function interpretSubagentCompatibility(
  inputs: SubagentCompatibilityInputs,
): SubagentCompatibilityVerdict {
  if (inputs.tomlError) {
    return {
      status: "warning",
      message: "multi-agent Codex configuration is ambiguous; effective state unknown",
      detail: inputs.tomlError,
    };
  }
  if (inputs.configProtocol !== "compatibility-v1") {
    return {
      status: "warning",
      message: `bridge subagent protocol is ${inputs.configProtocol}; routed Web subagents V1 compatibility is not in effect`,
      detail: "The routed ChatGPT Web subagent path expects compatibility-v1. Verify this protocol change was intended.",
    };
  }
  if (inputs.tomlMultiAgentV2Present && inputs.tomlMultiAgentV2 === true) {
    return {
      status: "error",
      message: "multi_agent_v2 is enabled but the routed Web subagents of this bridge are unsupported on V2",
      detail: "Set multi_agent_v2 = false in the Codex config (or switch the bridge protocol deliberately). The bridge does not change this configuration automatically.",
    };
  }
  if (!inputs.tomlMultiAgentPresent || inputs.tomlMultiAgent !== true) {
    return {
      status: "warning",
      message: "multi-agent is not enabled in the Codex config; effective compatibility state unknown",
      detail: "Routed Web subagents require multi_agent = true together with multi_agent_v2 = false.",
    };
  }
  const notes: string[] = [];
  if (!inputs.journalPresent) {
    notes.push("no integration journal found, so the effective installed protocol could not be confirmed");
  } else if (inputs.journalProtocol !== undefined && inputs.journalProtocol !== inputs.configProtocol) {
    notes.push(`integration journal records protocol ${inputs.journalProtocol} while config.json declares ${inputs.configProtocol}`);
  }
  if (inputs.tomlMultiAgentV2Present && inputs.tomlMultiAgentV2 === false) {
    return {
      status: notes.length > 0 ? "warning" : "ok",
      message: notes.length > 0
        ? "bridge runs routed Web subagents in Compatibility V1 with caveats"
        : "bridge runs routed Web subagents in Compatibility V1 (multi_agent = true, multi_agent_v2 = false)",
      ...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
    };
  }
  return {
    status: "warning",
    message: "bridge expects Compatibility V1 but multi_agent_v2 state is unreported in the Codex config",
    ...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
  };
}
