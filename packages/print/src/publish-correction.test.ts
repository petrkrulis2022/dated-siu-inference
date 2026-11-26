import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Print, RunRecord } from "@touchstone/sdk";
import type { AnchorResult, AttestationClient } from "./anchor/attestation.js";
import type { ModelInput, PrintInput } from "./compute/index.js";
import { CORRECTION_RULES_REVISION } from "./correction.js";
import { correctionReason, publishCorrection } from "./publish-correction.js";
import { publishPrint, type PublishInput } from "./publish.js";
import { printBodyHashHex } from "./sign/canonicalise.js";
import { verifyPrintSignature } from "./sign/sign.js";
import { publishableWorkedExampleInput, workedExampleInput } from "./worked-example.fixture.js";

// The corrections publish step (the revision policy's error procedure): each affected print is corrected once, as the next numbered revision,
// signed and anchored like any print, naming its original in its signed body; the original stays as published and gains superseded_by.

const TEST_KEY = `0x${"55".repeat(32)}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "touchstone-print-correction-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class SpyClient implements AttestationClient {
  hashes: string[] = [];
  async postPrint(hash: string): Promise<AnchorResult> {
    this.hashes.push(hash);
    return { chain: "base-sepolia", status: "anchored", tx_hash: `0x${"ab".repeat(32)}`, posted_at: "2026-11-23T10:00:00.000Z" };
  }
}

function extraQualifyingModel(id: string): ModelInput {
  const base = workedExampleInput().models[0];
  return { ...base, model_id: id, records: base.records.map((r) => ({ ...r, model_id: id })) };
}

function originalInput(overrides: Partial<PublishInput> = {}): PublishInput {
  const rest = Object.fromEntries(Object.entries(publishableWorkedExampleInput()).filter(([k]) => k !== "status")) as Omit<PrintInput, "status">;
  return {
    ...rest,
    print_id: "2026-10-15",
    date: "2026-10-15",
    models: [...rest.models, extraQualifyingModel("E")],
    privateKeyHex: TEST_KEY,
    ...overrides,
  };
}

/** The recomputation under the correction rule: here, model E's list price was overstated in the original and is halved. */
function correctedInput(original: PublishInput, change: (m: ModelInput) => ModelInput = halveE): PrintInput {
  const publishOnly = new Set(["privateKeyHex", "attestationClient", "priorAttempts", "constituentChanges", "series"]);
  const input = Object.fromEntries(Object.entries(original).filter(([k]) => !publishOnly.has(k))) as unknown as PrintInput;
  return {
    ...input,
    print_id: original.print_id.replace(/^(\d{4}-\d{2}-\d{2})/, "$1b"),
    methodology_revision: CORRECTION_RULES_REVISION,
    models: input.models.map(change),
  };
}
function halveE(m: ModelInput): ModelInput {
  if (m.model_id !== "E") return m;
  return {
    ...m,
    price: { price_in_usd_per_1m: String(Number(m.price.price_in_usd_per_1m) / 2), price_out_usd_per_1m: String(Number(m.price.price_out_usd_per_1m) / 2) },
  };
}

async function publishOriginal(input: PublishInput): Promise<Print> {
  return (await publishPrint(dir, input)).print;
}

describe("publishCorrection", () => {
  it("publishes the next numbered revision, naming its original in the signed body, and marks the original superseded_by", async () => {
    const input = originalInput();
    const original = await publishOriginal(input);
    const spy = new SpyClient();
    const reason = "Corrects the pricing errors set out in the dated notice of 21 November 2026.";

    const result = await publishCorrection(dir, { original, input: correctedInput(input), reason, privateKeyHex: TEST_KEY, attestationClient: spy });

    expect(result.print.print_id).toBe("2026-10-15b");
    expect(result.print.supersedes).toEqual({ print_id: "2026-10-15", reason });
    expect(result.print.methodology_revision).toBe(CORRECTION_RULES_REVISION);
    expect(result.print.dated_siu).not.toBe(original.dated_siu);
    expect(spy.hashes).toEqual([printBodyHashHex(result.print)]);
    expect(verifyPrintSignature(result.print).valid).toBe(true);

    const after = JSON.parse(await readFile(join(dir, "2026-10-15.json"), "utf-8")) as Print;
    expect(after.superseded_by).toEqual({ print_id: "2026-10-15b", reason });
    expect(printBodyHashHex(after)).toBe(printBodyHashHex(original));
    expect(result.original.superseded_by?.print_id).toBe("2026-10-15b");
  });

  it("carries the original's series, prior attempts and constituent changes into the correction", async () => {
    const priorAttempts = [{ attempted_at: "2026-10-15T00:40:00.000Z", reason: "3 of 4 commodity", qualifying_models: 3, registered_models: 4, cost_usd: "0.5" }];
    const constituentChanges = [{ model_id: "E", change: "admitted" as const }];
    const input = originalInput({ print_id: "2026-10-15-commodity", series: "commodity", priorAttempts, constituentChanges });
    const original = await publishOriginal(input);
    const corrected = { ...correctedInput(input), print_id: "2026-10-15b-commodity" };

    const result = await publishCorrection(dir, { original, input: corrected, reason: "r", privateKeyHex: TEST_KEY });

    expect(result.print.print_id).toBe("2026-10-15b-commodity");
    expect(result.print.series).toBe("commodity");
    expect(result.print.prior_attempts).toEqual(original.prior_attempts);
    expect(result.print.constituent_changes).toEqual(original.constituent_changes);
  });

  it("never moves latest.json back to an older date", async () => {
    const input = originalInput();
    const original = await publishOriginal(input);
    const newer = await publishOriginal(originalInput({ print_id: "2026-11-22", date: "2026-11-22" }));

    const result = await publishCorrection(dir, { original, input: correctedInput(input), reason: "r", privateKeyHex: TEST_KEY });

    const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf-8")) as Print;
    expect(latest.print_id).toBe(newer.print_id);
    expect(result.write.latestWritten).toBe(false);
  });

  it("refuses a correction that would change the qualifying set: a correction changes prices, never which constituents qualify", async () => {
    const input = originalInput();
    const original = await publishOriginal(input);
    const spy = new SpyClient();
    const dropB = (m: ModelInput): ModelInput => (m.model_id === "B" ? { ...m, records: m.records.filter((r) => r.task_class !== "T1") } : m);

    await expect(
      publishCorrection(dir, { original, input: correctedInput(input, dropB), reason: "r", privateKeyHex: TEST_KEY, attestationClient: spy }),
    ).rejects.toThrow(/qualifying set/);
    expect(spy.hashes).toEqual([]);
    expect(await readdir(dir)).not.toContain("2026-10-15b.json");
  });

  it("refuses a correction that changes nothing", async () => {
    const input = originalInput();
    const original = await publishOriginal(input);
    await expect(
      publishCorrection(dir, { original, input: correctedInput(input, (m) => m), reason: "r", privateKeyHex: TEST_KEY }),
    ).rejects.toThrow(/nothing to correct/);
  });

  it("refuses an original that is already superseded, before signing or anchoring", async () => {
    const input = originalInput();
    const original = await publishOriginal(input);
    const spy = new SpyClient();
    const superseded = { ...original, superseded_by: { print_id: "2026-10-15b", reason: "earlier" } };
    await expect(
      publishCorrection(dir, { original: superseded, input: correctedInput(input), reason: "r", privateKeyHex: TEST_KEY, attestationClient: spy }),
    ).rejects.toThrow(/already superseded/);
    expect(spy.hashes).toEqual([]);
  });

  it("refuses a revision id that is not the next one after the original", async () => {
    const input = originalInput();
    const original = await publishOriginal(input);
    await expect(
      publishCorrection(dir, { original, input: { ...correctedInput(input), print_id: "2026-10-15c" }, reason: "r", privateKeyHex: TEST_KEY }),
    ).rejects.toThrow(/2026-10-15b/);
  });
});

describe("correctionReason", () => {
  const rec = (model_id: string, usage: Partial<RunRecord["usage"]>, over: Partial<RunRecord> = {}): RunRecord => ({
    run_id: `${model_id}-1`,
    model_id,
    task_class: "T1",
    instance_id: "i",
    seed: 1,
    attempt: 1,
    usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0, ...usage },
    latency_ms: 1,
    gate_passed: true,
    raw_response_ref: "r.json",
    deviations: [],
    ...over,
  });
  const price = { price_in_usd_per_1m: "2", price_out_usd_per_1m: "12", price_cached_in_usd_per_1m: "0.2" };
  const noCachedRate = { price_in_usd_per_1m: "0.26", price_out_usd_per_1m: "0.38" };
  const models: ModelInput[] = [
    { model_id: "gemini", price, cachedInsideInput: true, records: [rec("gemini", { cached_input: 430_000 })] },
    { model_id: "deepseek", price: noCachedRate, cachedInsideInput: true, records: [rec("deepseek", { cached_input: 256 })] },
    // Listed at the flex tier, billed at the standard tier.
    { model_id: "qwen", price: { price_in_usd_per_1m: "0.288", price_out_usd_per_1m: "0.32" }, cachedInsideInput: true, records: [rec("qwen", {}, { billed_usd: "0.36" })] },
    { model_id: "claude", price, cachedInsideInput: false, records: [rec("claude", {})] },
  ];
  const original = {
    basket_costs: [
      { model_id: "gemini", cost_usd: "2.086" },
      { model_id: "deepseek", cost_usd: "0.26" },
      { model_id: "qwen", cost_usd: "0.288" },
      { model_id: "claude", cost_usd: "2" },
    ],
  } as unknown as Print;
  const corrected = {
    basket_costs: [
      { model_id: "gemini", cost_usd: "1.226" },
      { model_id: "deepseek", cost_usd: "0.25" },
      { model_id: "qwen", cost_usd: "0.36" },
      { model_id: "claude", cost_usd: "2" },
    ],
  } as unknown as Print;

  it("names each changed constituent under the error that changed it, and no unchanged one", () => {
    const reason = correctionReason(original, corrected, { models });
    expect(reason).toContain("dated notice of 21 November 2026");
    expect(reason).toContain("cached prompt tokens counted twice for gemini");
    expect(reason).toContain("cached prompt tokens priced at the full input price, the price snapshot having no cached rate, for deepseek");
    expect(reason).toContain("calls priced at a service tier other than the one they were billed on, for qwen");
    expect(reason).toContain(CORRECTION_RULES_REVISION);
    expect(reason).not.toContain("claude");
  });

  it("reads a carried-forward row's cause from the day its usage was measured", () => {
    // Gemini carried forward on 2026-09-30 from 2026-09-29: no records of its own that day; the carried usage had cached tokens.
    const today = models.map((m) => (m.model_id === "gemini" ? { ...m, records: [] } : m));
    const history = [{ date: "2026-09-29", records: new Map([["gemini", [rec("gemini", { cached_input: 430_000 })]]]) }];
    const carriedOriginal = { basket_costs: [{ model_id: "gemini", cost_usd: "2.086", carried_forward_from: "2026-09-29" }] } as unknown as Print;
    const carriedCorrected = { basket_costs: [{ model_id: "gemini", cost_usd: "1.226", carried_forward_from: "2026-09-29" }] } as unknown as Print;
    expect(correctionReason(carriedOriginal, carriedCorrected, { models: today, carryForwardHistory: history })).toContain(
      "cached prompt tokens counted twice for gemini (carried forward from 2026-09-29)",
    );
    expect(() => correctionReason(carriedOriginal, carriedCorrected, { models: today })).toThrow(/gemini/);
  });

  it("refuses a change it cannot attribute to either error", () => {
    const unexplained = { basket_costs: [...corrected.basket_costs.slice(0, 3), { model_id: "claude", cost_usd: "1.9" }] } as unknown as Print;
    expect(() => correctionReason(original, unexplained, { models })).toThrow(/claude/);
  });
});
