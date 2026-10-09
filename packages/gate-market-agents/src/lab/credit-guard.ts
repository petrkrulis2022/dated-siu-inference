/**
 * The lab and its probes must never take the Anthropic credit the daily print needs (D60). The print and the lab draw on the same credit: the Team plan's
 * monthly API credit and what was bought. No provider exposes a balance to an API key, so the balance cannot be read; the guard works from a ledger of
 * what the lab and its probes have spent in the current billing cycle, and refuses to start, and stops, when the next spend would take that past a cap.
 *
 * The cap is set so that what is left covers the print until the credit renews. The arithmetic is in `docs/marketplace_plan.md` D60; the figures change
 * with the balance, so the cap is a setting (`LAB_CYCLE_CAP_USD`), not a constant in the code. Money is decimal strings throughout (invariant 4).
 */
import { D } from "@touchstone/sdk";

/** One spend: when, how much (decimal USD), and on what. Only Anthropic spend by the lab or a probe is recorded: the print's own is not. */
export interface SpendEntry {
  at: string;
  usd: string;
  what: string;
}

/** The Team plan's credit renews on this day of the month, UTC (2026-10-18 is the next). */
export const RENEWAL_DAY_OF_MONTH = 18;
/** What the lab and its probes may spend, together, in one billing cycle, if nothing says otherwise. */
export const DEFAULT_CYCLE_CAP_USD = "30";

/** The start of the billing cycle `now` falls in: 00:00 UTC on the most recent renewal day. */
export function cycleStart(now: Date, renewalDay: number = RENEWAL_DAY_OF_MONTH): Date {
  const thisMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), renewalDay);
  if (now.getTime() >= thisMonth) return new Date(thisMonth);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, renewalDay));
}

/** The start of the next cycle: the credit renews, and what was spent no longer counts. */
export function cycleEnd(now: Date, renewalDay: number = RENEWAL_DAY_OF_MONTH): Date {
  const s = cycleStart(now, renewalDay);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, renewalDay));
}

/** What has been spent in the cycle `now` falls in: entries from its start up to the next renewal. */
export function spentThisCycle(entries: readonly SpendEntry[], now: Date, renewalDay: number = RENEWAL_DAY_OF_MONTH): string {
  const from = cycleStart(now, renewalDay).getTime();
  const to = cycleEnd(now, renewalDay).getTime();
  return entries
    .filter((e) => {
      const t = new Date(e.at).getTime();
      return t >= from && t < to;
    })
    .reduce((sum, e) => sum.plus(e.usd), new D(0))
    .toFixed(6);
}

export type CreditCheck = { ok: true; spent: string; remainingUnderCap: string } | { ok: false; reason: string; spent: string };

/**
 * May `projectedUsd` more be spent? Refused if it would take the cycle's spend past `capUsd`. The reason says what was spent, what was asked for and the
 * cap, so a refusal can be read without the ledger.
 */
export function checkCreditGuard(input: {
  entries: readonly SpendEntry[];
  now: Date;
  projectedUsd: string;
  capUsd?: string;
  renewalDay?: number;
}): CreditCheck {
  const cap = new D(input.capUsd ?? DEFAULT_CYCLE_CAP_USD);
  const spent = spentThisCycle(input.entries, input.now, input.renewalDay);
  const after = new D(spent).plus(input.projectedUsd);
  if (after.greaterThan(cap)) {
    return {
      ok: false,
      spent,
      reason:
        `the lab and its probes have spent $${spent} of the $${cap.toFixed(2)} cap in this billing cycle (since ${cycleStart(input.now, input.renewalDay).toISOString().slice(0, 10)}), ` +
        `and this would add about $${new D(input.projectedUsd).toFixed(2)}, which is more than is left under the cap. The cap keeps the Anthropic credit the daily print needs until it renews; ` +
        "raise LAB_CYCLE_CAP_USD only after checking the Console balance.",
    };
  }
  return { ok: true, spent, remainingUnderCap: cap.minus(after).toFixed(6) };
}

/** Appends one spend to a ledger, in date order is not required: the cycle sum does not depend on it. Returns a new list. */
export function withSpend(entries: readonly SpendEntry[], entry: SpendEntry): SpendEntry[] {
  if (new D(entry.usd).lessThan(0)) throw new Error(`a spend cannot be negative: ${entry.usd}`);
  return [...entries, entry];
}
