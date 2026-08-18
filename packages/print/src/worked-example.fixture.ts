import type { RunRecord } from "@touchstone/sdk";
import type { ModelInput, PrintInput } from "./compute/index.js";
import type { TaskClass } from "./compute/basket-cost.js";
import { cachePolicyVariant } from "./compute/sensitivity.js";

/**
 * The worked example from docs/siu-worked-example.md, expressed as real run records so the
 * reproduction test exercises the actual §6 pipeline end to end rather than a shortcut that
 * feeds in pre-computed class costs.
 *
 * All figures are illustrative. They do not describe real models or real prices.
 */

const USAGE: Record<string, Record<TaskClass, [number, number]>> = {
  A: { T1: [1000, 700], T2: [50000, 1400], T3: [2000, 6000] },
  B: { T1: [1000, 320], T2: [50000, 850], T3: [2000, 2200] },
  C: { T1: [1050, 380], T2: [52500, 900], T3: [2100, 2600] },
  D: { T1: [1100, 450], T2: [55000, 1100], T3: [2200, 3000] },
};

const PRICES: Record<string, { price_in_usd_per_1m: string; price_out_usd_per_1m: string }> = {
  A: { price_in_usd_per_1m: "3.00", price_out_usd_per_1m: "15.00" },
  B: { price_in_usd_per_1m: "2.50", price_out_usd_per_1m: "10.00" },
  C: { price_in_usd_per_1m: "0.60", price_out_usd_per_1m: "2.40" },
  // D is served by three hosts (0.30/0.60, 0.20/0.45, 0.45/0.90); the example uses host 2.
  D: { price_in_usd_per_1m: "0.20", price_out_usd_per_1m: "0.45" },
};

const INSTANCES_PER_CLASS = 5;

function record(
  modelId: string,
  taskClass: TaskClass,
  instanceIndex: number,
  attempt: number,
  gatePassed: boolean,
): RunRecord {
  const [input, output] = USAGE[modelId][taskClass];
  return {
    run_id: `${modelId}-${taskClass}-${instanceIndex}-${attempt}`,
    model_id: modelId,
    task_class: taskClass,
    instance_id: `${taskClass}-${String(instanceIndex).padStart(2, "0")}`,
    seed: 1,
    attempt,
    usage: { input, output, cached_input: 0, reasoning: 0 },
    latency_ms: 100,
    gate_passed: gatePassed,
    raw_response_ref: `${modelId}-${taskClass}-${instanceIndex}-${attempt}.raw.json`,
    deviations: [],
  };
}

/** Every instance passes on its first attempt. */
function cleanPassRecords(modelId: string, taskClass: TaskClass): RunRecord[] {
  return Array.from({ length: INSTANCES_PER_CLASS }, (_, i) =>
    record(modelId, taskClass, i, 1, true),
  );
}

/**
 * C's T3: "pass-on-retry → T3 cost × 1.6 attempts". Two of five instances pass first try and
 * three pass on their second, so the mean attempts-to-first-pass is (2×1 + 3×2)/5 = 1.6 —
 * which is exactly the 1.6× multiplier the worked example states, arrived at through the real
 * "sum all attempts to first pass, average across passing instances" rule rather than by
 * hardcoding a multiplier.
 */
function retryRecords(modelId: string, taskClass: TaskClass): RunRecord[] {
  const records: RunRecord[] = [];
  for (let i = 0; i < INSTANCES_PER_CLASS; i++) {
    if (i < 2) {
      records.push(record(modelId, taskClass, i, 1, true));
    } else {
      records.push(record(modelId, taskClass, i, 1, false));
      records.push(record(modelId, taskClass, i, 2, true));
    }
  }
  return records;
}

/** D's T3 fails outright: three attempts per instance, none passing. */
function allFailRecords(modelId: string, taskClass: TaskClass): RunRecord[] {
  const records: RunRecord[] = [];
  for (let i = 0; i < INSTANCES_PER_CLASS; i++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      records.push(record(modelId, taskClass, i, attempt, false));
    }
  }
  return records;
}

export function workedExampleModels(): ModelInput[] {
  return [
    {
      model_id: "A",
      price: PRICES.A,
      records: [
        ...cleanPassRecords("A", "T1"),
        ...cleanPassRecords("A", "T2"),
        ...cleanPassRecords("A", "T3"),
      ],
    },
    {
      model_id: "B",
      price: PRICES.B,
      records: [
        ...cleanPassRecords("B", "T1"),
        ...cleanPassRecords("B", "T2"),
        ...cleanPassRecords("B", "T3"),
      ],
    },
    {
      model_id: "C",
      price: PRICES.C,
      records: [
        ...cleanPassRecords("C", "T1"),
        ...cleanPassRecords("C", "T2"),
        ...retryRecords("C", "T3"),
      ],
    },
    {
      model_id: "D",
      price: PRICES.D,
      records: [
        ...cleanPassRecords("D", "T1"),
        ...cleanPassRecords("D", "T2"),
        ...allFailRecords("D", "T3"),
      ],
    },
  ];
}

export const WORKED_EXAMPLE_SHARES = new Map([
  ["A", "0.20"],
  ["B", "0.35"],
  ["C", "0.45"],
]);

export function workedExampleInput(): PrintInput {
  return {
    version: "SIU-2026a",
    print_id: "worked-example",
    date: "2026-08-14",
    status: "provisional",
    classWeights: { T1: "0.50", T2: "0.30", T3: "0.20" },
    models: workedExampleModels(),
    observedShares: WORKED_EXAMPLE_SHARES,
    price_snapshot_ref: "worked-example-illustrative",
    methodology_version: "worked-example",
  };
}

/**
 * The same input plus the worked example's cache-policy variant. A print is only publishable
 * with a non-empty sensitivity block (§6.7), so this is the shape used wherever a fixture
 * needs to be signed.
 */
export function publishableWorkedExampleInput(): PrintInput {
  return {
    ...workedExampleInput(),
    sensitivityVariants: [
      cachePolicyVariant({
        cachedFraction: "0.40",
        cachedPriceRatio: "0.10",
        appliesTo: ["B"],
        taskClasses: ["T2"],
      }),
    ],
  };
}
