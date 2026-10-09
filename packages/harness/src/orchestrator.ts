import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRegistryEntry, RunRecord } from "@touchstone/sdk";
import type { Grader, TaskInstance } from "@touchstone/basket";
import {
  createAdapterFor,
  loadApiKeysFromEnv,
  type Adapter,
  type ApiKeys,
} from "./adapters/index.js";
import { DEFAULT_BACKOFF, withBackoff, classifyFailure, type BackoffOptions, type FailureCategory } from "./retry.js";
import { createLimiter } from "./concurrency.js";
import { buildRunRecord } from "./run-record.js";
import { AdapterHttpError, type AdapterParams, type AdapterResult } from "./adapters/types.js";

export interface OrchestratorTask {
  registryEntry: ModelRegistryEntry;
  instance: TaskInstance;
  grader: Grader;
}

export interface OrchestratorOptions {
  runsDir: string;
  concurrency?: number;
  backoff?: BackoffOptions;
  keys?: ApiKeys;
}

export interface InstanceOutcome {
  registryEntry: ModelRegistryEntry;
  instance: TaskInstance;
  records: RunRecord[];
  passed: boolean;
  /** Set only when every retry within backoff was exhausted — no response was ever obtained. */
  infraFailure?: string;
  /** One-word bucket for infraFailure — see retry.ts's classifyFailure. Set exactly when
   * infraFailure is. */
  infraFailureCategory?: FailureCategory;
  /** How many retries were attempted before infraFailure was recorded — 0 means the error was
   * non-retryable (failed immediately, retrying would not have helped) rather than exhausted. */
  infraFailureRetries?: number;
  /** The provider's own real response body for an AdapterHttpError — found live, 2026-09-26,
   * investigating claude-haiku-4-5's real 400s on 2026-09-17/09-25: infraFailure only ever kept
   * a generic wrapper message ("Anthropic request failed: 400"), never the actual JSON body each
   * adapter already captures on AdapterHttpError but had nowhere to go — so the one piece of
   * information that would have explained the real cause was silently discarded at the exact
   * moment it was known, unrecoverable from any log or committed record afterward. Absent for a
   * non-HTTP infra failure (network/timeout), which has no such body to keep. */
  infraFailureBody?: string;
}

/**
 * Raised when a model's request went out with sampling other than what the registry declares for it (docs/methodology.md, Sampling settings). The print
 * sends exactly the declared sampling, and a call that did not is not a measurement under the stated settings, so it is refused rather than priced.
 */
export class SamplingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamplingMismatchError";
  }
}

/**
 * The request the print sends for a model: the task's own parameters with the sampling the registry declares for that model. A model declared at a number
 * is sent that temperature; one declared at "provider-default" is sent none, because it accepts no other value, and so no request is ever sent that the
 * provider will reject and the adapter has to change quietly. A model with no declaration is refused: admitting a model means writing its sampling down.
 */
export function declaredParams(entry: ModelRegistryEntry, params: AdapterParams): AdapterParams {
  const declared = entry.sampling;
  if (declared === undefined) {
    throw new SamplingMismatchError(
      `SAMPLING NOT DECLARED: ${entry.id} has no "sampling" in the registry. Write down the sampling this model is measured at (docs/methodology.md, Sampling settings).`,
    );
  }
  return declared.temperature === "provider-default" ? { ...params, omit_temperature: true } : { ...params, temperature: declared.temperature };
}

/** What the adapter reports it sent, in the registry's own terms. */
const sentAs = (result: AdapterResult): number | "provider-default" | undefined => result.sent?.temperature;

/** Throws `SamplingMismatchError` unless the request went out with exactly the declared sampling. A result that does not say what it sent cannot be checked and is refused too. */
export function checkSamplingSent(entry: ModelRegistryEntry, result: AdapterResult): void {
  const declared = entry.sampling?.temperature;
  const sent = sentAs(result);
  if (declared === undefined) {
    throw new SamplingMismatchError(`SAMPLING NOT DECLARED: ${entry.id} has no "sampling" in the registry.`);
  }
  if (sent === undefined) {
    throw new SamplingMismatchError(`SAMPLING UNVERIFIED: ${entry.id}'s adapter did not report what it sent, so the declared temperature (${String(declared)}) cannot be checked.`);
  }
  if (sent !== declared) {
    throw new SamplingMismatchError(
      `SAMPLING MISMATCH: ${entry.id} is declared at temperature ${String(declared)} and its request went out at ${String(sent)}` +
        (result.deviations.some((d) => /temperature/i.test(d)) ? ` (${result.deviations.filter((d) => /temperature/i.test(d)).join("; ")})` : "") +
        ". The measurement is refused. Change the declaration only with a dated methodology note.",
    );
  }
}

/** T3 gets up to 3 graded attempts per build1-spec.md §3; T1/T2 are single-shot. */
const MAX_ATTEMPTS: Record<string, number> = { T1: 1, T2: 1, T3: 3 };

