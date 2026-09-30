import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateModelRouting, modelRoutingCheck } from "../src/doctor";

describe("P1 model routing evaluation", () => {
  test("chatgpt-web/ prefixed models route through the browser bridge", () => {
    const result = evaluateModelRouting("chatgpt-web/gpt-5.6-sol");
    expect(result.route).toBe("browser-bridge");
    expect(result.bypassesBridge).toBe(false);
    expect(result.effectiveModel).toBe("chatgpt-web/gpt-5.6-sol");
  });

  test("unprefixed models silently bypass the bridge via native passthrough", () => {
    const result = evaluateModelRouting("gpt-6.1-sol");
    expect(result.route).toBe("native-passthrough");
    expect(result.bypassesBridge).toBe(true);
    expect(result.effectiveModel).toBe("gpt-6.1-sol");
  });

  test("missing or blank defaults still count as a bypass", () => {
    expect(evaluateModelRouting(undefined).bypassesBridge).toBe(true);
    expect(evaluateModelRouting("   ").bypassesBridge).toBe(true);
    expect(evaluateModelRouting("").route).toBe("native-passthrough");
  });

  test("prefix matching is exact, not a substring", () => {
    expect(evaluateModelRouting("my-chatgpt-web/gpt").bypassesBridge).toBe(true);
  });
});

describe("P1 doctor model-routing check", () => {
  const advisoryConfig = {
    browserInteractionMode: "automatic",
    solAvailable: true,
    proAvailable: false,
    extraHighAvailable: false,
    zeroRiskProEnabled: false,
    experimentalBiggerContext: false,
  } as never;

  test("warns with the safe two-sentence bypass message when the default model is unprefixed", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-routing-"));
    try {
      const configPath = join(root, "config.toml");
      writeFileSync(configPath, [
        "model = \"gpt-6.1-sol\"",
        "approval_policy = \"never\"",
        "",
        "[projects.'d:\\x']",
        "trust_level = \"trusted\"",
        "",
      ].join("\n"));
      const check = modelRoutingCheck(advisoryConfig, configPath);
      expect(check.id).toBe("model-routing");
      expect(check.status).toBe("warning");
      expect(check.message).toBe(
        "Default model bypasses Codex Web GPT MultiDevice and uses native passthrough. "
        + "Select a supported chatgpt-web/* model to route turns through the browser bridge queue.",
      );
      expect(check.detail).toContain("effective model: gpt-6.1-sol");
      expect(check.detail).toContain("effective route: native-passthrough");
      // The supported list comes from the canonical availability-filtered catalog, never a
      // synthesized mapping of the current default model.
      expect(check.detail).not.toContain("chatgpt-web/gpt-6.1-sol");
      expect(check.detail).toContain("Supported browser-route models: chatgpt-web/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports the bridged route for a chatgpt-web/ prefixed default", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-routing-ok-"));
    try {
      const configPath = join(root, "config.toml");
      writeFileSync(configPath, "model = \"chatgpt-web/gpt-5.6-sol\"\n");
      const check = modelRoutingCheck(advisoryConfig, configPath);
      expect(check.status).toBe("ok");
      expect(check.message).toContain("effective route: browser-bridge");
      expect(check.detail).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips cleanly when no codex config exists", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-routing-missing-"));
    try {
      const check = modelRoutingCheck(advisoryConfig, join(root, "missing.toml"));
      expect(check.status).toBe("ok");
      expect(check.message).toContain("skipped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
