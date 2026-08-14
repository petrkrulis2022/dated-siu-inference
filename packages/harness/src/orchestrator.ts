import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRegistryEntry, RunRecord } from "@datum/sdk";
import type { Grader, TaskInstance } from "@datum/basket";
import {
  createAdapterFor,
  loadApiKeysFromEnv,
  type Adapter,
  type ApiKeys,
} from "./adapters/index.js";
import { DEFAULT_BACKOFF, withBackoff, type BackoffOptions } from "./retry.js";
import { createLimiter } from "./concurrency.js";
import { buildRunRecord } from "./run-record.js";

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
  let passed = false;
  let attempt = 0;

  while (attempt < maxAttempts && !passed) {
    attempt++;

    let adapterResult;
    try {
      adapterResult = await withBackoff(
        () => adapter(task.registryEntry.model_string, task.instance.prompt, task.instance.params),
        backoff,
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
      };
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
