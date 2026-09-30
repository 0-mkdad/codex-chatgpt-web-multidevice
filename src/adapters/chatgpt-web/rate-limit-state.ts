import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../../config";

/**
 * Small, isolated persistence for the account rate-limit circuit so an OPEN circuit survives a
 * process restart. The file carries only a hashed scope (the quota authority, never a raw
 * account identifier), the open window, and a short reason label — no tokens, no secrets.
 * Every failure of this file is fail-open for the circuit alone: a corrupt or unreadable state
 * never blocks the runtime; it only loses the "stay closed after restart" protection, with an
 * explicit diagnostic saying so.
 */
export interface PersistedRateLimitCircuit {
  openUntil: number;
  reason: string;
  status: number;
  retryAfterMs: number;
  updatedAt: number;
}

interface RateLimitStateFile {
  version: 1;
  circuits: Record<string, PersistedRateLimitCircuit>;
}

export function rateLimitScopeHash(scope: string): string {
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}

export function rateLimitStatePath(configDir: string): string {
  return join(configDir, "runtime", "rate-limit-state.json");
}

export class ChatGptRateLimitStateStore {
  private loaded = false;
  private inMemory = new Map<string, PersistedRateLimitCircuit>();
  private available = true;

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Restores persisted OPEN circuits once. Expired entries are dropped from the file. */
  restoreOpenCircuits(): Map<string, PersistedRateLimitCircuit> {
    this.loadOnce();
    if (!this.available) return new Map();
    let mutated = false;
    for (const [scopeHash, circuit] of this.inMemory) {
      if (circuit.openUntil <= this.now()) {
        this.inMemory.delete(scopeHash);
        mutated = true;
      }
    }
    if (mutated) this.persist();
    return new Map(this.inMemory);
  }

  /** Replaces one scope's persisted circuit; undefined clears it. */
  put(scopeHash: string, circuit: PersistedRateLimitCircuit | undefined): void {
    if (!this.path || !this.available) return;
    this.loadOnce();
    if (!this.available) return;
    if (circuit) this.inMemory.set(scopeHash, circuit);
    else this.inMemory.delete(scopeHash);
    this.persist();
  }

  private loadOnce(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RateLimitStateFile>;
      if (parsed.version !== 1 || typeof parsed.circuits !== "object" || parsed.circuits === null) {
        throw new Error("unsupported rate-limit state schema");
      }
      for (const [scopeHash, value] of Object.entries(parsed.circuits)) {
        if (!/^[0-9a-f]{16}$/.test(scopeHash) || !value || typeof value !== "object") continue;
        const circuit = value as Partial<PersistedRateLimitCircuit>;
        if (typeof circuit.openUntil !== "number" || !Number.isFinite(circuit.openUntil)
          || typeof circuit.updatedAt !== "number") continue;
        this.inMemory.set(scopeHash, {
          openUntil: circuit.openUntil,
          reason: typeof circuit.reason === "string" ? circuit.reason.slice(0, 96) : "unknown",
          status: typeof circuit.status === "number" ? circuit.status : 429,
          retryAfterMs: typeof circuit.retryAfterMs === "number" ? circuit.retryAfterMs : 0,
          updatedAt: circuit.updatedAt,
        });
      }
    } catch (error) {
      this.available = false;
      console.warn(
        `[chatgpt-web] rate-limit state file unreadable; circuit persistence disabled for this run`
          + ` (fail-open, path=${this.path}) cause=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      const payload: RateLimitStateFile = {
        version: 1,
        circuits: Object.fromEntries(this.inMemory),
      };
      void dirname(this.path);
      void atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
    } catch (error) {
      this.available = false;
      console.warn(
        `[chatgpt-web] rate-limit state file could not be written; circuit persistence disabled`
          + ` (fail-open, path=${this.path}) cause=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
