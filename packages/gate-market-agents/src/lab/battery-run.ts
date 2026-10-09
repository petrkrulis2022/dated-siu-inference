/**
 * The battery's plan and its stop rules, apart from any I/O (docs/marketplace_plan.md §14.4 and §14.8): which calls make up a stage and in what
 * order, what each arm sends, what a call costs, and when the runner must stop and report. The runner (`cli/lab-probe-battery.ts`) only does
 * the calling and the saving.
 */
import { deriveSeed, mulberry32 } from "@touchstone/basket";
import type { AdapterParams, AdapterSent, AdapterUsage } from "@touchstone/harness";
import { ARMS, CELL_IDS, type Arm, type CellId } from "./probe-battery.js";
import type { ParsedReply } from "./probe-battery.js";
import { decimalToUnits, unitsToDecimal } from "./money.js";

export const BATTERY_MODELS = ["claude-haiku-4-5", "claude-sonnet-5"] as const;
export type BatteryModel = (typeof BATTERY_MODELS)[number];

/** Samples per cell per arm per model (§14.7). */
export const SAMPLES_PER_CELL = 12;
/** Haiku's manual thinking budget in arm C (§14.3). */
export const HAIKU_THINKING_BUDGET = 2_048;
/** The lab's own output allowance for a turn (`roster.ts`): arm B's longer reply and the thinking both fit inside it. */
export const BATTERY_MAX_TOKENS = 4_500;
/** Caps, in USD, decimal strings (§14.4). */
export const CAPS = { pilot: "0.30", stage1: "13", stage2: "4", replication: "3" } as const;
/** An arm that fails to parse more than this share of at least `PARSE_CHECK_FROM` replies stops the run (§14.8). */
export const PARSE_FAILURE_LIMIT = 0.2;
export const PARSE_CHECK_FROM = 20;

export interface CallSpec {
  /** Unique within a run: label, cell, arm, model, sample. A resumed run skips the keys it already has. */
  key: string;
  label: string;
  cell: CellId;
  arm: Arm;
  model: BatteryModel;
  sample: number;
}

export interface PlanInput {
  label: string;
  cells: readonly CellId[];
  models: readonly BatteryModel[];
  /** The arms each model is asked under. */
  arms: (model: BatteryModel) => readonly Arm[];
  samples: number;
}

const keyOf = (label: string, cell: CellId, arm: Arm, model: BatteryModel, sample: number): string => `${label}|${cell}|${arm}|${model}|${sample}`;

/**
 * Every call of a batch, in a seeded random order, so no arm, cell or model runs in a block (§14.7: "arms interleaved in a seeded random
 * order"). The order is a function of the label alone, so a resumed run continues the same order.
 */
export function planCalls(input: PlanInput): CallSpec[] {
  const calls: CallSpec[] = [];
  for (const cell of input.cells) {
    for (const model of input.models) {
      for (const arm of input.arms(model)) {
        for (let sample = 1; sample <= input.samples; sample++) calls.push({ key: keyOf(input.label, cell, arm, model, sample), label: input.label, cell, arm, model, sample });
      }
    }
  }
  const rng = mulberry32(deriveSeed(0x5107, `battery:${input.label}`));
  for (let i = calls.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [calls[i], calls[j]] = [calls[j], calls[i]];
  }
  return calls;
}

/** Stage 1: arms A and B for both models, and arm C for sonnet, all thirteen cells (§14.4). 780 calls. */
export const stage1Plan = (label: string): CallSpec[] =>
  planCalls({ label, cells: CELL_IDS, models: BATTERY_MODELS, arms: (m) => (m === "claude-sonnet-5" ? ARMS : ["A", "B"]), samples: SAMPLES_PER_CELL });

/** Stage 2, after the credit renews: arm C for haiku. 156 calls. */
export const stage2Plan = (label: string): CallSpec[] => planCalls({ label, cells: CELL_IDS, models: ["claude-haiku-4-5"], arms: () => ["C"], samples: SAMPLES_PER_CELL });

