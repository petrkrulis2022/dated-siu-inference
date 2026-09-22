import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Found live, 2026-09-22 (WP-5): every dry-loop test file's setupDevnet() runs a real
    // `forge script ... --broadcast` and reads the resulting broadcast log back from a fixed
    // path (broadcast/DeployGateMarketLocal.s.sol/31337/run-latest.json) — the same path
    // regardless of which anvil instance/port it just deployed to. Running test *files*
    // concurrently (vitest's default) means two forge script invocations race on that one file,
    // and a reader can catch it mid-write ("Unexpected end of JSON input"). Each file's own
    // anvil instance is already isolated; only this one shared log path collides. Same root
    // cause and same fix as packages/gate-market/vitest.config.ts's own fileParallelism: false —
    // real external tooling with a shared filesystem side effect, not a bug in this package's
    // own logic.
    fileParallelism: false,
  },
});
