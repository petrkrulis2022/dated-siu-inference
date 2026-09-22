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

### The G5-determinism flake, eliminated rather than managed (2026-09-22)

An earlier version of this table listed a second, deliberately-unretried test ("fails G5 when the
hardened gate is non-deterministic") with a disclosed, undisguised ~25% chance of a false negative
per run — its fixture was a genuinely random gate (`Math.random() > 0.5`), used to prove G5's
comparison logic without touching the sandbox's own randomness. That flake fired for real in CI,
was immediately attributable, and passed on a job re-run of identical code — but a 25% failure
rate on the property the entire gate-hardening class rests on isn't something a job re-run should
paper over, especially once a real run means hundreds of gate evaluations rather than one CI job.

Diagnosed before fixing (20 independent trials, 60 real sandboxed evaluations, run outside vitest
to rule out the box, not just the test): **zero infra failures.** Every "agreement" was a genuine,
correctly-computed 3-way boolean coincidence — not bwrap/namespace timing, not a wall-clock
timeout, not iteration-order or key-ordering. The flake was entirely the test fixture's own
designed randomness, not a bug in the real gates (`code`/`extract`'s Gate 1/2/3, none of which use
unconditional randomness; `code`'s Gate 3 uses *internal* randomness for a property check and was
separately verified 10/10 consistent against both a correct and a broken implementation).

That diagnosis did surface a real, separate bug worth fixing regardless: `evaluateGate` used to
collapse "the gate computed a verdict" and "the harness never got to run the gate at all" into the
same comparable shape, so three identical infra failures would compare as "equal" and G5 would
report a clean, false `passed: true` — a real verdict was never computed. Fixed by making that
distinction a real type (`GateOutcome`'s `verdict` / `gate_error` / `infra_failure`), adding
bounded retry (`evaluateGateWithRetry`, 2 retries) on the infra channel only, and making any
unresolved infra failure block `passed: true` explicitly (`CheckResult.infraFailure`) rather than
risk it being silently absorbed. The random-gate test is gone, replaced by `outcomesAgree`'s
exhaustive, synchronous unit tests (zero flake, since the inputs are fixed) plus
`runGateHardeningChecks`'s injectable `evaluate` dependency (same pattern as
`packages/agents/src/seller.ts`'s `SellerDeps`), which lets the infra-failure-vs-verdict
distinction be tested with a controlled outcome queue instead of real randomness. See
`executor.test.ts`'s "infra failure vs. verdict (the bug this fixes)" suite.

Any new retry added to this package must be added to the table above in the same commit, with the
same two questions answered: does it check a containment/environment property, or does it check
whether a gate (or the executor's own checks on a gate) behaved correctly? Only the former may be
retried — and per the above, prefer eliminating a correctness-check's own flakiness at the source
over accepting it as a documented rate at all, wherever that's actually possible.
