import { Decimal } from "decimal.js";

/**
 * Real per-token pricing for the chat model, sourced from this repo's own price registry —
 * data/registry/price-snapshot-merged-2026-09-03T01-01-04.946Z.json, model_id "claude-haiku-4-5":
 * $1/1M input tokens, $5/1M output tokens. Not re-fetched at request time (a Worker has no
 * reason to read a git-tracked snapshot file over the network on every chat turn); update these
 * two constants, with a comment citing the new source snapshot, if the registry's own price for
 * this model changes. Used only for this Worker's own cost accounting against
 * CHAT_DAILY_CEILING_USD — never published as, or confused with, an exchange rate into SIU.
 */
const INPUT_USD_PER_TOKEN = new Decimal("1").div(1_000_000);
const OUTPUT_USD_PER_TOKEN = new Decimal("5").div(1_000_000);

/** Decimal-string cost of one Claude Messages API call, per CLAUDE.md's no-floats-in-money-maths
 * invariant — the two usage counts are integers off the wire, multiplied through Decimal only. */
export function callCostUsd(usage: { input_tokens: number; output_tokens: number }): string {
  const inputCost = INPUT_USD_PER_TOKEN.mul(usage.input_tokens);
  const outputCost = OUTPUT_USD_PER_TOKEN.mul(usage.output_tokens);
  return inputCost.add(outputCost).toString();
}

/** Conservative reservation held against the daily cap before a call's real usage is known —
 * above the ~$0.015-0.02 single-call estimate to cover a multi-turn tool-use loop (get_index)
 * within one visitor turn. Reconciled down to the real cost afterward via
 * ChatBudgetTracker#reconcile; never reconciled *up* past what was reserved, since the
 * reservation itself is what guarantees the daily cap is never exceeded even under concurrent
 * requests (see chat-budget-tracker.ts's doc comment on the atomicity this relies on). */
export const PER_TURN_RESERVATION_USD = "0.05";
