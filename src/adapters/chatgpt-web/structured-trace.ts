import { createHash } from "node:crypto";

export const CHATGPT_WEB_STRUCTURED_TRACE_PREFIX = "[chatgpt-web-trace] ";

type TraceScalar = string | number | boolean | null;
type TraceValue = TraceScalar | TraceValue[] | { [key: string]: TraceValue };

const SENSITIVE_KEYS = new Set([
  "prompt",
  "response",
  "content",
  "body",
  "html",
  "dom",
  "text",
  "message",
  "line",
  "cookie",
  "cookies",
  "authorization",
  "headers",
  "auth",
  "secret",
  "runtimekey",
  "controltoken",
  "apikey",
  "visibletext",
]);

function safeKey(key: string): boolean {
  return !SENSITIVE_KEYS.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase());
}

function sanitizeTraceValue(value: unknown, depth = 0): TraceValue | undefined {
  if (depth > 5) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value)) {
    return value.slice(0, 32)
      .map(item => sanitizeTraceValue(item, depth + 1))
      .filter((item): item is TraceValue => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (!safeKey(key)) return [];
    const sanitized = sanitizeTraceValue(candidate, depth + 1);
    return sanitized === undefined ? [] : [[key.slice(0, 96), sanitized]];
  }));
}

export function chatGptWebTraceHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function emitChatGptWebStructuredTrace(
  event: string,
  detail: Record<string, unknown>,
  level: "info" | "warning" | "error" = "info",
): void {
  const safeEvent = event.replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 96) || "unknown";
  const sanitized = sanitizeTraceValue(detail);
  const record = {
    version: 1,
    at: new Date().toISOString(),
    level,
    event: safeEvent,
    detail: sanitized && !Array.isArray(sanitized) && typeof sanitized === "object" ? sanitized : {},
  };
  const line = `${CHATGPT_WEB_STRUCTURED_TRACE_PREFIX}${JSON.stringify(record)}`;
  if (level === "error") console.error(line);
  else if (level === "warning") console.warn(line);
  else console.info(line);
}
