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
export function computeClassCost(records: RunRecord[], price: ModelPrice): ClassCost {
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
        callCost(
          record.usage.input,
          record.usage.output + record.usage.reasoning,
          price.price_in_usd_per_1m,
          price.price_out_usd_per_1m,
          record.usage.cached_input,
          price.price_cached_in_usd_per_1m,
        ),
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
