/**
 * The output allowance of each task, and what an answer cost under two ways of handling it (D113, your decision: C, with B as the headline).
 *
 * THE PROBLEM. A model that thinks (claude-sonnet-5) spends nearly all of its output on reasoning: on CR-PL it used 3k to 20k tokens against the print's allowance of 4,000, and on CR-VS 8k to
 * 26k against 8,000. The print's method (A) cuts the call off at the allowance, bills it, and retries with a larger budget (`REASONING_BUDGET_MULTIPLE`), so 17 of Sonnet's 18 CR-VS and
 * CR-PL answers carried a wasted first call, about 30 to 50% on top of their useful cost. A customer who sets no such cap would not pay it.
 *
 * THE RULE (B, the headline), fixed in advance and the same for every model: each task's allowance covers almost all observed outputs. Concretely, over every recorded answer, take the
 * most one call needed (a call that was cut off again counts as at least its cap), multiply by 6/5, round up to a multiple of 2,000, and never go below the print's own allowance. The result
 * is frozen in `data/lab/cr/allowances.json` for the counted windows and changes only by a dated revision, never mid-series.
 *
 * BOTH FIGURES FROM ONE RUN. An answer is run once, under the headline allowance. What the print's method (A) would have cost, and whether it would have failed, follows from that answer's
 * own token counts (`printMethodCost`), so no answer is run twice. For answers already run under the print's allowance (the calibration days of 17 to 19 October) the headline figure is derived
 * the other way round (`headlineCost`), by taking the wasted first call off. Where that is not possible (a retry that was itself cut off, so the true need is unknown) the answer is marked
 * not derivable and left out of the derived columns, never guessed. Every figure is exact decimal arithmetic; the only integers rounded are token counts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REASONING_BUDGET_MULTIPLE } from "@touchstone/harness";
import { D, type DecimalValue } from "@touchstone/sdk";
import { CR_PUBLIC_DIR } from "../paths.js";
import type { TaskId } from "../tasks/instances.js";
import { usageCostUsd, type ModelPrice } from "./prices.js";
import type { AnswerRecord } from "./records.js";

/** The print's own allowances (method A): what a snapshot-mode call was held to until D113. */
export const PRINT_ALLOWANCE: Readonly<Record<TaskId, number>> = {
  "CR-VS": 8000,
  "CR-PL": 4000,
  "CR-UO": 4000,
  "CR-SM": 4000,
};
export const ROUND_TO = 2000;
const TASK_IDS = Object.keys(PRINT_ALLOWANCE) as TaskId[];
const RETRIED = "retried with reasoning accommodated";

/** What one answer needed in a single call, in output tokens (reasoning included). */
export interface Observation {
  task: TaskId;
  need: number;
  /** the call was cut off, so `need` is only a lower bound */
  censored: boolean;
}

/** One answer's observation, or undefined for an answer with no model call to learn from (an MCP session, or a call that failed before producing anything). */
export function observationOf(r: AnswerRecord): Observation | undefined {
  if (r.part === "mcp" || r.tokens.output === 0) return undefined;
  const used = r.allowance_tokens ?? PRINT_ALLOWANCE[r.task];
  // a retried answer's output is the cut-off first call (exactly the allowance) plus the second call: the second call alone is the need
  const retried = r.deviations.some((d) => d.includes(RETRIED));
  return {
    task: r.task,
    need: retried ? r.tokens.output - used : r.tokens.output,
    censored: r.stop_reason === "max_tokens",
  };
}

/** The rule: 6/5 of the largest need seen, rounded up to a multiple of 2,000, never below the print's allowance. A task with no observation keeps the print's allowance. */
export function deriveAllowances(obs: readonly Observation[]): Record<TaskId, number> {
  const out = { ...PRINT_ALLOWANCE } as Record<TaskId, number>;
  for (const t of TASK_IDS) {
    const most = Math.max(0, ...obs.filter((o) => o.task === t).map((o) => o.need));
    const wanted = Math.ceil((most * 6) / 5 / ROUND_TO) * ROUND_TO;
    out[t] = Math.max(PRINT_ALLOWANCE[t], wanted);
  }
  return out;
}

