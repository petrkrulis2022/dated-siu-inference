import { spawn } from "node:child_process";

/**
 * Real, functional check — not just "does the `bwrap` binary exist" — because the actual risk
 * (gate-market-spec.md §1's whole premise: agents are told to attack this harness) is an
 * unprivileged-userns restriction blocking bwrap at runtime even though the binary is installed.
 * Confirmed live, 2026-09-22: Ubuntu 24.04+ can restrict this via
 * `kernel.apparmor_restrict_unprivileged_userns`, and it varies between a local dev box and CI —
 * this must be checked in the environment that's about to run untrusted code, every time, never
 * assumed from a prior run or a different machine.
 */
export function bubblewrapAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn("bwrap", [
      "--unshare-all",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--die-with-parent",
      "--",
      "/bin/true",
    ]);
    check.on("error", () => resolve(false));
    check.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Throws rather than returning false — every caller in this package that needs the sandbox must
 * fail loudly (a red build) rather than silently skip or, worse, fall back to executing
 * agent-authored code unsandboxed. This is the same discipline `packages/basket/src/t3/grade.ts`
 * already applies for `unshare`, and it matters more here: T3's candidates aren't adversarial,
 * gate-market's are, by design (spec §2.3).
 */
export async function assertBubblewrapAvailable(): Promise<void> {
  if (!(await bubblewrapAvailable())) {
    throw new Error(
      "bubblewrap (bwrap) is not available or unprivileged user namespaces are restricted in " +
        "this environment (Ubuntu 24.04+'s kernel.apparmor_restrict_unprivileged_userns is a " +
        "known cause). Refusing to execute agent-authored code without OS-level sandboxing — " +
        "there is no unsandboxed fallback path in this package, by design.",
    );
  }
}
