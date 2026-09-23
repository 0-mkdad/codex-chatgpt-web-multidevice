/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

export type ChatGptOperationalConcurrencyMode = "safe" | "balanced" | "aggressive" | "maximum";

export const DEFAULT_CHATGPT_OPERATIONAL_CONCURRENCY = 2;

const CHATGPT_OPERATIONAL_CONCURRENCY_BY_MODE: Record<ChatGptOperationalConcurrencyMode, number> = {
  safe: 1,
  balanced: 2,
  aggressive: 3,
  maximum: MAX_CHATGPT_BROWSER_TABS,
};

/**
 * Reliability-oriented concurrency below the hard browser-tab ceiling. The environment value is
 * intentionally internal so existing public provider configuration and protocol shapes stay
 * compatible. Named modes are preferred; integers 1..5 are accepted for diagnostics/experiments.
 */
export function resolveChatGptOperationalConcurrency(
  configured = process.env.CODEX_CHATGPT_WEB_CONCURRENCY_MODE,
): number {
  const normalized = configured?.trim().toLowerCase();
  if (!normalized) return DEFAULT_CHATGPT_OPERATIONAL_CONCURRENCY;
  if (normalized in CHATGPT_OPERATIONAL_CONCURRENCY_BY_MODE) {
    return CHATGPT_OPERATIONAL_CONCURRENCY_BY_MODE[normalized as ChatGptOperationalConcurrencyMode];
  }
  const numeric = Number(normalized);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= MAX_CHATGPT_BROWSER_TABS) {
    return numeric;
  }
  throw new Error(
    `CODEX_CHATGPT_WEB_CONCURRENCY_MODE must be safe, balanced, aggressive, maximum, or 1-${MAX_CHATGPT_BROWSER_TABS}`,
  );
}
