import type { RunRecord } from "@datum/sdk";
import { validateRunRecord } from "@datum/sdk";
import type { GradeResult, TaskInstance } from "@datum/basket";
import type { AdapterResult } from "./adapters/types.js";

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
  };

  const result = validateRunRecord(record);
  if (!result.valid) {
    throw new Error(`Built an invalid run record: ${result.errors.join("; ")}`);
  }
  return record;
}
