import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Found live, 2026-09-22: this package's tests spin up real OS-level sandboxes (bash + bwrap
    // + a fresh V8 boot per evaluation), and running multiple test *files* concurrently — vitest's
    // default — intermittently produced empty-stdout / unexpected-timeout failures under real
    // host memory pressure that never reproduced with files run one at a time. The executor's own
    // multi-evaluation checks (G2/G4/G5) were already made sequential for the same reason; this
    // closes the same gap at the file level. Slower; correct — these tests exercise a security
    // boundary, and a flaky pass here is worse than a slow one.
    fileParallelism: false,
  },
});
