import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttestationClient, AnchorResult } from "./anchor/attestation.js";
import type { ModelInput } from "./compute/index.js";
import {
  computeConstituentChanges,
  findInvalidRecords,
  publishPrint,
  MINIMUM_QUALIFYING_MODELS,
  QualifyingSetError,
  type PublishInput,
  type PriorAttempt,
} from "./publish.js";
import { writeRunManifest } from "./publication.js";
import { workedExampleInput, publishableWorkedExampleInput } from "./worked-example.fixture.js";

const TEST_KEY = `0x${"55".repeat(32)}`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "touchstone-print-publish-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The shared worked-example fixture (A/B/C/D) deliberately has only 3 qualifying models — D's
 * T3 fails outright, by design (see worked-example.fixture.ts) — one short of
 * MINIMUM_QUALIFYING_MODELS. Rather than change that canonical, doc-referenced fixture, tests
 * here that don't care about the qualifying-set gate add one more clean-passing model locally.
 */
function extraQualifyingModel(id: string): ModelInput {
  const base = workedExampleInput().models[0]; // "A" — fully clean-passing on every class.
  return { ...base, model_id: id, records: base.records.map((r) => ({ ...r, model_id: id })) };
}

function publishInput(overrides: Partial<PublishInput> = {}): PublishInput {
  const rest = Object.fromEntries(
    Object.entries(publishableWorkedExampleInput()).filter(([key]) => key !== "status"),
  ) as PublishInput;
  return {
    ...rest,
    models: [...rest.models, extraQualifyingModel("E")],
    privateKeyHex: TEST_KEY,
    ...overrides,
  };
}

