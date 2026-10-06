/**
 * The work itself: a T1 shipment-record extraction, generated from the run's seed, graded by the
 * basket's own deterministic grader. Nothing is authored and nothing is attacked — a job is a document
 * and a schema, and the grader says whether the model's JSON matches the record (plan §2.1).
 *
 * The four job types are four seed streams of the same task. They differ in identity, which is what
 * the economy needs: a trader's skill is "can deliver TYPE-k", enforced by the lab's guards.
 */
import { deriveSeed, generateT1Instance, gradeT1, type T1Expected, type TaskInstance } from "@touchstone/basket";
import type { Adapter } from "@touchstone/harness";
import { realizedTurnCostUsd, type ModelPrices } from "../budget/inference-cost.js";
import type { Need } from "./economy.js";

export interface Job {
  /** The need it answers. */
  needId: string;
  instance: TaskInstance<T1Expected>;
}

/** One job per need, derived from the run seed alone, so any run can be reproduced from its seed. */
export function jobFor(seed: number, need: Need): Job {
  const parent = deriveSeed(seed, "job", need.type);
  const index = Number(need.id.split("#")[1] ?? 0) + need.round * 10;
  return { needId: need.id, instance: generateT1Instance(parent, index) };
}

export interface WorkResult {
  passed: boolean;
  /** Why it failed, in the grader's words. Never carries the expected answer. */
  reason?: string;
  usage: { input: number; output: number };
  /** Real cost of the call, decimal USD. Zero for the reference executor. */
  costUsd: string;
}

/** Performs and grades one job. The executor is never shown the expected answer. */
export type WorkExecutor = (job: Job) => Promise<WorkResult>;

/** The real thing: one call to a cheap model, graded by the basket's deterministic grader. */
export function modelExecutor(deps: { adapter: Adapter; modelString: string; prices: ModelPrices }): WorkExecutor {
  return async (job) => {
    const { instance } = job;
    const res = await deps.adapter(deps.modelString, instance.prompt, {
      temperature: instance.params.temperature,
      max_tokens: instance.params.max_tokens,
    });
    const costUsd = realizedTurnCostUsd(res.usage.input, res.usage.output, deps.prices);
    const usage = { input: res.usage.input, output: res.usage.output };
    if (res.text.trim() === "") {
      return { passed: false, reason: "the model returned no text", usage, costUsd };
    }
    const graded = await gradeT1(instance, res.text);
    return {
      passed: graded.passed,
      ...(graded.passed ? {} : { reason: graded.reason ?? "the output did not match the record" }),
      usage,
      costUsd,
    };
  };
}

/**
 * Answers every job correctly and costs nothing. For scripted runs and tests, where the point is the
 * currency and not the extraction. It reads the answer from the instance, so it can only be used where
 * the harness — never an agent — holds the instance.
 */
export const referenceExecutor: WorkExecutor = async (job) => {
  const graded = await gradeT1(job.instance, JSON.stringify(job.instance.expected));
  return { passed: graded.passed, usage: { input: 0, output: 0 }, costUsd: "0" };
};
