import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupScratch, runSandboxed } from "./run-sandboxed.js";
import { loadHostileFixture } from "./fixtures/index.js";

/**
 * The permanent adversarial fixture, run for real through the actual sandbox — not just asserted
 * about in prose. This is the one test in this package that stands in for gate-market-spec.md
 * §2.3's real threat model: WORKER-CODE, told to attack a candidate gate, writing exactly this
 * kind of submission. Every future change to run-sandboxed.ts re-runs this file.
 */
describe("the permanent hostile fixture", () => {
  it("is contained on every vector at once: env, network, path traversal, timeout, fork bomb", async () => {
    process.env.TOUCHSTONE_HOSTILE_SENTINEL = "leak-if-inherited";
    let result;
    try {
      result = await runSandboxed({
        files: { "entry.mjs": await loadHostileFixture() },
        entry: "entry.mjs",
        timeoutMs: 1500,
        // 1.5GB, not a tight number: V8 needs ~512MB-1GB of virtual address space reservation
        // just to boot, independent of actual usage — see run-sandboxed.ts's memoryLimitKb doc.
        memoryLimitKb: 1572864,
        maxProcesses: 4096,
        maxHeapMb: 256,
      });
    } finally {
      delete process.env.TOUCHSTONE_HOSTILE_SENTINEL;
    }

    // Vectors 4 and 5 (busy-loop, fork bomb) mean this submission never exits on its own — the
    // harness's wall-clock kill firing is itself part of what "contained" means here.
    expect(result.timedOut).toBe(true);

    const raw = await readFile(join(result.scratchDir, "hostile-results.json"), "utf-8");
    const results = JSON.parse(raw.trim().split("\n")[0] ?? "{}");

    // 1, not 0: PWD is set by the process's own cwd tracking, not inherited from the parent —
    // see run-sandboxed.test.ts's "does not inherit the parent environment" for the same case.
    expect(results.env.keyCount).toBe(1);
    expect(results.env.sentinel).toBeNull();
    expect(results.network.reached).toBe(false);
    expect(results.pathTraversal.blocked).toBe(true);

    await cleanupScratch(result.scratchDir);
  }, 10000);
});
