# Datum

Datum publishes Dated SIU — the benchmark price of AI inference work, measured by actually
buying inference against a versioned task basket, not by surveying list prices.

## The two hard invariants

1. **The print is computed from executed runs only.** Published list prices inform exchange
   rates and are never inputs to the print.
2. **The escrow contract is non-custodial.** Funds move only to the pre-agreed seller, back to
   the buyer, or to the fee treasury — no admin path to user money exists in any code path.

## How to run a print

_Placeholder — wired up once `packages/print` exists._

## Docs

- [`CLAUDE.md`](./CLAUDE.md) — vocabulary, invariants, build boundaries.
- [`docs/build1-spec.md`](./docs/build1-spec.md) — the Build 1 engineering specification.
- [`docs/plan.md`](./docs/plan.md) — orientation, dependency order, and open risks.
