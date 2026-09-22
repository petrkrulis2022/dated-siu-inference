import { spawn } from "node:child_process";

function commandAvailable(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn(command, args);
    check.on("error", () => resolve(false));
    check.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Real, functional checks — `anvil --version`/`forge --version`, not just "is the binary on
 * PATH" — same discipline `packages/gate-market/src/sandbox/capability.ts`'s
 * `bubblewrapAvailable` already applies to bwrap: check in the environment that's about to run
 * the thing, every time, never assumed from a prior run or a different machine.
 */
export async function foundryToolchainAvailable(): Promise<boolean> {
  const [anvil, forge] = await Promise.all([
    commandAvailable("anvil", ["--version"]),
    commandAvailable("forge", ["--version"]),
  ]);
  return anvil && forge;
}

/** Throws rather than returning false — a dry-loop test that silently skipped because `anvil`
 * wasn't found would report a false green, exactly the failure mode WP-5's own prompt exists to
 * prevent ("this package must be green before any model is connected" only means something if
 * green requires the real thing to have actually run). */
export async function assertFoundryToolchainAvailable(): Promise<void> {
  if (!(await foundryToolchainAvailable())) {
    throw new Error(
      "anvil and/or forge are not available on PATH in this environment. The dry-loop suite " +
        "requires a real local devnet — there is no mocked-chain fallback path, by design (see " +
        "this package's WP-5 plan). Install Foundry (https://getfoundry.sh) or ensure " +
        "foundry-rs/foundry-toolchain has run before this suite in CI.",
    );
  }
}
