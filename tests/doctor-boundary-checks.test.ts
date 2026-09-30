import { describe, expect, test } from "bun:test";
import { interpretTunnelHealthProbe } from "../src/tunnel-health";
import { interpretSubagentCompatibility } from "../src/multi-agent-doctor";

describe("doctor tunnel health interpretation (read-only)", () => {
  test("legacy 404 is unsupported, not a failure", () => {
    const verdict = interpretTunnelHealthProbe({ kind: "response", status: 404, bodyText: "" });
    expect(verdict.status).toBe("warning");
    expect(verdict.message).toContain("unsupported by installed tunnel-client");
  });

  test("a valid known schema with healthy components reports tunnel healthy", () => {
    const verdict = interpretTunnelHealthProbe({
      kind: "response",
      status: 200,
      bodyText: JSON.stringify({ status: "healthy", components: {
        dispatcher: { status: "healthy" },
        response_delivery: { status: "healthy" },
        queue: { status: "healthy" },
      } }),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toContain("tunnel healthy");
  });

  test("unknown fields are ignored on the known schema version", () => {
    const verdict = interpretTunnelHealthProbe({
      kind: "response",
      status: 200,
      bodyText: JSON.stringify({ status: "healthy", future_field: { nested: true }, components: { queue: { status: "healthy" } } }),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toContain("queue");
  });

  test("a newer schema_version is handled safely with unknown fields ignored", () => {
    const verdict = interpretTunnelHealthProbe({
      kind: "response",
      status: 200,
      bodyText: JSON.stringify({ schema_version: 2, brand_new_section: { x: 1 }, components: { dispatcher: { status: "healthy" } } }),
    });
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toContain("dispatcher");
    expect(verdict.detail).toContain("newer than the bridge understands");
  });

  test("an unhealthy component is named without failing doctor outright", () => {
    const verdict = interpretTunnelHealthProbe({
      kind: "response",
      status: 200,
      bodyText: JSON.stringify({ components: { response_delivery: { status: "degraded" } } }),
    });
    expect(verdict.status).toBe("warning");
    expect(verdict.message).toContain("response-delivery");
  });

  test("connection failure and timeout are warnings owned by the tunnel-runtime check", () => {
    expect(interpretTunnelHealthProbe({ kind: "unreachable", detail: "ECONNREFUSED" }).status).toBe("warning");
    expect(interpretTunnelHealthProbe({ kind: "unreachable", detail: "ECONNREFUSED" }).message).toBe("tunnel unreachable");
    expect(interpretTunnelHealthProbe({ kind: "timeout" }).message).toContain("timed out");
  });

  test("a malformed body is a warning and never claims to see provider response_timeout", () => {
    expect(interpretTunnelHealthProbe({ kind: "response", status: 200, bodyText: "<html>gateway</html>" }).status).toBe("warning");
    const withTimeout = interpretTunnelHealthProbe({
      kind: "response",
      status: 200,
      bodyText: JSON.stringify({ response_timeout: 30_000, components: { dispatcher: { status: "healthy" } } }),
    });
    expect(withTimeout.status).toBe("ok");
    expect(JSON.stringify(withTimeout)).not.toContain("response_timeout");
  });
});

describe("doctor multi-agent V1/V2 compatibility guard (detect + explain only)", () => {
  const v1Expected = {
    configProtocol: "compatibility-v1",
    journalPresent: true,
    journalProtocol: "compatibility-v1",
    tomlMultiAgentPresent: true,
    tomlMultiAgent: true,
    tomlMultiAgentV2Present: true,
    tomlMultiAgentV2: false,
  };

  test("the installed V1 configuration is reported as valid compatibility", () => {
    const verdict = interpretSubagentCompatibility(v1Expected);
    expect(verdict.status).toBe("ok");
    expect(verdict.message).toContain("Compatibility V1");
  });

  test("V2 enabled is an explicit incompatibility error with remediation, without auto-editing", () => {
    const verdict = interpretSubagentCompatibility({ ...v1Expected, tomlMultiAgentV2: true });
    expect(verdict.status).toBe("error");
    expect(verdict.message).toContain("unsupported on V2");
    expect(verdict.detail).toContain("does not change this configuration automatically");
  });

  test("missing keys report the unknown effective state honestly", () => {
    const verdict = interpretSubagentCompatibility({ ...v1Expected, tomlMultiAgentPresent: false, tomlMultiAgent: undefined });
    expect(verdict.status).toBe("warning");
    expect(verdict.message).toContain("unknown");
    const v2Unknown = interpretSubagentCompatibility({ ...v1Expected, tomlMultiAgentV2Present: false, tomlMultiAgentV2: undefined });
    expect(v2Unknown.status).toBe("warning");
  });

  test("malformed or dual-form Codex config is ambiguous", () => {
    const verdict = interpretSubagentCompatibility({
      ...v1Expected,
      tomlError: "Codex config defines multi_agent_v2 as both [features] scalar and [features.multi_agent_v2] table",
    });
    expect(verdict.status).toBe("warning");
    expect(verdict.message).toContain("ambiguous");
    expect(verdict.detail).toContain("both");
  });

  test("journal/config overrides surface as honest caveats instead of silent success", () => {
    const mismatch = interpretSubagentCompatibility({ ...v1Expected, journalProtocol: "native" });
    expect(mismatch.status).toBe("warning");
    expect(mismatch.message).toContain("caveats");
    const absent = interpretSubagentCompatibility({ ...v1Expected, journalPresent: false, journalProtocol: undefined });
    expect(absent.status).toBe("warning");
    const foreignProtocol = interpretSubagentCompatibility({ ...v1Expected, configProtocol: "native" });
    expect(foreignProtocol.status).toBe("warning");
    expect(foreignProtocol.message).toContain("native");
  });
});
