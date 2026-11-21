import type { RunRecord } from "@touchstone/sdk";
import { D, callCost, mean, type DecimalValue } from "../decimal.js";

export interface ModelPrice {
  price_in_usd_per_1m: string;
  price_out_usd_per_1m: string;
  /** Rate for cached/reused prompt tokens (RunRecord.usage.cached_input), when the price
   * snapshot's source publishes one separately. Absent — not "0" — for a model with no
   * separately-published cache rate: cached_input then goes unpriced for it, a known, disclosed
   * gap rather than a guessed rate. Distinct from sensitivity.ts's cachePolicyVariant, which
   * models a hypothetical alternative cache-adoption policy as a delta off the headline number —
   * this field prices cache use that actually happened, in the headline number itself. */
  price_cached_in_usd_per_1m?: string;
}

/**
 * How one call is priced (docs/methodology.md, rules-2026-11-20).
 *
 * The price of a call is what its provider billed for it, read from the call's own response (RunRecord.billed_usd: OpenRouter's usage.cost, xAI's
 * cost_in_usd_ticks). A list price is the fallback for a provider whose response reports no billed figure (Anthropic, OpenAI, Google: their
 * invoices reconcile them, methodology §7), and otherwise only a cross-check. A list price is always the one for the service tier the response says
 * served the call: OpenRouter lists one endpoint per tier, and calls pinned to one endpoint have been served on its priority tier.
 */
export interface CallPricing {
  /** The list price of the constituent's declared endpoint (its standard tier). */
  price: ModelPrice;
  /** List prices of the other tiers listed under that endpoint, keyed by the name a response reports (e.g. "priority"). */
  tierPrices?: Record<string, ModelPrice>;
  /** rules-2026-11-20: price a call at its billed figure where the response reports one. Off for every print computed under an earlier rule. */
  billed?: boolean;
  /** A sensitivity variant's multipliers, applied to the list price; a billed call is scaled by the same ratio so the variant moves from the
   * billed level, through the same per-call arithmetic as the headline. */
  adjustment?: { inputMultiplier: string; outputMultiplier: string };
  /** rules-2026-11-21: the constituent's provider counts cached prompt tokens inside usage.input (cachedTokensInsideInput), so a cached token is
   * priced once, at the cached rate, and only the rest of the prompt at the input rate. Absent or false: cached tokens are added on top of
   * usage.input, which is right for Anthropic and is the formula every print before that revision used for every provider. */
  cachedInsideInput?: boolean;
}

/**
 * Whether a provider's usage counts cached prompt tokens inside usage.input (rules-2026-11-21). Anthropic reports cache reads apart from
 * input_tokens, which exclude them (adapters/anthropic.ts). Every other adapter records the whole prompt as usage.input: OpenAI-shaped responses
 * (OpenAI, OpenRouter, xAI and the other OpenAI-compatible hosts) count prompt_tokens_details.cached_tokens inside prompt_tokens, and Google counts
 * cachedContentTokenCount inside promptTokenCount (its totalTokenCount is prompt + candidates + thoughts, with no separate cached term).
 */
export function cachedTokensInsideInput(provider: string): boolean {
  return provider !== "anthropic";
}

/** Tier names a response uses for the standard tier: OpenRouter and OpenAI say "default", Anthropic and Google "standard"; Parasail names none. */
const STANDARD_TIERS = new Set(["default", "standard"]);

/** The list price of the tier a call's response reports. A tier with no listed price falls back to the declared endpoint's price; the price check
 * flags it. */
export function listPriceAt(pricing: Pick<CallPricing, "price" | "tierPrices">, serviceTier: string | null | undefined): ModelPrice {
  if (serviceTier === undefined || serviceTier === null || STANDARD_TIERS.has(serviceTier)) return pricing.price;
  return pricing.tierPrices?.[serviceTier] ?? pricing.price;
}

function listCost(record: RunRecord, price: ModelPrice, cachedInsideInput = false): DecimalValue {
  // usage.output + usage.reasoning, and cached_input at its own rate when one is published: see computeClassCost's comment for both histories.
  const cached = record.usage.cached_input;
  if (cachedInsideInput && cached > 0 && price.price_cached_in_usd_per_1m != null) {
    // rules-2026-11-21: the cached tokens are part of usage.input, so they are taken out of it and priced once, at the cached rate.
    if (cached > record.usage.input) {
      throw new Error(
        `${record.run_id}: cached_input ${cached} exceeds usage.input ${record.usage.input}, of which it is supposed to be part (rules-2026-11-21).`,
      );
    }
    return callCost(
      record.usage.input - cached,
      record.usage.output + record.usage.reasoning,
      price.price_in_usd_per_1m,
      price.price_out_usd_per_1m,
      cached,
      price.price_cached_in_usd_per_1m,
    );
  }
  return callCost(
    record.usage.input,
    record.usage.output + record.usage.reasoning,
    price.price_in_usd_per_1m,
    price.price_out_usd_per_1m,
    record.usage.cached_input,
    price.price_cached_in_usd_per_1m,
  );
}

