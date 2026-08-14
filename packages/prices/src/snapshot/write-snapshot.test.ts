import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceSnapshot } from "@datum/sdk";
import { snapshotFileName, writeSnapshot } from "./write-snapshot.js";

const validSnapshot: PriceSnapshot = {
  snapshot_id: "2026-08-14T00:00:00.000Z",
  timestamp: "2026-08-14T00:00:00.000Z",
  source: "openrouter",
  entries: [{ model_id: "test-model", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" }],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "datum-prices-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeSnapshot", () => {
  it("writes a valid snapshot to the expected filename", async () => {
    const path = await writeSnapshot(dir, validSnapshot);
    expect(path).toBe(join(dir, snapshotFileName(validSnapshot)));
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    expect(onDisk).toEqual(validSnapshot);
  });

  it("refuses to overwrite an existing snapshot (immutability)", async () => {
    await writeSnapshot(dir, validSnapshot);
    await expect(writeSnapshot(dir, validSnapshot)).rejects.toThrow(/overwrite/i);
  });

  it("refuses to write a snapshot that fails schema validation", async () => {
    const invalid = { ...validSnapshot, entries: [] } as unknown as PriceSnapshot;
    await expect(writeSnapshot(dir, invalid)).rejects.toThrow(/invalid/i);
  });
});
