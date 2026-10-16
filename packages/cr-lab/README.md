# @touchstone/cr-lab

The Blockworks trial (lab series CR, crypto research). The plan is §16 of `docs/marketplace_plan.md`; this package is built in the order of §16.10.

**Nothing in the trial enters Dated SIU or any published print.** Blockworks data is licensed and this repository is public, so it lives only under `data/private/` (gitignored). What is committed is `data/lab/cr/`: budgets, the spend ledger, and hash-only manifests.

- `src/paths.ts`, `src/keys.ts`: where things may live, and the trial's own `CR_*` keys (never the print's).
- `src/spend/`: the spend ledger and its guard. Per-provider budgets and the $9 daily cap; it fails closed.
- `src/data-desk/`: the one way to read Blockworks. A fixtures backend (synthetic, `fixture-*` names) and a live backend (not yet run against the real API), a once-per-window snapshot store, a rate-limit governor, and the query catalog.
- `src/isolation.test.ts`: reads the source to prove the trial never names a print variable and print code never names a `CR_` one.

```
pnpm --filter @touchstone/cr-lab run test
pnpm --filter @touchstone/cr-lab run spend-report   # today's spend against the cap
pnpm --filter @touchstone/cr-lab run desk-smoke     # the data desk end to end on fixtures
```

A fresh checkout needs `pnpm install` and `@touchstone/sdk` built first (`pnpm --filter @touchstone/sdk run build`).
