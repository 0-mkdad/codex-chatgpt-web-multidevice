import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import { criticalStoreLoadFailure } from "./store-diagnostics";
import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironment,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptMidTurnEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  chatGptEnvironmentResolutionProbes,
  hasCurrentChatGptEnvironmentContext,
  matchChatGptNoCwdEnvironmentDelta,
  hasRawChatGptEnvironmentContext,
  unattributedChatGptEnvironmentMessages,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  parseChatGptHistoricalEnvelope,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
  type ChatGptTurnIdentity,
} from "./environment";
import { resolveCurrentCodexRolloutEnvironment } from "./codex-rollout-environment";
import { chatGptWebTraceHash, emitChatGptWebStructuredTrace } from "./structured-trace";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const unique = new Map<string, string>();
  for (const path of value.map(path => resolve(path as string))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    const policyRoots = absolutePaths(parsed.writableRoots, "workspace-write policy writable roots");
    const declared = new Set(policyRoots.map(pathIdentity));
    // Project membership is not the grant boundary: native Codex also authorizes
    // external output directories. Both persisted grant sets must agree exactly.
    if (typeof parsed.networkAccess !== "boolean" || policyRoots.length !== writableRoots.length
      || writableRoots.some(path => !declared.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
  };
}

function sameAuthority(left: ChatGptTurnEnvironment, right: ChatGptTurnEnvironment): boolean {
  const samePaths = (a: string[], b: string[]): boolean => {
    const expected = new Set(b.map(pathIdentity));
    return a.length === expected.size && a.every(path => expected.has(pathIdentity(path)));
  };
  return pathIdentity(left.cwd) === pathIdentity(right.cwd)
    && samePaths(left.roots, right.roots)
    && samePaths(left.writableRoots, right.writableRoots)
    && left.sandboxPolicy.type === right.sandboxPolicy.type
    && (left.sandboxPolicy.type === "dangerFullAccess" || (right.sandboxPolicy.type !== "dangerFullAccess"
      && left.sandboxPolicy.networkAccess === right.sandboxPolicy.networkAccess));
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
  ) {}

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    try {
      const environment = extractChatGptTurnEnvironment(parsed);
      if (identity.threadId) this.set(identity.threadId, environment);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError) || !identity.threadId) throw error;
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      const historicalMessages = hasCurrentContext && !currentCompaction && lineage
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      const steeringClaim = hasCurrentContext && !currentCompaction
        ? extractChatGptSteeringEnvironmentClaim(parsed) : undefined;
      const noCwdDelta = hasCurrentContext && !currentCompaction
        ? matchChatGptNoCwdEnvironmentDelta(parsed) : undefined;
      const midTurnClaim = hasCurrentContext && !currentCompaction && !noCwdDelta
        ? extractChatGptMidTurnEnvironmentClaim(parsed) : undefined;
      const resolutionState = {
        hasCurrentContext,
        compactionContinuation: currentCompaction,
        historicalMessages: historicalMessages !== undefined,
        steeringClaim: steeringClaim !== undefined,
        noCwdDelta: noCwdDelta !== undefined,
        midTurnClaim: midTurnClaim !== undefined,
      };
      if (hasCurrentContext && !currentCompaction && !historicalMessages && !steeringClaim
        && !noCwdDelta && !midTurnClaim) {
        this.failResolution(parsed, identity, resolutionState, "unrecognized_current_environment_claim", error);
        throw error;
      }
      const currentClaim = currentCompaction ? extractChatGptContinuationEnvironmentClaim(parsed)
        : steeringClaim ?? midTurnClaim;
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSourceTurnId = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed).turnId : undefined;
      if (rolloutIdentity && identity.turnId) {
        const rolloutEnvironment = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHome,
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          tools: parsed.context.tools,
        });
        if (rolloutEnvironment) {
          if (noCwdDelta && noCwdDelta.sandboxType !== rolloutEnvironment.sandboxPolicy.type) {
            throw new Error("No-cwd environment delta conflicts with its current Codex rollout");
          }
          if (currentClaim && !sameAuthority(currentClaim, rolloutEnvironment)) {
            throw new Error(`${currentCompaction ? "Compaction continuation" : steeringClaim ? "Steering" : "Mid-turn"} environment conflicts with its current Codex rollout`);
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment);
          return rolloutEnvironment;
        }
      }
      if (noCwdDelta || midTurnClaim) {
        // A mid-turn claim restates current policy; only this turn's native rollout can prove it.
        // The cached same-thread authority cannot: it may predate a legitimate mid-turn change,
        // so serving it here could mask a real revocation. Fail closed with diagnostics.
        this.failResolution(parsed, identity, {
          ...resolutionState,
          rolloutIdentityPresent: rolloutIdentity !== undefined,
          rolloutRecovered: false,
          cachedSameThreadPresent: (() => {
            try {
              return Boolean(this.get(identity.threadId!));
            } catch {
              // A corrupt store must not mask the original rejection reason in the diagnostic.
              return false;
            }
          })(),
        }, "current_environment_claim_without_rollout_corroboration", error);
        throw error;
      }
      const sameThread = this.get(identity.threadId);
      // Resent continuation history carries this thread's own start envelope. When that historical
      // envelope parses to exactly the stored, verified authority, it is recognition of server-side
      // state rather than a new request claim and must not block the same-thread fallback. Current
      // environment claims (midnight deltas, steering) and unrecognized envelopes still fail closed.
      const historicalEnvelope = parseChatGptHistoricalEnvelope(parsed);
      const resentOwnEnvelope = sameThread !== undefined && historicalEnvelope !== undefined
        && sameAuthority(historicalEnvelope, {
          cwd: sameThread.cwd,
          roots: sameThread.roots,
          writableRoots: sameThread.writableRoots,
          sandboxPolicy: sameThread.sandboxPolicy,
          tools: [],
        });
      // Only a current native rollout can supersede an unrecognized historical envelope. Without
      // that proof, do not turn arbitrary history or an invalid update into cached authority.
      if (hasRawChatGptEnvironmentContext(parsed) && !resentOwnEnvelope) throw error;
      if (sameThread) return {
        cwd: sameThread.cwd,
        roots: sameThread.roots,
        writableRoots: sameThread.writableRoots,
        sandboxPolicy: sameThread.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };

      if (!lineage) throw error;
      const parent = this.get(lineage.parentThreadId);
      if (!parent) throw error;
      if (lineage.sandboxType !== parent.sandboxPolicy.type) {
        throw new Error("ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread");
      }
      if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
        throw new Error("ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd");
      }
      if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
        contains(parentRoot, root) || contains(root, parentRoot)
      )))) {
        throw new Error("ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots");
      }
      const inherited: ChatGptTurnEnvironment = {
        cwd: parent.cwd,
        roots: parent.roots,
        writableRoots: parent.writableRoots,
        sandboxPolicy: parent.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      this.set(lineage.threadId, inherited);
      return inherited;
    }
  }

  private failResolution(
    parsed: CodexParsedRequest,
    identity: ChatGptTurnIdentity,
    states: {
      hasCurrentContext: boolean;
      compactionContinuation: boolean;
      historicalMessages: boolean;
      steeringClaim: boolean;
      noCwdDelta: boolean;
      midTurnClaim: boolean;
      rolloutIdentityPresent?: boolean;
      rolloutRecovered?: boolean;
      cachedSameThreadPresent?: boolean;
    },
    reason: string,
    error: unknown,
  ): void {
    const probes = chatGptEnvironmentResolutionProbes(parsed);
    emitChatGptWebStructuredTrace("environment_resolution_failed", {
      ...(identity.threadId ? { threadHash: chatGptWebTraceHash(identity.threadId) } : {}),
      ...(identity.turnId ? { turnHash: chatGptWebTraceHash(identity.turnId) } : {}),
      thread_id_present: Boolean(identity.threadId),
      turn_id_present: Boolean(identity.turnId),
      environment_fragment_count: probes.environmentFragmentCount,
      current_turn_fragment_count: probes.currentTurnFragmentCount,
      current_cwd_claim_present: probes.currentCwdClaimPresent,
      current_workspace_roots_present: probes.currentWorkspaceRootsPresent,
      current_environment_context: states.hasCurrentContext,
      compaction_continuation: states.compactionContinuation,
      historical_environment_messages: states.historicalMessages,
      steering_claim: states.steeringClaim,
      no_cwd_profile_delta: states.noCwdDelta,
      mid_turn_claim: states.midTurnClaim,
      rollout_identity_present: states.rolloutIdentityPresent ?? false,
      rollout_recovered: states.rolloutRecovered ?? false,
      cached_thread_environment_present: states.cachedSameThreadPresent ?? false,
      rejection_reason: reason,
    }, "warning");
    void error;
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment): void {
    this.load();
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, this.now()));
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (!this.path || !existsSync(this.path)) {
        this.loaded = true;
        return;
      }
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredThreadEnvironmentFile>;
      const rawThreads = record(parsed.threads);
      if (parsed.version !== 1 || !rawThreads) {
        throw new Error(`Invalid ChatGPT thread environment store: ${this.path}`);
      }
      const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
      const entries = Object.entries(rawThreads)
        .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
        .filter(([, environment]) => environment.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_THREAD_ENVIRONMENTS);
      for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
      // Only a fully validated load marks the store as loaded; corruption keeps failing closed.
      this.loaded = true;
    } catch (error) {
      throw criticalStoreLoadFailure("ThreadEnvironment", this.path, error);
    }
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
