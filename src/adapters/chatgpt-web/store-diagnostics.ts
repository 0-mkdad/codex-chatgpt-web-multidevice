/**
 * Diagnostics for critical state stores that intentionally fail closed (TurnJournal,
 * CompactionHandoff, ThreadEnvironment). Continuing after corruption could duplicate native
 * execution or break environment continuity, so the only correct behavior is a clear,
 * actionable stop — never an auto-quarantine, silent rename, or silent re-initialization.
 */
export function criticalStoreLoadFailure(store: string, path: string | undefined, error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  const location = path ? ` at ${path}` : "";
  const failure = new Error(
    `Critical state store "${store}" failed validation${location}: ${cause}. `
      + "Execution has been stopped to prevent uncertain duplicate native actions. "
      + "Run doctor (bun run doctor, or the Launcher doctor) and inspect the launcher log; "
      + "the store is deliberately not re-initialized or overwritten automatically.",
  );
  failure.cause = error;
  return failure;
}
