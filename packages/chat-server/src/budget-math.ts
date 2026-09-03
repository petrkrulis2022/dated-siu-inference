import { Decimal } from "decimal.js";

/**
 * The pure decision logic behind ChatBudgetTracker, pulled out of the Durable Object so it's
 * unit-testable in plain vitest with no Workers runtime — matching this repo's own precedent
 * (mcp-server's TouchstoneMcpAgent DO has no unit test either; DO storage/concurrency mechanics
 * are verified live, via a real deployment, not simulated). Only the money math lives here.
 */

export interface BudgetState {
  date: string; // UTC YYYY-MM-DD the stored total applies to
  spentUsd: string; // decimal string — no floats in money maths, per CLAUDE.md
}

export function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** spentSoFar for `today`, treating a stored total from a prior date as a fresh $0 day. */
function spentSoFarFor(stored: BudgetState | undefined, today: string): Decimal {
  return stored?.date === today ? new Decimal(stored.spentUsd) : new Decimal(0);
}

export function decideReservation(
  stored: BudgetState | undefined,
  today: string,
  estimatedCostUsd: string,
  ceilingUsd: string,
): { allowed: boolean; spentTodayUsd: string; nextState: BudgetState | undefined } {
  const spentSoFar = spentSoFarFor(stored, today);
  const afterThisCall = spentSoFar.add(estimatedCostUsd);

  if (afterThisCall.greaterThan(ceilingUsd)) {
    return { allowed: false, spentTodayUsd: spentSoFar.toString(), nextState: stored };
  }
  return {
    allowed: true,
    spentTodayUsd: afterThisCall.toString(),
    nextState: { date: today, spentUsd: afterThisCall.toString() },
  };
}

/** Corrects a prior reservation down (or up) to a call's real cost. Returns `undefined` for
 * `nextState` when the day has rolled over since the reservation — that money was already
 * implicitly dropped when the new day started at $0, and back-dating it would misattribute
 * spend to the wrong day for no benefit; the caller should simply not write anything back. */
export function decideReconciliation(
  stored: BudgetState | undefined,
  today: string,
  estimatedCostUsd: string,
  actualCostUsd: string,
): { nextState: BudgetState | undefined } {
  if (!stored || stored.date !== today) return { nextState: undefined };

  const corrected = new Decimal(stored.spentUsd).sub(estimatedCostUsd).add(actualCostUsd);
  return {
    // Never let a reconcile push the stored total negative — floor at zero.
    nextState: { date: today, spentUsd: Decimal.max(corrected, 0).toString() },
  };
}
