/**
 * Read-only interpretation of the tunnel-client health surface for doctor.
 *
 * The bridge never controls the tunnel through this module and it never sees the provider's
 * `response_timeout`: that budget is consumed inside tunnel-client and never reaches the MCP
 * bridge, so a health body carrying it is deliberately ignored rather than reported. The
 * installed 0.0.14 has no health endpoint at all — a 404 (or a missing URL) is the normal
 * legacy state and must never fail doctor; the integration is forward-compatible with the
 * health components introduced in newer tunnel releases.
 */
export type TunnelHealthProbeResult =
  | { kind: "response"; status: number; bodyText: string }
  | { kind: "unreachable"; detail: string }
  | { kind: "timeout" }
  | { kind: "unsupported" };

export interface TunnelHealthVerdict {
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
}

const KNOWN_COMPONENT_LABELS: Record<string, string> = {
  dispatcher: "dispatcher",
  response_delivery: "response-delivery",
  responseDelivery: "response-delivery",
  mcp_child_generation: "MCP child generation",
  mcpChildGeneration: "MCP child generation",
  queue: "queue",
};

function componentLabel(name: string): string | undefined {
  return KNOWN_COMPONENT_LABELS[name];
}

function healthyComponents(body: Record<string, unknown>): { healthy: string[]; unhealthy: string[] } {
  const healthy: string[] = [];
  const unhealthy: string[] = [];
  const rawComponents = body.components;
  const entries: Array<[string, unknown]> = Array.isArray(rawComponents)
    ? rawComponents.flatMap(entry => {
      const record = entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown> : undefined;
      return record && typeof record.name === "string" ? [[record.name, record.status] as [string, unknown]] : [];
    })
    : rawComponents !== null && typeof rawComponents === "object" && !Array.isArray(rawComponents)
      ? Object.entries(rawComponents as Record<string, unknown>)
      : [];
  for (const [name, value] of entries) {
    const label = componentLabel(name);
    if (!label) continue;
    const status = typeof value === "string"
      ? value
      : value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).status
        : undefined;
    if (typeof status === "string" && status !== "healthy" && status !== "ok" && status !== "ready") {
      unhealthy.push(label);
    } else {
      healthy.push(label);
    }
  }
  return { healthy, unhealthy };
}

export function interpretTunnelHealthProbe(probe: TunnelHealthProbeResult): TunnelHealthVerdict {
  if (probe.kind === "unsupported") {
    return {
      status: "warning",
      message: "tunnel health unsupported by installed tunnel-client (no health endpoint configured)",
      detail: "Set CODEX_CHATGPT_WEB_TUNNEL_HEALTH_URL when a tunnel-client release exposes its health endpoint; this check stays read-only.",
    };
  }
  if (probe.kind === "unreachable") {
    return {
      status: "warning",
      message: "tunnel unreachable",
      detail: `The tunnel health endpoint could not be reached: ${probe.detail}. The tunnel-runtime check owns the hard failure.`,
    };
  }
  if (probe.kind === "timeout") {
    return { status: "warning", message: "tunnel health probe timed out" };
  }
  if (probe.status === 404) {
    return {
      status: "warning",
      message: "tunnel health unsupported by installed tunnel-client (legacy version)",
      detail: "The health endpoint does not exist on this tunnel-client release. This is not a failure; newer releases add it without any bridge change.",
    };
  }
  if (probe.status !== 200) {
    return {
      status: "warning",
      message: `tunnel health returned HTTP ${probe.status}`,
      detail: "Only HTTP 200 is interpreted; the tunnel-runtime check owns the hard failure.",
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(probe.bodyText);
  } catch {
    return { status: "warning", message: "tunnel health returned a malformed response" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: "warning", message: "tunnel health returned a malformed response" };
  }
  const record = body as Record<string, unknown>;
  if (record.schema_version !== undefined && record.schema_version !== 1) {
    // A newer schema is tolerated: unknown fields are ignored, known components still report.
    const { healthy, unhealthy } = healthyComponents(record);
    if (unhealthy.length > 0) {
      return {
        status: "warning",
        message: `tunnel health reports unhealthy component(s): ${unhealthy.join(", ")}`,
        detail: `schema_version ${String(record.schema_version)} is newer than the bridge understands; known components were still evaluated.`,
      };
    }
    return {
      status: "ok",
      message: healthy.length > 0 ? `tunnel healthy (${healthy.join(", ")})` : "tunnel healthy",
      detail: `schema_version ${String(record.schema_version)} is newer than the bridge understands; unknown fields were ignored.`,
    };
  }
  if (record.status === "unhealthy") {
    return { status: "warning", message: "tunnel health reports an unhealthy tunnel" };
  }
  const { healthy, unhealthy } = healthyComponents(record);
  if (unhealthy.length > 0) {
    return { status: "warning", message: `tunnel health reports unhealthy component(s): ${unhealthy.join(", ")}` };
  }
  return {
    status: "ok",
    message: healthy.length > 0 ? `tunnel healthy (${healthy.join(", ")})` : "tunnel healthy",
  };
}
