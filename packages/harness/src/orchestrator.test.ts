import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry, RunRecord } from "@touchstone/sdk";
import type { Grader, TaskInstance } from "@touchstone/basket";
import { runOrchestrator, type OrchestratorTask } from "./orchestrator.js";
import type { Adapter, AdapterResult } from "./adapters/types.js";

vi.mock("./adapters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/index.js")>();
  return { ...actual, createAdapterFor: vi.fn() };
});
import { createAdapterFor } from "./adapters/index.js";

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "touchstone-harness-orchestrator-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const registryEntry: ModelRegistryEntry = {
  id: "test-model",
  provider: "openrouter",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model_string: "test/model",
  tier: "mid",
  open_weights: true,
  host: "testhost",
};

function makeInstance(taskClass: "T1" | "T2" | "T3"): TaskInstance {
  return {
    task_class: taskClass,
    instance_id: `${taskClass}-00`,
    seed: 1,
    prompt: "do the thing",
    params: { temperature: 0, max_tokens: 100 },
    expected: {},
  };
}

function fakeAdapterResult(text: string): AdapterResult {
  return {
    text,
    usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
    latency_ms: 42,
    raw: { text },
    deviations: [],
  };
}

async function readRecords(): Promise<RunRecord[]> {
  const files = (await readdir(runsDir)).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".raw.json"),
  );
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(runsDir, f), "utf-8"))));
}

describe("runOrchestrator", () => {
  it("writes one record and one raw file for a passing single-shot (T1) instance", async () => {
    const adapter: Adapter = vi.fn(async () => fakeAdapterResult("ok"));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: true }));

    const tasks: OrchestratorTask[] = [{ registryEntry, instance: makeInstance("T1"), grader }];
    const outcomes = await runOrchestrator(tasks, { runsDir, concurrency: 2 });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].passed).toBe(true);
    expect(outcomes[0].records).toHaveLength(1);
    expect(adapter).toHaveBeenCalledTimes(1);

    const records = await readRecords();
    expect(records).toHaveLength(1);
    const rawFiles = (await readdir(runsDir)).filter((f) => f.endsWith(".raw.json"));
    expect(rawFiles).toHaveLength(1);
  });

  it("does not retry a T1/T2 instance after a failing grade — single-shot means single-shot", async () => {
    const adapter: Adapter = vi.fn(async () => fakeAdapterResult("wrong"));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: false, reason: "nope" }));

    const tasks: OrchestratorTask[] = [{ registryEntry, instance: makeInstance("T1"), grader }];
    const outcomes = await runOrchestrator(tasks, { runsDir });

    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].records).toHaveLength(1);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("gives T3 up to 3 graded attempts, stopping as soon as one passes", async () => {
    const adapter: Adapter = vi.fn(async () => fakeAdapterResult("code"));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    let call = 0;
    const grader: Grader = vi.fn(async () => {
      call++;
      return { passed: call === 3 };
    });

    const tasks: OrchestratorTask[] = [{ registryEntry, instance: makeInstance("T3"), grader }];
    const outcomes = await runOrchestrator(tasks, { runsDir });

    expect(outcomes[0].passed).toBe(true);
    expect(outcomes[0].records).toHaveLength(3);
    expect(outcomes[0].records.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("caps T3 at 3 attempts even if every one fails", async () => {
    const adapter: Adapter = vi.fn(async () => fakeAdapterResult("code"));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: false }));

    const tasks: OrchestratorTask[] = [{ registryEntry, instance: makeInstance("T3"), grader }];
    const outcomes = await runOrchestrator(tasks, { runsDir });

    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].records).toHaveLength(3);
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("records an infra failure (not a graded attempt) when every retry is exhausted, and writes no run record for it", async () => {
    const adapter: Adapter = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: true }));

    const tasks: OrchestratorTask[] = [{ registryEntry, instance: makeInstance("T1"), grader }];
    const outcomes = await runOrchestrator(tasks, {
      runsDir,
      backoff: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
    });

    expect(outcomes[0].passed).toBe(false);
    expect(outcomes[0].infraFailure).toBeTruthy();
    expect(outcomes[0].records).toHaveLength(0);
    expect(grader).not.toHaveBeenCalled();

    const records = await readRecords();
    expect(records).toHaveLength(0);
  });

  it("runs multiple tasks and produces one outcome per task", async () => {
    const adapter: Adapter = vi.fn(async () => fakeAdapterResult("ok"));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: true }));

    const tasks: OrchestratorTask[] = [
      { registryEntry, instance: makeInstance("T1"), grader },
      { registryEntry, instance: { ...makeInstance("T2"), instance_id: "T2-00" }, grader },
    ];
    const outcomes = await runOrchestrator(tasks, { runsDir, concurrency: 1 });

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.passed)).toBe(true);
    const records = await readRecords();
    expect(records).toHaveLength(2);
  });
});