export interface AllowanceFile {
  rule: string;
  frozenAt: string;
  observed: Record<string, { n: number; maxNeed: number; censored: number }>;
  allowance: Record<TaskId, number>;
}

export const ALLOWANCES_PATH = join(CR_PUBLIC_DIR, "allowances.json");

/** The frozen allowances, read once. The file must give every task a whole multiple of 2,000 that is not below the print's own. */
const cache = new Map<string, Record<TaskId, number>>();
export function loadAllowances(path: string = ALLOWANCES_PATH): Record<TaskId, number> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const f = JSON.parse(readFileSync(path, "utf-8")) as AllowanceFile;
  const out = {} as Record<TaskId, number>;
  for (const t of TASK_IDS) {
    const v = f.allowance[t];
    if (!Number.isInteger(v) || v < PRINT_ALLOWANCE[t] || v % ROUND_TO !== 0)
      throw new Error(
        `allowances.json: ${t} must be a multiple of ${ROUND_TO} of at least ${PRINT_ALLOWANCE[t]}, got ${String(v)}`,
      );
    out[t] = v;
  }
  cache.set(path, out);
  return out;
}

export interface BasisCost {
  usd: DecimalValue;
  passed: boolean;
  /** false when the figure cannot be derived honestly: the answer is left out of the derived columns */
  derivable: boolean;
}

const used = (r: AnswerRecord): number => r.allowance_tokens ?? PRINT_ALLOWANCE[r.task];
const underPrintAllowance = (r: AnswerRecord): boolean => used(r) <= PRINT_ALLOWANCE[r.task];
const callCost = (
  r: AnswerRecord,
  price: ModelPrice,
  input: number,
  output: number,
): DecimalValue =>
  usageCostUsd({ input, output, cached_input: 0, reasoning: 0 }, price, r.provider);

/** The headline cost (B): what the answer cost with no wasted cut-off call. */
export function headlineCost(r: AnswerRecord, price: ModelPrice): BasisCost {
  const billed = new D(r.usd);
  const retried = r.deviations.some((d) => d.includes(RETRIED));
  if (!underPrintAllowance(r) || !retried)
    return { usd: billed, passed: r.passed, derivable: true };
  // run under the print's allowance and retried, but the retry was itself cut off: the true need is unknown
  if (r.stop_reason === "max_tokens") return { usd: billed, passed: r.passed, derivable: false };
  // take the cut-off first call off: the prompt once, and the whole allowance as output
  const waste = callCost(r, price, r.tokens.input / 2, used(r));
  return { usd: billed.minus(waste), passed: r.passed, derivable: true };
}

/** The print's method (A): what the answer would have cost, and whether it would have passed, with the print's allowance and its retry. */
export function printMethodCost(r: AnswerRecord, price: ModelPrice): BasisCost {
  const billed = new D(r.usd);
  if (underPrintAllowance(r)) return { usd: billed, passed: r.passed, derivable: true };
  const a = PRINT_ALLOWANCE[r.task];
  const out = r.tokens.output;
  if (out <= a) return { usd: billed, passed: r.passed, derivable: true };
  const firstCall = callCost(r, price, r.tokens.input, a);
  // a plain cut-off with no reasoning reported is not retried by the adapters: it fails after one call
  if (r.tokens.reasoning <= 0) return { usd: firstCall, passed: false, derivable: true };
  const second = a * (1 + REASONING_BUDGET_MULTIPLE);
  // retried within the larger budget: the run's own cost (the second call) plus the wasted first call
  if (out <= second) return { usd: billed.plus(firstCall), passed: r.passed, derivable: true };
  // cut off again: two calls, both billed in full, and the answer fails
  return {
    usd: callCost(r, price, 2 * r.tokens.input, a + second),
    passed: false,
    derivable: true,
  };
}
