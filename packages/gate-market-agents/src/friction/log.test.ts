import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FrictionLogWriter, type FrictionLogEntry } from "./log.js";

describe("FrictionLogWriter", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "gate-market-friction-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("appends one JSON line per entry, matching spec §8.6's real schema field-for-field", async () => {
    const writer = new FrictionLogWriter(runsRoot, "run-1");
    // The exact example entry from docs/gate-market-spec.md §8.6.
    const entry: FrictionLogEntry = {
      agent: "WORKER-EXTRACT",
      turn: 47,
      job_id: "job-abc",
      attempted: "pay WORKER-CODE 40 SIU in fsiu:extract/2026-W40",
      outcome: "rejected — seller accepts only code-class claims",
      could_not_express: "a quote conditional on the adversary finding at least one case",
      forced_conversion: true,
      conversion_reason: "seller would not accept my class of claim",
      missing_information: "no way to see which classes a seller accepts before requesting a quote",
      decision_confidence: "low",
    };

    await writer.append(entry);

    const contents = await readFile(path.join(runsRoot, "run-1", "friction-log.jsonl"), "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it("appends multiple entries as separate lines, in order", async () => {
    const writer = new FrictionLogWriter(runsRoot, "run-1");
    const base: FrictionLogEntry = {
      agent: "ORCHESTRATOR",
      turn: 1,
      job_id: "job-1",
      attempted: "x",
      outcome: "y",
      could_not_express: null,
      forced_conversion: false,
      conversion_reason: null,
      missing_information: null,
      decision_confidence: "high",
    };
    await writer.append(base);
    await writer.append({ ...base, turn: 2 });

    const contents = await readFile(path.join(runsRoot, "run-1", "friction-log.jsonl"), "utf-8");
    const lines = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((l) => l.turn)).toEqual([1, 2]);
  });
});