/** The pilot: one call per arm per model, on P0, haiku's arm C included so the request that is new to this build is tried once. 6 calls. */
export const pilotPlan = (label: string): CallSpec[] => planCalls({ label, cells: ["P0"], models: BATTERY_MODELS, arms: () => ARMS, samples: 1 });

/** A replication batch (§14.7): a fresh batch of 12 for the named cells, arms and models, under its own label. */
export const replicationPlan = (label: string, cells: readonly CellId[], models: readonly BatteryModel[], arms: readonly Arm[]): CallSpec[] =>
  planCalls({ label, cells, models, arms: () => arms, samples: SAMPLES_PER_CELL });

/** What a call asks of the adapter: never a temperature (§14.2), the lab's own token allowance, and the arm's thinking if it has any. */
export function paramsFor(model: BatteryModel, arm: Arm): AdapterParams {
  const base: AdapterParams = { temperature: 0, omit_temperature: true, max_tokens: BATTERY_MAX_TOKENS };
  if (arm !== "C") return base;
  return { ...base, thinking: model === "claude-sonnet-5" ? { mode: "summarized" } : { mode: "manual", budget_tokens: HAIKU_THINKING_BUDGET } };
}

/** The cost of one call in decimal USD, from integer token counts and the decimal per-million prices, with no floats (CLAUDE.md invariant 4). */
export function callCostUsd(usage: Pick<AdapterUsage, "input" | "output">, priceInUsdPer1M: string, priceOutUsdPer1M: string): string {
  // price per million tokens in USD × 1,000 = nano-USD per token.
  const nano = BigInt(usage.input) * decimalToUnits(priceInUsdPer1M, 3) + BigInt(usage.output) * decimalToUnits(priceOutUsdPer1M, 3);
  return unitsToDecimal(nano, 9);
}

export const addUsd = (a: string, b: string): string => unitsToDecimal(decimalToUnits(a, 9) + decimalToUnits(b, 9), 9);

/** One finished call, as saved: everything needed to read it again without the model, and nothing coded (the analysis codes it with the frozen rules). */
export interface BatteryCall extends CallSpec {
  at: string;
  promptSha256: string;
  latencyMs: number;
  reply: string;
  parsed: ParsedReply;
  /** The thinking the provider returned with the reply (arm C), cut at the loop's cap. */
  thinking?: string;
  usage: AdapterUsage;
  usd: string;
  sent?: AdapterSent;
  stopReason?: string;
  deviations: string[];
  /** The sentence of an error that ended the call without a reply. */
  error?: string;
}

export interface StopDecision {
  stop: boolean;
  reason?: string;
}

/**
 * When the runner stops launching calls and reports (§14.8): the cap is reached, an arm fails to parse more than a fifth of its replies (judged on
 * at least twenty), a model refuses, or a call ends in an error that is not a reply.
 */
export function evaluateStop(calls: readonly BatteryCall[], capUsd: string): StopDecision {
  const spent = calls.reduce((s, c) => addUsd(s, c.usd), "0");
  if (decimalToUnits(spent, 9) >= decimalToUnits(capUsd, 9)) return { stop: true, reason: `cap reached: $${spent} spent of $${capUsd}` };
  const failed = calls.find((c) => c.error !== undefined);
  if (failed !== undefined) return { stop: true, reason: `a call ended in an error (${failed.model}, arm ${failed.arm}, ${failed.cell}): ${failed.error}` };
  const refused = calls.find((c) => c.stopReason === "refusal");
  if (refused !== undefined) return { stop: true, reason: `${refused.model} refused (arm ${refused.arm}, ${refused.cell})` };
  for (const model of BATTERY_MODELS) {
    for (const arm of ARMS) {
      const mine = calls.filter((c) => c.model === model && c.arm === arm);
      if (mine.length < PARSE_CHECK_FROM) continue;
      const bad = mine.filter((c) => c.parsed.outcome === "unparsed").length;
      if (bad / mine.length > PARSE_FAILURE_LIMIT) return { stop: true, reason: `${model} arm ${arm} failed to parse ${bad} of ${mine.length} replies` };
    }
  }
  return { stop: false };
}
