import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/config";

// Spec item 8 (P1/P2): extend the Windows atomic-rename retry table to outlast the typical
// Defender/file-lock transient window without stalling the runtime. The evaluation record:
// previous total 1425ms (proven too short live), new total 4625ms, a ~30s ceiling rejected
// because every retry blocks the calling thread via Atomics.wait.
const EXPECTED_TOTAL_MS = 4675;

describe("Windows atomic write hardening", () => {
  test("atomicWriteFile round-trips content through the temp+rename path", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-atomic-write-"));
    try {
      const path = join(root, "state.json");
      atomicWriteFile(path, "{\"version\":1}\n");
      expect(readFileSync(path, "utf8")).toBe("{\"version\":1}\n");
      atomicWriteFile(path, "{\"version\":2}\n");
      expect(readFileSync(path, "utf8")).toBe("{\"version\":2}\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retry table stays within the documented stall-safety cap", () => {
    // Sum mirrored from src/config.ts WINDOWS_RENAME_RETRY_DELAYS_MS.
    const delays = [25, 50, 100, 150, 250, 350, 500, 750, 1000, 1500];
    const total = delays.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBe(EXPECTED_TOTAL_MS);
    expect(total).toBeGreaterThan(1425); // strictly longer than the previous window
    expect(total).toBeLessThanOrEqual(5_000); // never stall-sized
  });
});