describe("findInvalidRecords", () => {
  it("returns nothing for well-formed records", () => {
    expect(findInvalidRecords(publishInput())).toEqual([]);
  });

  it("catches a record missing a required field", () => {
    const input = publishInput();
    const modelA = input.models[0];
    // Real corruption a hand-edited or partially-written file could produce: usage present
    // but missing one of its required sub-fields.
    const corrupted = {
      ...modelA,
      records: [
        { ...modelA.records[0], usage: { input: 100, output: 50, cached_input: 0 } as never },
      ],
    };
    const found = findInvalidRecords({ models: [corrupted, ...input.models.slice(1)] });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].model_id).toBe(modelA.model_id);
  });

  it("catches an out-of-range attempt number", () => {
    const input = publishInput();
    const modelA = input.models[0];
    const corrupted = { ...modelA, records: [{ ...modelA.records[0], attempt: 4 }] };
    const found = findInvalidRecords({ models: [corrupted, ...input.models.slice(1)] });
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("publishPrint", () => {
  it("refuses to publish when a run record fails schema validation, before touching disk", async () => {
    const input = publishInput();
    const modelA = input.models[0];
    const corrupted = { ...modelA, records: [{ ...modelA.records[0], attempt: 99 }] };
    input.models = [corrupted, ...input.models.slice(1)];

    await expect(publishPrint(dir, input)).rejects.toThrow(/failed schema validation/);

    // Nothing was written — a refusal is total, not a partial publish.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("always publishes as provisional, regardless of what status is passed in", async () => {
    const input = { ...publishInput(), status: "final" } as PublishInput & { status: string };
    const result = await publishPrint(dir, input);
    expect(result.print.status).toBe("provisional");
  });

  it("writes a signed, anchored print to disk and refreshes the index", async () => {
    const result = await publishPrint(dir, publishInput());

    expect(result.print.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(result.print.anchor?.status).toBe("stub");
    expect(result.print.cost_of_production_usd).toBeTruthy();

    const onDisk = JSON.parse(await readFile(result.write.path, "utf-8"));
    expect(onDisk).toEqual(result.print);

    const index = JSON.parse(await readFile(result.indexPath, "utf-8"));
    expect(index).toHaveLength(1);
    expect(index[0].status).toBe("provisional");
  });

  it("uses a custom attestation client when supplied", async () => {
    const fake: AttestationClient = {
      async postPrint(): Promise<AnchorResult> {
        return { chain: "base-sepolia", status: "anchored", tx_hash: `0x${"ab".repeat(32)}` };
      },
    };
    const result = await publishPrint(dir, publishInput({ attestationClient: fake }));
    expect(result.print.anchor?.status).toBe("anchored");
    expect(result.print.anchor?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces a print whose signature survives its own anchor", async () => {
    const { verifyPrintSignature } = await import("./sign/sign.js");
    const result = await publishPrint(dir, publishInput());
    expect(verifyPrintSignature(result.print).valid).toBe(true);
  });

  it("refuses to publish a print with no sensitivity variants (fails schema before anchoring)", async () => {
    const base = workedExampleInput();
    const input = {
      ...base,
      models: [...base.models, extraQualifyingModel("E")],
      privateKeyHex: TEST_KEY,
    } as PublishInput;
    await expect(publishPrint(dir, input)).rejects.toThrow(/Refusing to sign/);
  });

  it("refuses to publish below the minimum qualifying-set size, before signing or anchoring", async () => {
    // The live incident this guards against: a run that only qualified 2 of 6 registered
    // models still published. Simulate the equivalent here — fewer than the minimum qualify.
    const base = publishableWorkedExampleInput();
    const input = {
      ...base,
      models: base.models.filter((m) => m.model_id !== "D"), // A, B, C only qualify — 3 total.
      privateKeyHex: TEST_KEY,
    } as PublishInput;

    await expect(publishPrint(dir, input)).rejects.toThrow(
      new RegExp(
        `only 3 of 3 registered models qualified \\(minimum ${MINIMUM_QUALIFYING_MODELS}\\)`,
      ),
    );

    // A refusal is total — nothing was written, no signature, no anchor attempt.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("throws a QualifyingSetError carrying the counts and real spend as structured data", async () => {
    const base = publishableWorkedExampleInput();
    const input = {
      ...base,
      models: base.models.filter((m) => m.model_id !== "D"),
      privateKeyHex: TEST_KEY,
    } as PublishInput;

    const err = await publishPrint(dir, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QualifyingSetError);
    const qsErr = err as QualifyingSetError;
    expect(qsErr.qualifying).toBe(3);
    expect(qsErr.registered).toBe(3);
    expect(qsErr.costUsd).toMatch(/^\d+(\.\d+)?$/);
  });

  it("refuses to publish when the anchor transaction fails, writing nothing", async () => {
    // The gap this guards against: anchorIdempotently can return status "failed" (a mined
    // but reverted tx, or postedAt still reading 0 after retries) without throwing. A human
    // publishing manually would notice and not commit it; automation has no human, so this
    // must be a hard refusal, not a written-but-unverifiable print.
    const failing: AttestationClient = {
      async postPrint(): Promise<AnchorResult> {
        return { chain: "base-sepolia", status: "failed", notes: "simulated revert" };
      },
    };
    await expect(publishPrint(dir, publishInput({ attestationClient: failing }))).rejects.toThrow(
      /anchoring failed/,
    );

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("refuses to publish above the configured spend ceiling, before signing or anchoring", async () => {
    await expect(publishPrint(dir, publishInput({ spendCeilingUsd: "0.0000001" }))).rejects.toThrow(
      /exceeds the configured ceiling/,
    );

    // A refusal is total — nothing was written, no signature, no anchor attempt.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("writes a declared run manifest when runsDirPath is supplied", async () => {
    const runsDir = join(dir, "runs");
    const input = publishInput({ runsDirPath: runsDir });
    const result = await publishPrint(dir, input);

    const manifest = JSON.parse(await readFile(join(runsDir, "index.json"), "utf-8"));
    expect(manifest.print_id).toBe(result.print.print_id);
    expect(manifest.basket_version).toBe(result.print.version);
    expect(manifest.methodology_version).toBe(result.print.methodology_version);

    const expectedFiles = input.models
      .flatMap((m) => m.records.map((r) => `${r.run_id}.json`))
      .sort();
    expect(manifest.run_records).toEqual(expectedFiles);
  });

  it("does not write a manifest when runsDirPath is omitted", async () => {
    await publishPrint(dir, publishInput());
    const runsDir = join(dir, "runs");
    const exists = await access(runsDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("discloses prior failed attempts on a print that succeeds after them, signed as part of the body", async () => {
    const priorAttempts: PriorAttempt[] = [
      {
        attempted_at: "2026-08-27T00:33:11Z",
        reason: "only 3 of 6 registered models qualified (minimum 4)",
        qualifying_models: 3,
        registered_models: 6,
        cost_usd: "0.0621",
      },
    ];
    const result = await publishPrint(dir, publishInput({ priorAttempts }));
    expect(result.print.prior_attempts).toEqual(priorAttempts);

    const { verifyPrintSignature } = await import("./sign/sign.js");
    expect(verifyPrintSignature(result.print).valid).toBe(true);
  });

  it("omits prior_attempts entirely on a clean first-attempt print", async () => {
    const result = await publishPrint(dir, publishInput());
    expect(result.print.prior_attempts).toBeUndefined();
  });

  it("discloses constituent changes, signed as part of the body", async () => {
    const constituentChanges = [
      { model_id: "gpt-5.1", change: "admitted" as const },
      { model_id: "old-model", change: "removed" as const },
    ];
    const result = await publishPrint(dir, publishInput({ constituentChanges }));
    expect(result.print.constituent_changes).toEqual(constituentChanges);

    const { verifyPrintSignature } = await import("./sign/sign.js");
    expect(verifyPrintSignature(result.print).valid).toBe(true);
  });

  it("omits constituent_changes entirely when the registry is unchanged", async () => {
    const result = await publishPrint(dir, publishInput());
    expect(result.print.constituent_changes).toBeUndefined();
  });

  it("discloses which tier series a print is, signed as part of the body", async () => {
    const result = await publishPrint(dir, publishInput({ series: "commodity" }));
    expect(result.print.series).toBe("commodity");

    const { verifyPrintSignature } = await import("./sign/sign.js");
    expect(verifyPrintSignature(result.print).valid).toBe(true);
  });

  it("omits series entirely on the blended Dated SIU print", async () => {
    const result = await publishPrint(dir, publishInput());
    expect(result.print.series).toBeUndefined();
  });

  it("refuses to overwrite an existing run manifest for the same print_id", async () => {
    const runsDir = join(dir, "runs");
    const result = await publishPrint(dir, publishInput({ runsDirPath: runsDir }));

    // Matches writePrint's own append-only test shape: check the guard directly rather than
    // simulate a full second publish under the same print_id.
    await expect(writeRunManifest(runsDir, result.print, [])).rejects.toThrow(/already exists/);
  });
});

describe("computeConstituentChanges", () => {
  it("returns [] when there is no previous print (the very first print)", () => {
    expect(computeConstituentChanges(["a", "b"], undefined)).toEqual([]);
  });

  it("returns [] when the registry is unchanged from the previous print", () => {
    const previous = { basket_costs: [{ model_id: "a" }, { model_id: "b" }] };
    expect(computeConstituentChanges(["a", "b"], previous)).toEqual([]);
  });

  it("reports a new registry id as admitted", () => {
    const previous = { basket_costs: [{ model_id: "a" }] };
    expect(computeConstituentChanges(["a", "b"], previous)).toEqual([
      { model_id: "b", change: "admitted" },
    ]);
  });

  it("reports an id present in the previous print but absent from the registry as removed", () => {
    const previous = { basket_costs: [{ model_id: "a" }, { model_id: "b" }] };
    expect(computeConstituentChanges(["a"], previous)).toEqual([
      { model_id: "b", change: "removed" },
    ]);
  });

  it("does not confuse a per-print exclusion with a registry removal", () => {
    // "b" is excluded from the previous print's reference set (no cost_usd) but is still a
    // basket_costs entry — still in the registry, just not qualifying that day. Must not be
    // reported as removed just because it's excluded again.
    const previous = {
      basket_costs: [
        { model_id: "a", cost_usd: "0.01" },
        { model_id: "b", excluded_reason: "no run records" },
      ],
    };
    expect(computeConstituentChanges(["a", "b"], previous)).toEqual([]);
  });

  it("reports both admissions and removals together", () => {
    const previous = { basket_costs: [{ model_id: "old" }] };
    expect(computeConstituentChanges(["new"], previous)).toEqual([
      { model_id: "new", change: "admitted" },
      { model_id: "old", change: "removed" },
    ]);
  });
});
