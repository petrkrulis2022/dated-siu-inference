# Task: F3 standalone — the integer control arm

Scoped 2026-10-02. **Not started.** Design and rationale: `gate-market-spec.md` §7.3a.
Does not block the protocol freeze or the five F1 runs.

---

## What exists today, and why none of it is reusable as-is

`packages/gate-market-agents/src/context/dual-render.ts` has a working `DualRenderer`. It is
not the experiment:

- wired into **one** tool (`get_balances`), none of the tools where a number decides something;
- returns **both** representations in the same object, labelled with which arm is live, so the
  agent sees `{"decimalUsd":"0.305618","integerMinorUnits":"305618","liveArm":"decimal"}`;
- `allRecords()` is never called — nothing is persisted, nothing is reported.

Keep the conversion helper (`usdToMinorUnits` reuse) and the arm-alternation idea. Discard the
embedding.

## Deliverable

A standalone CLI under `packages/gate-market-agents/src/cli/` that runs the trials, writes raw
per-trial records to `data/f3/`, and prints per-model per-arm error rates with intervals.

## Build order

1. **Trial generator.** Four types — order-of-magnitude, unequal decimal length, transposition,
   coverage — with magnitudes drawn from the ranges in §7.3a and a pinned seed so a run is
   reproducible. Each trial carries its own ground-truth answer. Unit-test the generator against
   its own ground truth: a generator that can emit a trial whose stated answer is wrong
   invalidates everything downstream.
2. **Three renderings** of each trial: decimal USD, integer minor units, integer mSIU. One per
   prompt, never labelled, never two at once. Assert by test that no prompt contains two.
3. **The decision frame.** A short settlement context, identical across arms, varying only in
   the rendered quantities.
4. **Runner.** Four model families, both effort conditions, arm order randomised per trial,
   every response and its grading persisted.
5. **Analysis.** Wilson intervals per model per arm; McNemar across paired arms; constrained and
   unconstrained reported separately.

## The pilot gate

**Run 50 trials per arm first and report the error rates before scaling.** If they are at the
floor, do not proceed — recalibrate magnitudes toward where error appears and state what
changed. A null at the floor is uninformative and cannot be distinguished after the fact from a
real null.

## What the writeup must contain

- The transposition control result, **prominently**. If integers beat decimals there too, the
  place-alignment explanation is wrong and the writeup says so.
- Constrained and unconstrained separately, with the weaker claim labelled.
- Whatever the pilot changed, and why.
- If the result is null: whether it is null at the floor or null where errors occur.

## Cost

Roughly 4,800 calls at a few hundred tokens each — single-digit dollars of base cost, though
reasoning tokens may multiply it. The pilot bounds this before the full run commits.

## Open question for the operator

None outstanding. The representation fork (minor units versus mSIU) was settled on
2026-10-02: **run all three arms**, because without the minor-units arm "integers help" and
"this unit helps" are confounded, and only the second is a claim nobody else can produce.
