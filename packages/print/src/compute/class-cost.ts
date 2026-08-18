import type { RunRecord } from "@touchstone/sdk";
import { D, callCost, mean, type DecimalValue } from "../decimal.js";

export interface ModelPrice {
  price_in_usd_per_1m: string;
  price_out_usd_per_1m: string;
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
        callCost(
          record.usage.input,
          record.usage.output,
          price.price_in_usd_per_1m,
          price.price_out_usd_per_1m,
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