function adjusted(price: ModelPrice, adjustment: CallPricing["adjustment"]): ModelPrice {
  if (!adjustment) return price;
  return {
    ...price,
    price_in_usd_per_1m: new D(price.price_in_usd_per_1m).times(adjustment.inputMultiplier).toString(),
    price_out_usd_per_1m: new D(price.price_out_usd_per_1m).times(adjustment.outputMultiplier).toString(),
  };
}

/** The cost of one call under `pricing` — the one place a call is priced. */
export function callCostOf(record: RunRecord, pricing: CallPricing): DecimalValue {
  const list = listPriceAt(pricing, record.service_tier);
  if (pricing.billed && record.billed_usd !== undefined) {
    const billed = new D(record.billed_usd);
    if (!pricing.adjustment) return billed;
    const base = listCost(record, list, pricing.cachedInsideInput);
    return base.isZero()
      ? billed
      : billed.times(listCost(record, adjusted(list, pricing.adjustment), pricing.cachedInsideInput)).dividedBy(base);
  }
  return listCost(record, adjusted(list, pricing.adjustment), pricing.cachedInsideInput);
}

export interface ClassCost {
  /** Undefined when the class failed — build1-spec.md §6.1: "If the class failed, the value is undefined." */
  cost?: DecimalValue;
  passingInstances: number;
  totalInstances: number;
  undefinedReason?: string;
}

/**
 * Cost of one task class for one model — build1-spec.md §6.1.
 *
 * For each instance: sum every attempt up to and including the first pass, then average
 * across passing instances only. An instance that never passed contributes nothing to the
 * average (its tokens were spent, but §6.1 averages "across passing instances"); if NO
 * instance passed, the class is undefined and the model drops out of the reference set.
 *
 * Records are grouped by instance and ordered by attempt number rather than by array
 * position, so the result does not depend on the order files happened to be read off disk.
 */
export function computeClassCost(records: RunRecord[], priceOrPricing: ModelPrice | CallPricing): ClassCost {
  const pricing: CallPricing = "price_in_usd_per_1m" in priceOrPricing ? { price: priceOrPricing } : priceOrPricing;
  const byInstance = new Map<string, RunRecord[]>();
  for (const record of records) {
    const list = byInstance.get(record.instance_id) ?? [];
    list.push(record);
    byInstance.set(record.instance_id, list);
  }

  const perInstanceCosts: DecimalValue[] = [];
  let totalInstances = 0;

  for (const [, instanceRecords] of byInstance) {
    totalInstances++;
    const ordered = [...instanceRecords].sort((a, b) => a.attempt - b.attempt);

    let running = new D(0);
    let passed = false;
    for (const record of ordered) {
      running = running.plus(
        // usage.output + usage.reasoning, not usage.output alone: reasoning/thinking tokens are
        // billed by the provider at the output rate — confirmed live and empirically, 2026-09-08
        // (Google's own pricing page states this plainly: "Output price (including thinking
        // tokens)"; xAI's real per-call cost_in_usd_ticks matched output+reasoning at the output
        // rate exactly, not output alone, an 8x difference in that one call). Excluding reasoning
        // here isn't a methodology choice, it's a gap against this project's own definition — the
        // index measures realised cost from executed runs, and the run record already carries
        // this field (RunRecord.usage.reasoning), captured but previously never priced.
        //
        // record.usage.cached_input, same category of gap, found 2026-09-13: every adapter
        // captures it (RunRecord.usage.cached_input is required by schema) but until now no price
        // snapshot published a cached rate and no cost formula priced it, so real, billed
        // cache-hit tokens were silently free in every published number. Priced only when the
        // model's own price snapshot entry carries price_cached_in_usd_per_1m (sourced from
        // LiteLLM's real cache_read_input_token_cost, e.g. gemini-3.1-pro-preview's real,
        // published $0.20/1M — confirmed against ai.google.dev/gemini-api/docs/pricing directly,
        // matches exactly); absent for a model with no published cache rate, cached_input stays
        // unpriced for it rather than guessed. Distinct from sensitivity.ts's cachePolicyVariant,
        // which prices a hypothetical alternative cache-adoption policy as a delta off the
        // headline — this prices cache use that actually happened, in the headline itself.
        //
        // rules-2026-11-20: from then on a call is priced at what it was billed, where its response says (callCostOf).
        //
        // rules-2026-11-21: the formula above added cached_input on top of usage.input for every provider, which counted each cached token twice
        // for every provider but Anthropic: their usage.input already includes the cached tokens (cachedTokensInsideInput). From then on a cached
        // token is priced once, at the cached rate (CallPricing.cachedInsideInput).
        callCostOf(record, pricing),
      );
      if (record.gate_passed) {
        passed = true;
        break; // "summing all attempts to first pass" — nothing after the first pass counts.
      }
    }

    if (passed) {
      perInstanceCosts.push(running);
    }
  }

  if (perInstanceCosts.length === 0) {
    return {
      passingInstances: 0,
      totalInstances,
      undefinedReason:
        totalInstances === 0
          ? "no run records for this class"
          : `all ${totalInstances} instance(s) failed the quality gate`,
    };
  }

  return {
    cost: mean(perInstanceCosts),
    passingInstances: perInstanceCosts.length,
    totalInstances,
  };
}
