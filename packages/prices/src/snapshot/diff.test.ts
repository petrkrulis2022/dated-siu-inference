import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PriceSnapshot } from "@touchstone/sdk";
import { writeSnapshot } from "./write-snapshot.js";
import { diffLatestSnapshots } from "./diff.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "touchstone-prices-diff-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function snapshot(timestamp: string, entries: PriceSnapshot["entries"]): PriceSnapshot {
  return { snapshot_id: timestamp, timestamp, source: "openrouter", entries };
}

describe("diffLatestSnapshots", () => {
  it("returns null when fewer than two snapshots exist", async () => {
    await writeSnapshot(
      dir,
      snapshot("2026-08-14T00:00:00.000Z", [
        { model_id: "m1", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" },
      ]),
    );
    expect(await diffLatestSnapshots(dir, "openrouter")).toBeNull();
  });

  it("detects a price change, an addition, and a removal between the two most recent snapshots", async () => {
    await writeSnapshot(
      dir,
      snapshot("2026-08-14T00:00:00.000Z", [
        { model_id: "m1", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" },
        { model_id: "m2", price_in_usd_per_1m: "3.00", price_out_usd_per_1m: "4.00" },
      ]),
    );
    await writeSnapshot(
      dir,
      snapshot("2026-08-14T01:00:00.000Z", [
        { model_id: "m1", price_in_usd_per_1m: "1.50", price_out_usd_per_1m: "2.00" },
        { model_id: "m3", price_in_usd_per_1m: "5.00", price_out_usd_per_1m: "6.00" },
      ]),
    );

    const diff = await diffLatestSnapshots(dir, "openrouter");
    expect(diff).not.toBeNull();
    expect(diff!.changes).toEqual([
      { model_id: "m1", field: "price_in_usd_per_1m", from: "1.00", to: "1.50" },
    ]);
    expect(diff!.added).toEqual(["m3"]);
    expect(diff!.removed).toEqual(["m2"]);
  });
});
