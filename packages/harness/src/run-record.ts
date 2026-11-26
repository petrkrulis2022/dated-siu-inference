import type { RunRecord } from "@touchstone/sdk";
import { validateRunRecord } from "@touchstone/sdk";
import type { GradeResult, TaskInstance } from "@touchstone/basket";
import type { AdapterResult } from "./adapters/types.js";
import { billingFromRaw } from "./billing.js";

/**
 * Takes `runId` as a parameter rather than generating one internally — the orchestrator
 * needs the id before the record exists, to name the raw-response file this record's
 * `raw_response_ref` points at.
 */
export function buildRunRecord(
  runId: string,
  modelId: string,
  instance: TaskInstance,
  attempt: number,
  adapterResult: AdapterResult,
  grade: GradeResult,
  rawResponseRef: string,
): RunRecord {
  const record: RunRecord = {
    run_id: runId,
    model_id: modelId,
    task_class: instance.task_class,
    instance_id: instance.instance_id,
    seed: instance.seed,
    attempt,
    usage: adapterResult.usage,
    latency_ms: Math.round(adapterResult.latency_ms),
    gate_passed: grade.passed,
    raw_response_ref: rawResponseRef,
    deviations: adapterResult.deviations,
    // The tier that served the call and what it was billed, as the response states them (rules-2026-11-20): every record carries the tier.
    ...billingFromRaw(adapterResult.raw),
  };

  const result = validateRunRecord(record);
  if (!result.valid) {
    throw new Error(`Built an invalid run record: ${result.errors.join("; ")}`);
  }
  return record;
}
