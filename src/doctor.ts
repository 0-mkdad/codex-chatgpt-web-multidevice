import { existsSync, readFileSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { join } from "node:path";
import { inspectCodexIntegration } from "./codex-integration";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { interpretTunnelHealthProbe, type TunnelHealthProbeResult } from "./tunnel-health";
import { interpretSubagentCompatibility } from "./multi-agent-doctor";
import { readCodexSubagentProtocol } from "./codex-integration";
import { readJournal } from "./codex-integration-journal";
import { availableChatGptWebModelRoutes } from "./chatgpt-web-models";
import {
  findFeatureAssignment,
  findMultiAgentV2Assignment,
  findTopLevelAssignment,
} from "./codex-integration-document";
import { getCodexConfigPath } from "./codex-integration-shared";
import { getTunnelServiceStatus } from "./tunnel-service";
import {
  inspectLauncherBrowserHost,
  inspectLauncherBrowserHostLiveness,
  readLauncherBrowserHostDescriptor,
} from "./launcher-browser-host";
import { processRunning } from "./process";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

export interface ModelRoutingEvaluation {
  effectiveModel: string;
  route: "browser-bridge" | "native-passthrough";
  bypassesBridge: boolean;
}

/** The `chatgpt-web/` prefix is the opt-in contract for the browser bridge queue; any other
 *  model string is relayed to the native Codex backend without touching the queue. */
export function evaluateModelRouting(model: string | undefined): ModelRoutingEvaluation {
  const effectiveModel = (model ?? "").trim();
  const bypassesBridge = !effectiveModel.startsWith("chatgpt-web/");
  return {
    effectiveModel,
    route: bypassesBridge ? "native-passthrough" : "browser-bridge",
    bypassesBridge,
  };
}

export function modelRoutingCheck(config?: AppConfig, configPath: string = getCodexConfigPath()): DoctorCheck {
  let model: string | undefined;
  try {
    if (!existsSync(configPath)) {
      return { id: "model-routing", status: "ok", message: "Codex config not found; model routing check skipped" };
    }
    const assignment = findTopLevelAssignment(readFileSync(configPath, "utf8").split(/\r?\n/), "model");
    model = assignment.present ? assignment.value : undefined;
  } catch (error) {
    return {
      id: "model-routing",
      status: "warning",
      message: "Could not evaluate the Codex default model routing",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const evaluation = evaluateModelRouting(model);
  if (evaluation.bypassesBridge) {
    // Advisory only: list the canonical availability-filtered browser routes from the same
    // catalog that feeds the client. Never synthesize a mapping for the current default model.
    let supported = "";
    if (config) {
      try {
        const slugs = availableChatGptWebModelRoutes(config).map(route => route.slug);
        if (slugs.length > 0) supported = ` Supported browser-route models: ${slugs.join(", ")}.`;
      } catch {
        supported = "";
      }
    }
    return {
      id: "model-routing",
      status: "warning",
      message: "Default model bypasses Codex Web GPT MultiDevice and uses native passthrough. "
        + "Select a supported chatgpt-web/* model to route turns through the browser bridge queue.",
      detail: `effective model: ${evaluation.effectiveModel || "(unset)"}; effective route: ${evaluation.route}.${supported}`,
    };
  }
  return {
    id: "model-routing",
    status: "ok",
    message: `Default model routes through the browser bridge queue (effective model: ${evaluation.effectiveModel}; effective route: ${evaluation.route})`,
  };
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

function launcherOwnershipError(config: AppConfig, health: Record<string, unknown>): string | undefined {
  if (config.browserHost !== "launcher") return undefined;
  const path = join(getConfigDir(), "runtime", "launcher-supervisor.json");
  if (!existsSync(path)) return `Launcher runtime ownership marker is missing: ${path}`;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `Launcher runtime ownership marker is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (state.version !== 1
    || !Number.isInteger(state.ownerPid)
    || (state.ownerPid as number) < 1
    || !Number.isInteger(state.daemonPid)
    || (state.daemonPid as number) < 1
    || state.status !== "ready") {
    return "Launcher runtime ownership marker is incomplete or not ready";
  }
  if (!processRunning(state.ownerPid)) {
    return `Launcher owner process is not running (pid ${String(state.ownerPid)})`;
  }
  if (health.pid !== state.daemonPid) {
    return `Responses proxy pid ${String(health.pid)} does not match launcher-owned pid ${String(state.daemonPid)}`;
  }
  return undefined;
}


function subagentCompatibilityCheck(config: AppConfig): DoctorCheck {
  let journalPresent = false;
  let journalProtocol: string | undefined;
  try {
    const journal = readJournal();
    journalPresent = Boolean(journal?.installed);
    journalProtocol = readCodexSubagentProtocol(config.subagentProtocol);
  } catch {
    journalPresent = false;
  }
  let tomlMultiAgentPresent = false;
  let tomlMultiAgent: boolean | undefined;
  let tomlMultiAgentV2Present = false;
  let tomlMultiAgentV2: boolean | undefined;
  let tomlError: string | undefined;
  try {
    const lines = readFileSync(getCodexConfigPath(), "utf8").split("\n");
    const multiAgent = findFeatureAssignment(lines, "multi_agent");
    tomlMultiAgentPresent = multiAgent.present;
    tomlMultiAgent = multiAgent.value === "true" ? true : multiAgent.value === "false" ? false : undefined;
    const multiAgentV2 = findMultiAgentV2Assignment(lines);
    tomlMultiAgentV2Present = multiAgentV2.present;
    tomlMultiAgentV2 = multiAgentV2.value === "true" ? true : multiAgentV2.value === "false" ? false : undefined;
  } catch (error) {
    tomlError = error instanceof Error ? error.message : String(error);
  }
  const verdict = interpretSubagentCompatibility({
    configProtocol: config.subagentProtocol,
    journalProtocol,
    journalPresent,
    tomlMultiAgentPresent,
    tomlMultiAgent,
    tomlMultiAgentV2Present,
    tomlMultiAgentV2,
    tomlError,
  });
  return { id: "subagents", status: verdict.status, message: verdict.message, detail: verdict.detail };
}

async function tunnelHealthProbe(): Promise<TunnelHealthProbeResult> {
  const url = process.env.CODEX_CHATGPT_WEB_TUNNEL_HEALTH_URL?.trim();
  if (!url) return { kind: "unsupported" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { kind: "response", status: response.status, bodyText: await response.text() };
  } catch (error) {
    if (controller.signal.aborted) return { kind: "timeout" };
    return { kind: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function tunnelHealthCheck(): Promise<DoctorCheck> {
  const verdict = interpretTunnelHealthProbe(await tunnelHealthProbe());
  return { id: "tunnel-health", status: verdict.status, message: verdict.message, detail: verdict.detail };
}

async function proxyCheck(config: AppConfig): Promise<DoctorCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` };
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web" || body.status !== "ok") {
      return { id: "proxy", status: "error", message: "The configured port belongs to another service" };
    }
    if (body.mode !== config.mode) {
      return { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` };
    }
    if (body.version !== config.releaseVersion) {
      return { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` };
    }
    if (body.accepting_turns !== true) {
      return {
        id: "proxy",
        status: "error",
        message: "Responses proxy is still drained and is not accepting Codex turns",
      };
    }
    const ownershipError = launcherOwnershipError(config, body);
    if (ownershipError) {
      return { id: "proxy", status: "error", message: "Responses proxy ownership could not be verified", detail: ownershipError };
    }
    return { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: "proxy", status: "error", message: "Responses proxy is not reachable", detail };
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  if (config.browserHost === "launcher") {
    try {
      const descriptor = config.browserInteractionMode === "manual"
        ? await inspectLauncherBrowserHostLiveness(config.browserHostDescriptorPath!, { timeoutMs: 5_000 })
        : readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
      if (config.browserInteractionMode === "automatic") {
        await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, { timeoutMs: 30_000 });
      }
      checks.push({
        id: "browser-host",
        status: "ok",
        message: config.browserInteractionMode === "manual"
          ? `Embedded launcher browser is reachable for Zero Risk (pid ${descriptor.pid})`
          : `Embedded launcher browser is authenticated and reachable (pid ${descriptor.pid})`,
      });
    } catch (error) {
      checks.push({
        id: "browser-host",
        status: "error",
        message: "Embedded launcher browser is unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    if (!existsSync(config.chromeExecutablePath)) {
      checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
    } else {
      checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
    }
    if (!browserLoginStateExists(config)) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login state is missing or unverified; run `codex-chatgpt-web login`" });
    } else if (!secureFile(config.storageStatePath)) {
      checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}` });
    } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
    } else {
      checks.push({ id: "login", status: "ok", message: "ChatGPT login state has authenticated browser evidence" });
    }
  }

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({ id: "codex", status: "error", message: "Codex model route is not installed" });
  } else if (codex.errors.length > 0) {
    checks.push({ id: "codex", status: "error", message: "Codex integration is inconsistent", detail: codex.errors.join("; ") });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Codex native model route is installed" });
  }
  checks.push(modelRoutingCheck(config));
  checks.push(subagentCompatibilityCheck(config));

  const service = getServiceStatus();
  if (config.browserHost === "launcher") {
    checks.push(service.installed || service.loaded
      ? {
          id: "service",
          status: "warning",
          message: "A legacy OS background service still exists; rerun launcher setup to migrate ownership",
          detail: JSON.stringify(service),
        }
      : { id: "service", status: "ok", message: "Launcher owns the background runtime" });
  } else if (!service.supported) {
    checks.push({ id: "service", status: "warning", message: "Managed service is unavailable on this OS; keep `serve` running manually" });
  } else if (!service.installed || !service.loaded) {
    checks.push({ id: "service", status: "error", message: "macOS background service is not installed and loaded" });
  } else {
    checks.push({ id: "service", status: "ok", message: "macOS background service is loaded" });
  }
  checks.push(await proxyCheck(config));

  if (config.mode === "full") {
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      checks.push({ id: "tunnel-binary", status: "ok", message: "Pinned openai/tunnel-client binary is installed" });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    if (config.browserHost === "launcher") {
      checks.push(tunnelService.installed || tunnelService.loaded
        ? {
            id: "tunnel-service",
            status: "warning",
            message: "A legacy OS tunnel service still exists; rerun launcher MCP setup to migrate ownership",
            detail: JSON.stringify(tunnelService),
          }
        : { id: "tunnel-service", status: "ok", message: "Launcher owns the tunnel runtime" });
    } else {
      checks.push(tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "macOS tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "macOS tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    }
    const runtime = tunnelStatus(config);
    checks.push(runtime.ok
      ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
      : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail });
    checks.push(await tunnelHealthCheck());
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "Browser-only mode intentionally has no local tools or MCP tunnel" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
