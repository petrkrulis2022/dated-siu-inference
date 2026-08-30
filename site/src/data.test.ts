import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunRecordsFor } from "./data.js";

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "touchstone-site-data-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

function record(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    run_id: "run-1",
    model_id: "test-model",
    task_class: "T1",
    instance_id: "T1-00",
    seed: 1,
    attempt: 1,
    usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
    latency_ms: 100,
    gate_passed: true,
    raw_response_ref: "run-1.raw.json",
    deviations: [],
    ...overrides,
  };
}

describe("loadRunRecordsFor", () => {
  it("loads real run records, ignoring .raw.json and reconciliation.json", async () => {
    const dir = join(runsDir, "2026-08-30");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run-1.json"), JSON.stringify(record()));
    await writeFile(join(dir, "run-1.raw.json"), JSON.stringify({ some: "raw provider payload" }));
    await writeFile(join(dir, "reconciliation.json"), JSON.stringify({ invoice: "1.23" }));

    const records = await loadRunRecordsFor(runsDir, "2026-08-30");
    expect(records).toHaveLength(1);
    expect(records[0]!.run_id).toBe("run-1");
  });

  it("ignores the declared run-record manifest (index.json) — found live: it was loaded as a " +
    "RunRecord, its undefined model_id/task_class crashing the Models page renderer the first " +
    "time a real publish actually wrote one", async () => {
    const dir = join(runsDir, "2026-08-30");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run-1.json"), JSON.stringify(record()));
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify({
        print_id: "2026-08-30",
        basket_version: "SIU-2026a",
        methodology_version: "v0-draft",
        run_records: ["run-1.json"],
      }),
    );

    const records = await loadRunRecordsFor(runsDir, "2026-08-30");
    expect(records).toHaveLength(1);
    expect(records[0]!.model_id).toBe("test-model");
  });
});
