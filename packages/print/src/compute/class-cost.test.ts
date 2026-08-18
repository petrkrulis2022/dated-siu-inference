import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { computeClassCost, type ModelPrice } from "./class-cost.js";

const PRICE: ModelPrice = { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" };

function rec(
  instanceId: string,
  attempt: number,
  gatePassed: boolean,
  input = 1000,
  output = 1000,
): RunRecord {
  return {
    run_id: `${instanceId}-${attempt}`,
    model_id: "m",
    task_class: "T3",
    instance_id: instanceId,
    seed: 1,
    attempt,
    usage: { input, output, cached_input: 0, reasoning: 0 },
    latency_ms: 1,
    gate_passed: gatePassed,
    raw_response_ref: "r.json",
    deviations: [],
  };
}

// 1000 input @ $1/1M + 1000 output @ $2/1M = 0.001 + 0.002 = 0.003 per attempt.
const PER_ATTEMPT = "0.003";

describe("computeClassCost", () => {
  it("costs a single passing attempt", () => {
    const result = computeClassCost([rec("i0", 1, true)], PRICE);
    expect(result.cost?.toString()).toBe(PER_ATTEMPT);
    expect(result.passingInstances).toBe(1);
  });

  it("sums every attempt up to and including the first pass", () => {
    const result = computeClassCost(
      [rec("i0", 1, false), rec("i0", 2, false), rec("i0", 3, true)],
      PRICE,
    );
    expect(result.cost?.toString()).toBe("0.009");
  });

  it("ignores any attempt recorded AFTER the first pass", () => {
    // The orchestrator stops calling once an instance passes, so a post-pass record should
    // never occur in practice — but if one ever appears (a re-run, a duplicated file, hand-
    // edited data), counting it would silently inflate the published cost. §6.1 says "summing
    // all attempts to first pass", and this is the case that pins that word "to" down.
    const result = computeClassCost(
      [rec("i0", 1, true), rec("i0", 2, true), rec("i0", 3, true)],
      PRICE,
    );
    expect(result.cost?.toString()).toBe(PER_ATTEMPT);
  });

  it("orders attempts by attempt number, not by array position", () => {
    // Run records are read off disk in whatever order the filesystem yields, so the result
    // must not depend on it. Out-of-order here: the pass (attempt 1) is listed last.
    const shuffled = computeClassCost(
      [rec("i0", 3, false), rec("i0", 2, false), rec("i0", 1, true)],
      PRICE,
    );
    expect(shuffled.cost?.toString()).toBe(PER_ATTEMPT);
  });

  it("averages across passing instances only, excluding instances that never passed", () => {
    // i0 passes at cost 0.003; i1 never passes across 3 attempts. §6.1 averages "across
    // passing instances", so the mean is 0.003, not (0.003 + 0.009)/2.
    const result = computeClassCost(
      [rec("i0", 1, true), rec("i1", 1, false), rec("i1", 2, false), rec("i1", 3, false)],
      PRICE,
    );
    expect(result.cost?.toString()).toBe(PER_ATTEMPT);
    expect(result.passingInstances).toBe(1);
    expect(result.totalInstances).toBe(2);
  });

  it("returns the mean when instances cost different amounts", () => {
    // i0 passes first try (0.003), i1 passes on its second (0.006). Mean = 0.0045.
    const result = computeClassCost(
      [rec("i0", 1, true), rec("i1", 1, false), rec("i1", 2, true)],
      PRICE,
    );
    expect(result.cost?.toString()).toBe("0.0045");
  });

  it("is undefined when no instance passed, with a stated reason", () => {
    const result = computeClassCost([rec("i0", 1, false), rec("i0", 2, false)], PRICE);
    expect(result.cost).toBeUndefined();
    expect(result.undefinedReason).toMatch(/failed the quality gate/);
  });

  it("is undefined when there are no records at all", () => {
    const result = computeClassCost([], PRICE);
    expect(result.cost).toBeUndefined();
    expect(result.undefinedReason).toMatch(/no run records/);
  });

  it("reproduces the worked example's 1.6x retry multiplier from real attempt records", () => {
    // 2 of 5 instances pass first try, 3 pass on their second: mean attempts = 1.6.
    const records: RunRecord[] = [];
    for (let i = 0; i < 5; i++) {
      if (i < 2) {
        records.push(rec(`i${i}`, 1, true));
      } else {
        records.push(rec(`i${i}`, 1, false), rec(`i${i}`, 2, true));
      }
    }
    const result = computeClassCost(records, PRICE);
    expect(result.cost?.toString()).toBe("0.0048"); // 0.003 x 1.6
  });

  it("does not lose precision on prices that are not representable as floats", () => {
    // 0.1 + 0.2 !== 0.3 in float arithmetic; decimal must give exactly 0.0000003.
    const result = computeClassCost([rec("i0", 1, true, 1, 1)], {
      price_in_usd_per_1m: "0.1",
      price_out_usd_per_1m: "0.2",
    });
    expect(result.cost?.toFixed(9)).toBe("0.000000300");
  });

  it("never renders a value in exponential notation", () => {
    // The print schema's decimalString pattern is ^-?[0-9]+(\.[0-9]+)?$ — a value serialised
    // as "3e-7" would fail validation at publication time. The scoped Decimal is configured
    // with toExpNeg/toExpPos far outside any real range so this cannot happen silently.
    const result = computeClassCost([rec("i0", 1, true, 1, 1)], {
      price_in_usd_per_1m: "0.1",
      price_out_usd_per_1m: "0.2",
    });
    expect(result.cost?.toString()).toBe("0.0000003");
    expect(result.cost?.toString()).not.toMatch(/e/i);
  });
});
