# @touchstone/gate-market

The Gate Market testbed (`docs/gate-market-spec.md`). WP-1: the sandboxed harness and gate
executor. See that spec for the full design; this file tracks package-specific operational notes
that don't belong in the spec itself.

## Test retries — the full audit

One test in this package is retried. Retrying absorbs real environment noise; it must never
absorb a real correctness gap, especially not in the machinery gate-hardening's own payment
decision rests on. Per review, 2026-09-22: every retry site is listed here, so this stays a
complete audit rather than something to grep for and hope.

| Test | Retried? | Why |
| --- | --- | --- |
| `executor.test.ts` → "runs the gate spec itself inside the sandbox — agent-authored gates are not trusted either" | **Yes**, `retry: 2` | Checks a containment property (env/network isolation), not gate correctness. Found live to flake specifically under vitest's own process overhead on one shared, busy local dev machine — never reproduced calling the same sandboxed evaluation directly and repeatedly outside vitest. Real CI (a clean runner) has been green on this test across every run since. |
| `executor.test.ts` → "fails G5 when the hardened gate is non-deterministic" | **No**, deliberately | Exercises G5's own determinism-detection logic — the property the entire gate-hardening class rests on (spec §2.4). Its fixture is an intentionally random gate, so it has an irreducible, undisguised **25%** chance per run of a false negative (3 independent fair-coin draws agreeing by chance: 0.5³+0.5³). Retrying would make that indistinguishable from the executor silently failing to notice real non-determinism — exactly the failure mode a gate-hardening harness exists to prevent. If this test flakes, it's the known 25% case, visible as a real failure, not masked. |

Any new retry added to this package must be added to this table in the same commit, with the same
two questions answered: does it check a containment/environment property, or does it check
whether a gate (or the executor's own checks on a gate) behaved correctly? Only the former may be
retried.
