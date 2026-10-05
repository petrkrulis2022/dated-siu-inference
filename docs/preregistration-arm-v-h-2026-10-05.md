# Pre-registration: schedule visibility, arms V and H

Registered 2026-10-05, **before any block run**. The commit that adds this file is its timestamp.
The text below is verbatim from the registration instruction and is not edited afterwards; anything
that changes it is a new dated file, not an edit.

## Hypothesis

An agent holds fSIU in proportion to the work it expects to buy before its window closes. It holds
USDC for three reasons: costs priced in dollars, profit it will take out, and work it cannot yet
see. Making upcoming work visible shrinks the third reason, so visible work should raise fSIU
holdings and onward spending.

## Decision rule

D5 unchanged, evaluated on arm V.

## What this file does and does not fix

- **Arms.** Arm V: the schedule is visible. Arm H: no schedule shown; everything else identical.
  Same seeds in both arms. Five runs per arm.
- **D5** is `packages/gate-market-agents/src/cli/decision-rule.ts` as of this commit — the
  balance-level reading of "spent onward" (spec §4.6at), with the looser reading printed beside it.
  Arm H is the control: it is reported, and it does not enter the verdict.
- **Not fixed here:** the exact wording of the briefs (the schedule, the treasury facts). Those are
  frozen at the freeze commit, which is after the model debug runs. The arm labels, the seeds and
  the wording will be recorded in the block's own manifest.
- **A debug run, a scripted run and any shortened run cannot count toward either arm**, enforced in
  code (`assertCountableForF1`), not by convention.
