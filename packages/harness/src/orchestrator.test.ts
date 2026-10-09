import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry, RunRecord } from "@touchstone/sdk";
import type { Grader, TaskInstance } from "@touchstone/basket";
import { checkSamplingSent, declaredParams, runOrchestrator, SamplingMismatchError, type OrchestratorTask } from "./orchestrator.js";
import { AdapterHttpError, type Adapter, type AdapterResult } from "./adapters/types.js";

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
  sampling: { temperature: 0 },
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
    sent: { temperature: 0 },
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

  it("records a retry-then-success in deviations, rather than looking like a clean first-attempt response", async () => {
    let call = 0;
    const adapter: Adapter = vi.fn(async () => {
      call++;
      if (call === 1) {
        throw new AdapterHttpError("rate limited", 429, undefined);
      }
      return fakeAdapterResult("ok");
    });
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: true }));

    const tasks: OrchestratorTask[] = [{ registryEntry, instance: makeInstance("T1"), grader }];
    const outcomes = await runOrchestrator(tasks, {
      runsDir,
      backoff: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });

    expect(adapter).toHaveBeenCalledTimes(2);
    expect(outcomes[0].passed).toBe(true);
    expect(outcomes[0].records).toHaveLength(1);
    expect(outcomes[0].records[0].deviations).toHaveLength(1);
    expect(outcomes[0].records[0].deviations[0]).toMatch(/retry 1:.*rate limited/);

    const [record] = await readRecords();
    expect(record.deviations[0]).toMatch(/retry 1:.*rate limited/);
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

describe("declared sampling (docs/methodology.md, Sampling settings)", () => {
  const providerDefault: ModelRegistryEntry = { ...registryEntry, id: "default-model", sampling: { temperature: "provider-default" } };

  it("sends the temperature the registry declares, and no omit flag", async () => {
    const adapter: Adapter = vi.fn(async () => fakeAdapterResult("ok"));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const task: OrchestratorTask = { registryEntry, instance: makeInstance("T1"), grader: vi.fn(async () => ({ passed: true })) };
    await runOrchestrator([task], { runsDir });
    const sent = vi.mocked(adapter).mock.calls[0][2];
    expect(sent.temperature).toBe(0);
    expect(sent.omit_temperature).toBeUndefined();
  });

  it("sends no temperature for a model declared at the provider default, so no rejected request is ever made", async () => {
    const adapter: Adapter = vi.fn(async () => ({ ...fakeAdapterResult("ok"), sent: { temperature: "provider-default" as const } }));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const task: OrchestratorTask = { registryEntry: providerDefault, instance: makeInstance("T1"), grader: vi.fn(async () => ({ passed: true })) };
    const [outcome] = await runOrchestrator([task], { runsDir });
    expect(vi.mocked(adapter).mock.calls[0][2].omit_temperature).toBe(true);
    expect(outcome.infraFailure).toBeUndefined();
    expect(outcome.records).toHaveLength(1);
    expect(outcome.records[0].deviations).toEqual([]);
  });

  it("refuses the measurement when a declared temperature was changed by the adapter, and says why", async () => {
    const adapter: Adapter = vi.fn(async () => ({
      ...fakeAdapterResult("ok"),
      deviations: ["temperature forced to provider default (request without temperature=0 was rejected)"],
      sent: { temperature: "provider-default" as const },
    }));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const grader: Grader = vi.fn(async () => ({ passed: true }));
    const [outcome] = await runOrchestrator([{ registryEntry, instance: makeInstance("T1"), grader }], { runsDir });
    expect(outcome.infraFailureCategory).toBe("sampling_mismatch");
    expect(outcome.infraFailure).toMatch(/SAMPLING MISMATCH: test-model is declared at temperature 0 and its request went out at provider-default/);
    expect(outcome.infraFailure).toMatch(/request without temperature=0 was rejected/);
    expect(outcome.records).toEqual([]);
    expect(grader).not.toHaveBeenCalled();
    expect(await readRecords()).toEqual([]);
  });

  it("does not retry a mismatch", async () => {
    const adapter: Adapter = vi.fn(async () => ({ ...fakeAdapterResult("ok"), sent: { temperature: 0.7 } }));
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    await runOrchestrator([{ registryEntry, instance: makeInstance("T3"), grader: vi.fn(async () => ({ passed: false })) }], { runsDir });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("refuses a result that does not say what it sent, and a model with no declaration, without calling the model", async () => {
    const unreported: AdapterResult = fakeAdapterResult("ok");
    delete unreported.sent;
    const adapter: Adapter = vi.fn(async () => unreported);
    vi.mocked(createAdapterFor).mockReturnValue(adapter);
    const [a] = await runOrchestrator([{ registryEntry, instance: makeInstance("T1"), grader: vi.fn(async () => ({ passed: true })) }], { runsDir });
    expect(a.infraFailureCategory).toBe("sampling_mismatch");
    expect(a.infraFailure).toMatch(/SAMPLING UNVERIFIED/);

    const calls = vi.mocked(adapter).mock.calls.length;
    const undeclared: ModelRegistryEntry = { ...registryEntry };
    delete undeclared.sampling;
    const [b] = await runOrchestrator([{ registryEntry: undeclared, instance: makeInstance("T1"), grader: vi.fn(async () => ({ passed: true })) }], { runsDir });
    expect(b.infraFailureCategory).toBe("sampling_mismatch");
    expect(b.infraFailure).toMatch(/SAMPLING NOT DECLARED/);
    expect(vi.mocked(adapter).mock.calls.length).toBe(calls);
  });

  it("declaredParams and checkSamplingSent behave the same on their own", () => {
    expect(declaredParams(registryEntry, { temperature: 0, max_tokens: 9 })).toEqual({ temperature: 0, max_tokens: 9 });
    expect(declaredParams(providerDefault, { temperature: 0, max_tokens: 9 })).toEqual({ temperature: 0, max_tokens: 9, omit_temperature: true });
    expect(declaredParams({ ...registryEntry, sampling: { temperature: 0.3 } }, { temperature: 0, max_tokens: 9 }).temperature).toBe(0.3);
    expect(() => checkSamplingSent(providerDefault, { ...fakeAdapterResult("x"), sent: { temperature: "provider-default" } })).not.toThrow();
    expect(() => checkSamplingSent(providerDefault, fakeAdapterResult("x"))).toThrow(SamplingMismatchError);
  });
});

