import { describe, expect, it } from "vitest";
import type { Print, RunRecord } from "@touchstone/sdk";
import { computePrint, type PrintInput } from "./compute/index.js";
import { successfulCallVariant, SUCCESSFUL_CALL_VARIANT_NAME } from "./compute/sensitivity.js";
import { signPrintBody } from "./sign/sign.js";
import { verifyPrint } from "./verify.js";
import { publishableWorkedExampleInput } from "./worked-example.fixture.js";

const KEY = `0x${"44".repeat(32)}`;
const FIRST = { input: 2000, output: 300, cached_input: 0, reasoning: 5000 };

/** The worked example with B's T1 runs retried: usage is the sum, and the variant takes the first call off. */
function inputWithVariant(): { input: PrintInput; plain: PrintInput } {
  const base = publishableWorkedExampleInput();
  const discarded = new Map<string, RunRecord["usage"]>();
  const models = base.models.map((m) =>
    m.model_id !== "B"
      ? m
      : {
          ...m,
          records: m.records.map((r) => {
            if (r.task_class !== "T1") return r;
            discarded.set(r.run_id, FIRST);
            return {
              ...r,
              usage: {
                input: r.usage.input + FIRST.input,
                output: r.usage.output + FIRST.output,
                cached_input: 0,
                reasoning: r.usage.reasoning + FIRST.reasoning,
              },
              deviations: ["completion truncated by mandatory reasoning"],
            };
          }),
        },
  );
  const withDiscards = { ...base, models };
  const input = {
    ...withDiscards,
    sensitivityVariants: [...(base.sensitivityVariants ?? []), successfulCallVariant({ discarded, appliesTo: ["B"] })],
  };
  return { input, plain: base };
}

describe("verifying a print that publishes the successful-call basis", () => {
  it("reproduces the published figure from the same records", () => {
    const { input } = inputWithVariant();
    const print = signPrintBody(computePrint(input).body, KEY);
    expect(print.sensitivity_block.some((v) => v.policy_variant === SUCCESSFUL_CALL_VARIANT_NAME)).toBe(true);
    const result = verifyPrint(print, input);
    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("catches a published successful-call figure that does not reproduce", () => {
    const { input } = inputWithVariant();
    const { body } = computePrint(input);
    const doctored = {
      ...body,
      sensitivity_block: body.sensitivity_block.map((v) =>
        v.policy_variant === SUCCESSFUL_CALL_VARIANT_NAME ? { ...v, dated_siu: "0.0001" } : v,
      ) as typeof body.sensitivity_block,
    };
    const result = verifyPrint(signPrintBody(doctored, KEY), input);
    expect(result.signatureValid).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.discrepancies.map((d) => d.field)).toContain("sensitivity_block[successful-call].dated_siu");
  });

  it("never holds an earlier print to a variant it did not publish", () => {
    const { input } = inputWithVariant();
    const old: Print = signPrintBody(computePrint(publishableWorkedExampleInput()).body, KEY);
    // verifying it with an input that now carries the variant must not invent a discrepancy: the published print has no such entry
    const result = verifyPrint(old, input);
    expect(result.discrepancies.map((d) => d.field)).not.toContain("sensitivity_block[successful-call].dated_siu");
  });
});
