/**
 * May the trial spend `projectedUsd` more on `provider`, now? The pure rule behind the ledger; no I/O, so it can be tested exhaustively.
 *
 * Two limits, both counted **with the calls in flight** so concurrent calls cannot jointly overshoot:
 *  - the daily cap: everything the trial spent today (UTC), across providers (D73);
 *  - the provider's budget: what that provider may spend on the trial in total, since its balance was read (D72). The budget is the balance minus 30 days of the
 *    print's own spend there, so the print is protected by construction. A provider with no budget is refused: the guard fails closed.
 */
import type { Provider } from "../keys.js";
import { D } from "@touchstone/sdk";
import { fmtUsd, parseUsd } from "./money.js";
import type { Pending, SpendEntry, SpendPolicy } from "./types.js";

export type StopCode = "daily-cap" | "provider-budget" | "no-budget";

export type SpendCheck =
  | {
      ok: true;
      spentToday: string;
      remainingToday: string;
      providerSpent: string;
      providerRemaining: string;
    }
  | { ok: false; code: StopCode; reason: string; spentToday: string; providerSpent: string };

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export function checkSpend(input: {
  entries: readonly SpendEntry[];
  pending: readonly Pending[];
  now: Date;
  provider: Provider;
  projectedUsd: string;
  policy: SpendPolicy;
}): SpendCheck {
  const projected = parseUsd(input.projectedUsd, "projectedUsd");
  const cap = parseUsd(input.policy.dailyCapUsd, "dailyCapUsd");
  const day = utcDay(input.now);

  const sum = (rows: readonly { usd: string }[]) =>
    rows.reduce((acc, r) => acc.plus(r.usd), new D(0));
  const inFlight = sum(input.pending);
  const spentToday = sum(input.entries.filter((e) => utcDay(new Date(e.at)) === day)).plus(
    inFlight,
  );

  const budget = input.policy.providers[input.provider];
  const since = budget === undefined ? 0 : new Date(budget.since).getTime();
  const providerSpent = sum(
    input.entries.filter((e) => e.provider === input.provider && new Date(e.at).getTime() >= since),
  ).plus(sum(input.pending.filter((p) => p.provider === input.provider)));

  const base = { spentToday: fmtUsd(spentToday), providerSpent: fmtUsd(providerSpent) };

  if (budget === undefined) {
    return {
      ok: false,
      code: "no-budget",
      ...base,
      reason:
        `no trial budget is set for ${input.provider}, so the trial may not spend there: a budget is the balance read from the provider's console minus 30 days of the print's own spend, ` +
        "and it is recorded in data/lab/cr/budgets.json.",
    };
  }
  if (spentToday.plus(projected).greaterThan(cap)) {
    return {
      ok: false,
      code: "daily-cap",
      ...base,
      reason:
        `the trial has spent $${fmtUsd(spentToday)} today (UTC ${day}), counting calls in flight, of the $${cap.toFixed(2)} daily cap, and this call would add about ` +
        `$${fmtUsd(projected)}, which is more than is left. The cap is the trial's alone; the daily print is separate.`,
    };
  }
  const providerBudget = parseUsd(budget.budgetUsd, `${input.provider} budgetUsd`);
  if (providerSpent.plus(projected).greaterThan(providerBudget)) {
    return {
      ok: false,
      code: "provider-budget",
      ...base,
      reason:
        `the trial has spent $${fmtUsd(providerSpent)} on ${input.provider} since ${budget.since}, counting calls in flight, of its $${providerBudget.toFixed(2)} budget, and this call ` +
        `would add about $${fmtUsd(projected)}. The budget is what is left after reserving the print's own spend there; top the provider up and record the new balance to raise it.`,
    };
  }
  return {
    ok: true,
    ...base,
    remainingToday: fmtUsd(cap.minus(spentToday)),
    providerRemaining: fmtUsd(providerBudget.minus(providerSpent)),
  };
}
