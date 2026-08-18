import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { computePrint } from "./compute/index.js";
import { signPrintBody } from "./sign/sign.js";
import { verifyPrint } from "./verify.js";
import { publishableWorkedExampleInput } from "./worked-example.fixture.js";

const TEST_KEY = `0x${"33".repeat(32)}`;

function signedWorkedExample(): Print {
  const { body } = computePrint(publishableWorkedExampleInput());
  return signPrintBody(body, TEST_KEY);
}

describe("verifyPrint", () => {
  it("passes a freshly computed, freshly signed print on all three checks", () => {
    const print = signedWorkedExample();
    const result = verifyPrint(print, publishableWorkedExampleInput());
    expect(result.schemaValid).toBe(true);
    expect(result.signatureValid).toBe(true);
    expect(result.discrepancies).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("checks the signature alone when no run records are supplied", () => {
    const print = signedWorkedExample();
    const result = verifyPrint(print);
    expect(result.ok).toBe(true);
    expect(result.recomputed).toBeUndefined();
    expect(result.discrepancies).toEqual([]);
  });

  it("catches a print that was signed correctly but computed wrongly", () => {
    // The failure mode a signature alone cannot detect: the publisher's own arithmetic was
    // wrong, so the (valid) signature attests to a wrong number. Only recomputation finds it.
    const { body } = computePrint(publishableWorkedExampleInput());
    const doctored = { ...body, dated_siu: "0.0400" };
    const print = signPrintBody(doctored, TEST_KEY);

    const result = verifyPrint(print, publishableWorkedExampleInput());
    expect(result.signatureValid).toBe(true); // signature is genuinely valid
    expect(result.ok).toBe(false); // but the print does not survive recomputation
    expect(result.discrepancies).toContainEqual({
      field: "dated_siu",
      published: "0.0400",
      recomputed: "0.0383",
    });
  });

  it("catches a doctored exchange-rate row under a valid signature", () => {
    const { body } = computePrint(publishableWorkedExampleInput());
    const rows = [...body.exchange_rate_table];
    rows[0] = { ...rows[0], siu_per_usd: "99.9" };
    const print = signPrintBody(
      { ...body, exchange_rate_table: rows as typeof body.exchange_rate_table },
      TEST_KEY,
    );

    const result = verifyPrint(print, publishableWorkedExampleInput());
    expect(result.signatureValid).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.discrepancies.some((d) => d.field.includes("siu_per_usd"))).toBe(true);
  });

  it("catches post-publication tampering via the signature check", () => {
    const print = signedWorkedExample();
    const tampered = { ...print, dated_siu: "0.0999" } as Print;
    const result = verifyPrint(tampered, publishableWorkedExampleInput());
    expect(result.signatureValid).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports a discrepancy when the recomputation inputs differ from the published ones", () => {
    // Verifying against a different price snapshot than the print referenced should not
    // quietly succeed.
    const altered = publishableWorkedExampleInput();
    altered.models = altered.models.map((m) =>
      m.model_id === "A"
        ? { ...m, price: { price_in_usd_per_1m: "6.00", price_out_usd_per_1m: "30.00" } }
        : m,
    );

    const result = verifyPrint(signedWorkedExample(), altered);
    expect(result.ok).toBe(false);
    expect(result.discrepancies.length).toBeGreaterThan(0);
  });

  it("surfaces the body hash so a third party can reproduce the signed bytes", () => {
    const result = verifyPrint(signedWorkedExample());
    expect(result.bodyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
