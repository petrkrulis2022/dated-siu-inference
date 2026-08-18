import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import { D } from "../money/index.js";

export interface SpendingMandate {
  max_usd_per_quote: string;
  accepted_index_versions?: string[];
  accepted_chains?: string[];
}

export type MandateReasonCode =
  | "unbounded_estimate"
  | "expired"
  | "over_budget"
  | "index_version_not_accepted"
  | "chain_not_accepted"
  | "malformed_quote";

export type MandateDecision =
  { accepted: true } | { accepted: false; reason: MandateReasonCode; detail: string };

/**
 * Normative per build1-spec.md §8: "A quote with pattern: estimate and no siu_max MUST be
 * rejected by a payer operating under a spending mandate — that rule is normative in the spec,
 * and it is what makes the extension safe to auto-accept." Without an upper bound, escrow
 * cannot hold a bounded amount and an agent's budget is exposed without limit — that bound is
 * precisely what makes the extension safe to auto-accept.
 *
 * Deliberately does NOT assume `quote` has already passed `validateQuote` or even
 * `validateTouchstoneQuote` — a payer may be handed a quote that skipped schema validation entirely
 * (a bug, a hostile seller, a malformed relay), and this rule is normatively about what the
 * *payer* does with whatever it's handed, not about what a well-formed quote looks like. The
 * unbounded check runs first and touches only `pattern`/`siu_max`, so it holds even when every
 * other field on `quote` is missing or malformed.
 */
export function checkSpendingMandate(
  quote: TouchstoneQuote,
  mandate: SpendingMandate,
  now: Date = new Date(),
): MandateDecision {
  if ((quote.pattern === "estimate" || quote.pattern === "cap") && !quote.siu_max) {
    return {
      accepted: false,
      reason: "unbounded_estimate",
      detail:
        `pattern "${quote.pattern}" has no siu_max — an unbounded quote MUST be rejected under ` +
        `a spending mandate (build1-spec.md §8)`,
    };
  }

  const expiryMs = Date.parse(quote.expiry);
  if (Number.isNaN(expiryMs) || expiryMs <= now.getTime()) {
    return {
      accepted: false,
      reason: "expired",
      detail: `quote expiry "${quote.expiry}" is not in the future relative to ${now.toISOString()}`,
    };
  }

  try {
    if (new D(quote.amount_usd_max).greaterThan(mandate.max_usd_per_quote)) {
      return {
        accepted: false,
        reason: "over_budget",
        detail: `amount_usd_max ${quote.amount_usd_max} exceeds mandate max_usd_per_quote ${mandate.max_usd_per_quote}`,
      };
    }
  } catch (err) {
    return {
      accepted: false,
      reason: "malformed_quote",
      detail: `could not compare amount_usd_max ("${quote.amount_usd_max}") against the mandate budget: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (
    mandate.accepted_index_versions &&
    !mandate.accepted_index_versions.includes(quote.index_version)
  ) {
    return {
      accepted: false,
      reason: "index_version_not_accepted",
      detail: `index_version "${quote.index_version}" is not in the mandate's accepted list`,
    };
  }

  const settlementChains = quote.settlement?.map((entry) => entry.chain) ?? [];
  if (
    mandate.accepted_chains &&
    settlementChains.some((chain) => !mandate.accepted_chains!.includes(chain))
  ) {
    return {
      accepted: false,
      reason: "chain_not_accepted",
      detail: `settlement chain(s) [${settlementChains.join(", ")}] include one not in the mandate's accepted list`,
    };
  }

  return { accepted: true };
}
