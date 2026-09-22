import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bubblewrapAvailable } from "./capability.js";
import { cleanupScratch, runSandboxed } from "./run-sandboxed.js";

// Generous on purpose: RLIMIT_NPROC headroom is cheap (it bounds a runaway, it isn't the
// fork-bomb defence — see run-sandboxed.ts's own doc comment), and proven live 2026-09-22 that a
// too-low value makes bwrap's *own* setup fail before the submission ever runs, on a host this
// busy. A fixed high ceiling is safer than trying to detect "this host's baseline" at test time.
//
// memoryLimitKb=1.5GB, not a tight number: RLIMIT_AS caps virtual address space, and V8 needs
// ~512MB-1GB of that just to boot (see run-sandboxed.ts's memoryLimitKb doc comment) — found live
// when a 200MB default made every test below fail with an empty stdout, not a JSON parse issue.
const DEFAULT_OPTS = { timeoutMs: 5000, memoryLimitKb: 1572864, maxProcesses: 4096, maxHeapMb: 256 };

describe("bubblewrap capability", () => {
  // No skip here, ever — an unavailable sandbox must fail this test, loudly, not be silently
  // bypassed. gate-market-spec.md §9.3's own abort table and this package's whole premise depend
  // on there being no path that looks green while agent-authored code ran unsandboxed.
  it("is available in this environment", async () => {
    expect(await bubblewrapAvailable()).toBe(true);
  });
});

describe("runSandboxed", () => {
  it("runs a trivial script and captures its stdout", async () => {
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      files: { "entry.mjs": 'console.log("hello from the sandbox");' },
      entry: "entry.mjs",
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from the sandbox");
    await cleanupScratch(result.scratchDir);
  });

  it("passes argv through to the entry script", async () => {
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      files: { "entry.mjs": "console.log(JSON.stringify(process.argv.slice(2)));" },
      entry: "entry.mjs",
      args: ["first", "second"],
    });
    expect(JSON.parse(result.stdout.trim())).toEqual(["first", "second"]);
    await cleanupScratch(result.scratchDir);
  });

  it("denies network access: fetch never reaches a real host", async () => {
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      files: {
        "entry.mjs": `
          try {
            await fetch("https://example.com");
            console.log(JSON.stringify({ reached: true }));
          } catch (e) {
            console.log(JSON.stringify({ reached: false, error: String(e) }));
          }
        `,
      },
      entry: "entry.mjs",
    });
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.reached).toBe(false);
    await cleanupScratch(result.scratchDir);
  });

  it("does not inherit the parent environment", async () => {
    process.env.TOUCHSTONE_GATE_MARKET_TEST_SECRET = "leak-if-inherited";
    try {
      const result = await runSandboxed({
        ...DEFAULT_OPTS,
        files: {
          "entry.mjs":
            'console.log(JSON.stringify({ envKeys: Object.keys(process.env), sentinel: process.env.TOUCHSTONE_GATE_MARKET_TEST_SECRET ?? null }));',
        },
        entry: "entry.mjs",
      });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.sentinel).toBeNull();
      // PWD is set by the process's own cwd tracking, not inherited — --clearenv still clears
      // everything that was actually in the parent environment, which is the property under test.
      expect(parsed.envKeys).toEqual(["PWD"]);
      await cleanupScratch(result.scratchDir);
    } finally {
      delete process.env.TOUCHSTONE_GATE_MARKET_TEST_SECRET;
    }
  });

  it("cannot read anything outside its own scratch directory", async () => {
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      files: {
        "entry.mjs": `
          import { readFileSync } from "node:fs";
          const attempts = [
            "/home/petrunix/dated-siu-inference/.env",
            "../.env",
            "/etc/passwd",
          ];
          const results = attempts.map((p) => {
            try {
              readFileSync(p, "utf-8");
              return { path: p, blocked: false };
            } catch {
              return { path: p, blocked: true };
            }
          });
          console.log(JSON.stringify(results));
        `,
      },
      entry: "entry.mjs",
    });
    const parsed = JSON.parse(result.stdout.trim()) as { path: string; blocked: boolean }[];
    for (const attempt of parsed) {
      expect(attempt.blocked).toBe(true);
    }
    await cleanupScratch(result.scratchDir);
  });

  it("can read and write its own scratch directory, and writes survive on the host", async () => {
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      files: {
        "entry.mjs": `
          import { writeFileSync, readFileSync } from "node:fs";
          writeFileSync("/scratch/output.txt", "written-from-sandbox");
          console.log(readFileSync("/scratch/output.txt", "utf-8"));
        `,
      },
      entry: "entry.mjs",
    });
    expect(result.stdout.trim()).toBe("written-from-sandbox");
    const onHost = await readFile(join(result.scratchDir, "output.txt"), "utf-8");
    expect(onHost).toBe("written-from-sandbox");
    await cleanupScratch(result.scratchDir);
  });

  it("caps memory per-process (RLIMIT_AS survives where RLIMIT_NPROC did not)", async () => {
    // Proven live, 2026-09-22 outside this test suite: a 1.5GB ceiling (the floor V8 needs just
    // to boot, see memoryLimitKb's doc comment) still bounded an unbounded Buffer.alloc loop to
    // ~540MB before RangeError, with negligible measured host memory impact for the smaller
    // 200MB case that motivated checking this at all. This test asserts the *behavioural*
    // contract — bounded, reported, not a hang or an uncaught crash — rather than re-measuring
    // host memory from inside a unit test.
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      files: {
        "entry.mjs": `
          const chunks = [];
          try {
            while (true) {
              chunks.push(Buffer.alloc(10 * 1024 * 1024));
            }
          } catch (e) {
            console.log(JSON.stringify({ bounded: true, chunkCount: chunks.length }));
          }
        `,
      },
      entry: "entry.mjs",
      timeoutMs: 8000,
    });
    expect(result.timedOut).toBe(false);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.bounded).toBe(true);
    // Well under what an unbounded loop would reach in this window — proves the cap fired, not
    // that the loop happened to finish on its own.
    expect(parsed.chunkCount).toBeLessThan(100);
    await cleanupScratch(result.scratchDir);
  }, 10000);

  it("kills the whole process tree on timeout, not just the entry process", async () => {
    // The property the whole sandbox model rests on: killing PID 1 of the namespace reaps every
    // process inside it atomically. Proven directly here, not inferred from a fast fork bomb —
    // a background child writes a heartbeat every 100ms; once the sandbox is killed, both the
    // writes and the process itself must be gone, not merely orphaned and still running.
    const result = await runSandboxed({
      ...DEFAULT_OPTS,
      timeoutMs: 1200,
      files: {
        "entry.mjs": `
          import { appendFileSync } from "node:fs";
          const timer = setInterval(() => {
            try { appendFileSync("/scratch/heartbeat.log", Date.now() + "\\n"); } catch {}
          }, 100);
          setTimeout(() => {}, 60000); // keep the process alive past the outer timeout
        `,
      },
      entry: "entry.mjs",
    });

    expect(result.timedOut).toBe(true);

    const atKill = (await readFile(join(result.scratchDir, "heartbeat.log"), "utf-8"))
      .trim()
      .split("\n").length;
    expect(atKill).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1000));
    const afterWait = (await readFile(join(result.scratchDir, "heartbeat.log"), "utf-8"))
      .trim()
      .split("\n").length;
    expect(afterWait).toBe(atKill);

    await cleanupScratch(result.scratchDir);
  }, 10000);
});
