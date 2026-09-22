import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertBubblewrapAvailable } from "./capability.js";

/**
 * `spawn` inherits the full parent environment unless `env` is passed explicitly — the exact bug
 * fixed in `packages/basket/src/t3/grade.ts` (2026-09-22). PATH is the only thing the outer
 * `bash`/`bwrap` processes need, to resolve themselves and each other; the sandboxed code itself
 * gets `--clearenv` (see below), which is the real boundary — this is defence in depth on the
 * process that sets that boundary up.
 */
const SAFE_SPAWN_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

export interface SandboxRunOptions {
  /** Files staged into the sandbox's own scratch directory before execution, keyed by path
   * relative to that directory. This is the *only* writable location inside the sandbox. */
  files: Record<string, string>;
  /** Path, relative to the scratch directory, to the script `node` executes. */
  entry: string;
  /** Extra argv entries visible to the entry script as `process.argv.slice(2)`. */
  args?: string[];
  timeoutMs: number;
  /** RLIMIT_AS in KB, enforced via `ulimit -v` on the process that execs bwrap (rlimits survive
   * exec). Unlike RLIMIT_NPROC, this is scoped per-process rather than per-UID, so it isn't
   * corrupted by however many unrelated processes this host's user account already has running —
   * proven live, 2026-09-22, against a Python allocation loop with zero measurable host memory
   * impact. But RLIMIT_AS caps *virtual address space reservation*, not resident memory, and V8
   * reserves a large virtual range for its CodeRange at isolate boot regardless of actual usage —
   * also found live: Node fails to start at all below ~512MB reserved ("Fatal process out of
   * memory: Failed to reserve virtual memory for CodeRange"), boots reliably at 1GB. Must stay
   * comfortably above that floor or every sandboxed run fails before the submission's own code
   * ever executes — this is a boot requirement, not a generous allowance. 1.5GB still bounds a
   * real unbounded allocation loop to ~540MB before RangeError, confirmed live. */
  memoryLimitKb: number;
  /** RLIMIT_NPROC headroom passed to `ulimit -u` — NOT the fork-bomb defence (that's
   * `--unshare-pid` plus the hard wall-clock kill below: killing a namespace's PID 1 reaps every
   * process in it atomically, proven directly by killing a sandbox mid-run and confirming a
   * background child's writes stopped and its host-visible process disappeared). This exists
   * only so a runaway submission can't exhaust real host process-table slots during the timeout
   * window. Must be set comfortably above this host's own baseline process count or bwrap's own
   * setup fails first with "Creating new namespace failed" — that failure has nothing to do with
   * the submission and everything to do with how busy the host already is. */
  maxProcesses: number;
  /** Node's own `--max-old-space-size`, belt-and-suspenders on top of `memoryLimitKb` — same
   * convention as T3's sandbox. */
  maxHeapMb: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Caller's responsibility to read any result file the entry script wrote here before the
   * caller itself decides when to clean it up — this module never deletes it. */
  scratchDir: string;
}

const STANDARD_RO_BINDS = ["/usr", "/bin", "/lib"] as const;
const OPTIONAL_RO_BINDS = ["/lib64", "/usr/lib"] as const;

async function writeStagedFiles(scratchDir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(scratchDir, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
}

function buildBwrapArgs(
  scratchDir: string,
  nodeDir: string,
  entry: string,
  args: string[],
  maxHeapMb: number,
): string[] {
  const binds: string[] = [];
  for (const dir of STANDARD_RO_BINDS) binds.push("--ro-bind", dir, dir);
  for (const dir of OPTIONAL_RO_BINDS) binds.push("--ro-bind-try", dir, dir);
  // node's own directory, wherever it actually lives (nvm, a CI toolcache, /usr/bin — never
  // assumed): bound at the *same* absolute path so `process.execPath` resolves unchanged inside
  // the sandbox. Proven live, 2026-09-22 — this is real, not a guess: T3's sandbox never needed
  // this because it never restricted the filesystem in the first place.
  binds.push("--ro-bind", nodeDir, nodeDir);

  return [
    "--unshare-all",
    "--clearenv",
    ...binds,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--bind",
    scratchDir,
    "/scratch",
    "--chdir",
    "/scratch",
    "--die-with-parent",
    "--",
    process.execPath,
    `--max-old-space-size=${maxHeapMb}`,
    join("/scratch", entry),
    ...args,
  ];
}

export async function runSandboxed(options: SandboxRunOptions): Promise<SandboxRunResult> {
  await assertBubblewrapAvailable();

  const nodeDir = dirname(process.execPath);
  const scratchDir = await mkdtemp(join(tmpdir(), "touchstone-gate-market-sandbox-"));

  try {
    await writeStagedFiles(scratchDir, options.files);

    const bwrapArgs = buildBwrapArgs(
      scratchDir,
      nodeDir,
      options.entry,
      options.args ?? [],
      options.maxHeapMb,
    );

    // `ulimit` is a shell builtin — there is no `child_process` option for RLIMIT_AS/RLIMIT_NPROC,
    // so a shell has to set them before exec'ing bwrap. Positional parameters (`"$@"`), not
    // string interpolation, avoid re-opening a shell-quoting hole for scratchDir/nodeDir paths.
    // `--norc --noprofile`: found live, 2026-09-22 — a plain `bash -c` on this host silently
    // sourced a startup file (a PM2 shell hook) and polluted captured stdout. Beyond the noise,
    // an unaudited startup file influencing the shell that sets these rlimits and execs bwrap is
    // exactly the kind of implicit behavior this wrapper shouldn't have, regardless of host.
    const wrapperScript =
      'ulimit -u "$1"; ulimit -v "$2"; shift 2; exec bwrap "$@"';

    const result = await new Promise<SandboxRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn(
        "bash",
        [
          "--norc",
          "--noprofile",
          "-c",
          wrapperScript,
          "--",
          String(options.maxProcesses),
          String(options.memoryLimitKb),
          ...bwrapArgs,
        ],
        { cwd: scratchDir, timeout: options.timeoutMs, killSignal: "SIGKILL", env: SAFE_SPAWN_ENV },
      );

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        resolve({
          exitCode: null,
          timedOut: false,
          stdout,
          stderr: `${stderr}\n${String(err)}`,
          scratchDir,
        });
      });
      child.on("close", (code, signal) => {
        if (signal === "SIGKILL" || signal === "SIGTERM") timedOut = true;
        resolve({ exitCode: code, timedOut, stdout, stderr, scratchDir });
      });
    });

    return result;
  } catch (err) {
    await rm(scratchDir, { recursive: true, force: true });
    throw err;
  }
}

/** Separate from `runSandboxed` itself: a caller that needs to read a result file the entry
 * script wrote must do so before calling this, since it deletes `result.scratchDir`. */
export async function cleanupScratch(scratchDir: string): Promise<void> {
  await rm(scratchDir, { recursive: true, force: true });
}