async function writeRaw(runsDir: string, runId: string, raw: unknown): Promise<string> {
  const fileName = `${runId}.raw.json`;
  await writeFile(join(runsDir, fileName), JSON.stringify(raw, null, 2), "utf-8");
  return fileName;
}

async function writeRecord(runsDir: string, record: RunRecord): Promise<void> {
  await writeFile(
    join(runsDir, `${record.run_id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8",
  );
}

async function runOneInstance(
  task: OrchestratorTask,
  adapter: Adapter,
  runsDir: string,
  backoff: BackoffOptions,
): Promise<InstanceOutcome> {
  const maxAttempts = MAX_ATTEMPTS[task.instance.task_class] ?? 1;
  const records: RunRecord[] = [];
  // Resolved once, before any call and outside the backoff: a model with no declared sampling is refused, never retried.
  let params: AdapterParams;
  try {
    params = declaredParams(task.registryEntry, task.instance.params);
  } catch (err) {
    return {
      registryEntry: task.registryEntry,
      instance: task.instance,
      records,
      passed: false,
      infraFailure: err instanceof Error ? err.message : String(err),
      infraFailureCategory: "sampling_mismatch",
      infraFailureRetries: 0,
    };
  }
  let passed = false;
  let attempt = 0;

  while (attempt < maxAttempts && !passed) {
    attempt++;

    let adapterResult;
    const retryErrors: string[] = [];
    try {
      adapterResult = await withBackoff(
        () => adapter(task.registryEntry.model_string, task.instance.prompt, params),
        {
          ...backoff,
          onRetry: (attemptNumber, err) => {
            retryErrors.push(
              `retry ${attemptNumber}: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        },
      );
    } catch (err) {
      // Every retry within backoff was exhausted: an infrastructure failure, not a graded
      // attempt. build1-spec.md §4: "network-failure retries do not count as quality-gate
      // attempts and their tokens are excluded from cost" — so this consumes no attempt
      // budget and produces no run record (there is no real usage/response to record).
      return {
        registryEntry: task.registryEntry,
        instance: task.instance,
        records,
        passed: false,
        infraFailure: err instanceof Error ? err.message : String(err),
        infraFailureCategory: classifyFailure(err),
        infraFailureRetries: retryErrors.length,
        ...(err instanceof AdapterHttpError ? { infraFailureBody: JSON.stringify(err.body) } : {}),
      };
    }

    // The request went out with the declared sampling or this is not a measurement (see SamplingMismatchError). Checked after the call and outside the backoff,
    // so it is never retried, and reported as a failure of its own kind so it can neither pass as an outage nor be priced.
    try {
      checkSamplingSent(task.registryEntry, adapterResult);
    } catch (err) {
      return {
        registryEntry: task.registryEntry,
        instance: task.instance,
        records,
        passed: false,
        infraFailure: err instanceof Error ? err.message : String(err),
        infraFailureCategory: "sampling_mismatch",
        infraFailureRetries: retryErrors.length,
      };
    }

    // A retried-then-successful response must not look identical to a clean first-attempt one
    // in the record a print is computed from — see BackoffOptions.onRetry's doc comment.
    if (retryErrors.length > 0) {
      adapterResult = { ...adapterResult, deviations: [...adapterResult.deviations, ...retryErrors] };
    }

    const grade = await task.grader(task.instance, adapterResult.text);
    const runId = randomUUID();
    const rawRef = await writeRaw(runsDir, runId, adapterResult.raw);
    const record = buildRunRecord(
      runId,
      task.registryEntry.id,
      task.instance,
      attempt,
      adapterResult,
      grade,
      rawRef,
    );
    await writeRecord(runsDir, record);
    records.push(record);
    passed = grade.passed;
  }

  return { registryEntry: task.registryEntry, instance: task.instance, records, passed };
}

export async function runOrchestrator(
  tasks: OrchestratorTask[],
  options: OrchestratorOptions,
): Promise<InstanceOutcome[]> {
  await mkdir(options.runsDir, { recursive: true });
  const limit = createLimiter(options.concurrency ?? 4);
  const keys = options.keys ?? loadApiKeysFromEnv();
  const backoff = options.backoff ?? DEFAULT_BACKOFF;

  const adapterCache = new Map<string, Adapter>();
  function getAdapter(entry: ModelRegistryEntry): Adapter {
    const cacheKey = `${entry.provider}:${entry.host}`;
    let adapter = adapterCache.get(cacheKey);
    if (!adapter) {
      adapter = createAdapterFor(entry, keys);
      adapterCache.set(cacheKey, adapter);
    }
    return adapter;
  }

  return Promise.all(
    tasks.map((task) =>
      limit(() => runOneInstance(task, getAdapter(task.registryEntry), options.runsDir, backoff)),
    ),
  );
}
