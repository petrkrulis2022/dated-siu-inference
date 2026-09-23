import { fileURLToPath } from "node:url";

// packages/gate-market-agents/{src,dist}/cli/*.{ts,js} -> repo root. `new URL(ref, base)`
// resolves against the *directory* of `base` (the filename is dropped for free), unlike
// devnet/deploy.ts's contractsDir(), which uses `path.resolve` and therefore needs one extra
// ".." to pop the filename itself — confirmed by running both forms rather than counted by eye.
// Shared by every CLI entry point in this package so the real run-storage location can't drift
// between them.
export const RUNS_ROOT = fileURLToPath(new URL("../../../../data/gate-market/runs", import.meta.url));
