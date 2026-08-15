import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttestationClient, AnchorResult } from "./anchor/attestation.js";
import { findInvalidRecords, publishPrint, type PublishInput } from "./publish.js";
import { workedExampleInput, publishableWorkedExampleInput } from "./worked-example.fixture.js";

const TEST_KEY = `0x${"55".repeat(32)}`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "datum-print-publish-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function publishInput(overrides: Partial<PublishInput> = {}): PublishInput {
  const rest = Object.fromEntries(
    Object.entries(publishableWorkedExampleInput()).filter(([key]) => key !== "status"),
  ) as PublishInput;
  return { ...rest, privateKeyHex: TEST_KEY, ...overrides };
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
    const input = { ...workedExampleInput(), privateKeyHex: TEST_KEY } as PublishInput;
    await expect(publishPrint(dir, input)).rejects.toThrow(/Refusing to sign/);
  });
});
