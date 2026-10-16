/** Read-only: today's trial spend against the daily cap, and each provider's spend against its budget. Spends nothing and reads no key. `pnpm --filter @touchstone/cr-lab run spend-report` */
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore } from "../spend/store.js";

const ledger = new SpendLedger({
  store: new FileLedgerStore(),
  policy: policyFromBudgets(loadBudgets()),
});
const r = ledger.report();
console.log(
  `Blockworks trial spend, UTC ${r.day}: $${r.spentToday} of the $${r.dailyCapUsd} daily cap ($${r.remainingToday} left)`,
);
const parts = Object.entries(r.todayByPart);
if (parts.length > 0)
  console.log(`  today by part: ${parts.map(([part, usd]) => `${part} $${usd}`).join(", ")}`);
for (const p of r.providers) {
  console.log(
    p.budgetUsd === null
      ? `  ${p.provider.padEnd(10)} no budget set: the trial may not spend here until a balance is recorded`
      : `  ${p.provider.padEnd(10)} spent $${p.spentUsd} of a $${p.budgetUsd} budget ($${p.remainingUsd} left), balance read ${p.since}`,
  );
}
