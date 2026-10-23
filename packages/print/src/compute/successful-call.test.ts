import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { computePrint, type PrintInput } from "./index.js";
import {
  SUCCESSFUL_CALL_VARIANT_NAME,
  successfulCallVariant,
  type DiscardedFirstCalls,
} from "./sensitivity.js";
import { publishableWorkedExampleInput } from "../worked-example.fixture.js";

type Usage = RunRecord["usage"];
const FIRST: Usage = { input: 2000, output: 300, cached_input: 100, reasoning: 5000 };

/** B's T1 runs as a retried model records them: usage is the SUM of the discarded first call and the successful one, and the deviation says so. */
function withDiscardedCalls(input: PrintInput, model: string): { input: PrintInput; discarded: DiscardedFirstCalls; finalOnly: PrintInput } {
  const discarded = new Map<string, Usage>();
  const summed = (r: RunRecord): RunRecord => {
    discarded.set(r.run_id, FIRST);
    return {
      ...r,
      usage: {
        input: r.usage.input + FIRST.input,
        output: r.usage.output + FIRST.output,
        cached_input: r.usage.cached_input + FIRST.cached_input,
        reasoning: r.usage.reasoning + FIRST.reasoning,
      },
      deviations: ["completion truncated by mandatory reasoning (finishReason MAX_TOKENS)"],
    };
  };
  const models = input.models.map((m) =>
    m.model_id === model
      ? { ...m, records: m.records.map((r) => (r.task_class === "T1" ? summed(r) : r)) }
      : m,
  );
  return { input: { ...input, models }, discarded, finalOnly: input };
}

describe("the successful-call variant (rules-2026-10-24)", () => {
  it("takes the discarded call's tokens off the usage of the runs that have one, for the named models only, and never below zero", () => {
    const base = publishableWorkedExampleInput();
    const { input, discarded } = withDiscardedCalls(base, "B");
    const v = successfulCallVariant({ discarded, appliesTo: ["B"] });
    const rec = input.models.find((m) => m.model_id === "B")?.records.find((r) => r.task_class === "T1") as RunRecord;
    const other = input.models.find((m) => m.model_id === "A")?.records[0] as RunRecord;
    expect(v.adjustUsage?.("B", rec)).toEqual(
      base.models.find((m) => m.model_id === "B")?.records.find((r) => r.run_id === rec.run_id)?.usage,
    );
    expect(v.adjustUsage?.("A", rec)).toEqual(rec.usage); // not a named model
    expect(v.adjustUsage?.("A", other)).toEqual(other.usage);
    const tiny = { ...rec, usage: { input: 1, output: 1, cached_input: 0, reasoning: 1 } };
    expect(v.adjustUsage?.("B", tiny)).toEqual({ input: 0, output: 0, cached_input: 0, reasoning: 0 });
    expect(v.adjust("B", "T1")).toBeUndefined(); // it changes no price
    expect(v.name).toBe(SUCCESSFUL_CALL_VARIANT_NAME);
  });

  it("gives, in the sensitivity block, exactly the headline the same print has when those runs are priced on the successful call alone", () => {
    const base = publishableWorkedExampleInput();
    const { input, discarded } = withDiscardedCalls(base, "B");
    const variant = successfulCallVariant({ discarded, appliesTo: ["B"] });
    const { body } = computePrint({ ...input, sensitivityVariants: [...(input.sensitivityVariants ?? []), variant] });
    const entry = body.sensitivity_block.find((e) => e.policy_variant === SUCCESSFUL_CALL_VARIANT_NAME);
    // the print under the successful-call basis, computed directly from the records without the discarded calls
    const direct = computePrint(base);
    expect(entry?.dated_siu).toBe(direct.body.dated_siu);
    expect(entry?.applies_to).toEqual(["B"]);
    // and the headline carries the discarded call, so the two differ and the delta is negative
    expect(body.dated_siu).not.toBe(direct.body.dated_siu);
    expect(Number(entry?.delta)).toBeLessThan(0);
  });

  it("leaves every other number of the print as it is: only the sensitivity block gains an entry", () => {
    const base = publishableWorkedExampleInput();
    const { input, discarded } = withDiscardedCalls(base, "B");
    const without = computePrint(input).body;
    const withVariant = computePrint({
      ...input,
      sensitivityVariants: [...(input.sensitivityVariants ?? []), successfulCallVariant({ discarded, appliesTo: ["B"] })],
    }).body;
    expect({ ...withVariant, sensitivity_block: undefined }).toEqual({ ...without, sensitivity_block: undefined });
    expect(withVariant.sensitivity_block).toHaveLength((without.sensitivity_block ?? []).length + 1);
  });
});
