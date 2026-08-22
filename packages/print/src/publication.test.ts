import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { buildPrintsIndex, writePrint, writePrintsIndex } from "./publication.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "touchstone-print-publication-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function print(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-14",
    date: "2026-08-14",
    status: "provisional",
    basket_costs: [{ model_id: "A", cost_usd: "0.01" }],
    weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
    dated_siu: "0.01",
    exchange_rate_table: [
      { model_id: "A", usd_per_siu: "0.01", spread_to_index: "0", siu_per_usd: "100" },
    ],
    sensitivity_block: [{ policy_variant: "none", dated_siu: "0.01", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "1.00",
    price_snapshot_ref: "snap-1",
    methodology_version: "v0",
    signature: "0xabc",
    public_key: "0xdef",
    ...overrides,
  } as Print;
}

describe("writePrint", () => {
  it("writes to data/prints/<print_id>.json and refreshes latest.json", async () => {
    const p = print();
    const { path, latestPath } = await writePrint(dir, p);
    expect(path).toBe(join(dir, "2026-08-14.json"));
    expect(JSON.parse(await readFile(path, "utf-8"))).toEqual(p);
    expect(JSON.parse(await readFile(latestPath, "utf-8"))).toEqual(p);
  });

  it("refuses to overwrite an existing print at that path, even a provisional one", async () => {
    await writePrint(dir, print({ status: "provisional", dated_siu: "0.01" }));
    await expect(writePrint(dir, print({ dated_siu: "0.02" }))).rejects.toThrow(
      /already exists.*append-only/s,
    );
    // And the original is untouched — provisional is "not yet reconciled," not "safe to destroy."
    const onDisk = JSON.parse(await readFile(join(dir, "2026-08-14.json"), "utf-8")) as Print;
    expect(onDisk.dated_siu).toBe("0.01");
  });

  it("refuses to overwrite an existing FINAL print at that path", async () => {
    await writePrint(dir, print({ status: "final" }));
    await expect(writePrint(dir, print({ dated_siu: "0.99" }))).rejects.toThrow(/already exists/);
    const onDisk = JSON.parse(await readFile(join(dir, "2026-08-14.json"), "utf-8")) as Print;
    expect(onDisk.dated_siu).toBe("0.01");
  });

  it("keys the filename by print_id, not date — two different print_ids sharing a date never collide", async () => {
    await writePrint(dir, print({ print_id: "2026-08-14", date: "2026-08-14", dated_siu: "0.01" }));
    // A same-day re-run under a different print_id — exactly the real incident this guards
    // against: writePrint used to key off `date`, so this second write silently clobbered the
    // first print's file even though the two are different prints with different identities.
    await writePrint(
      dir,
      print({ print_id: "2026-08-14b", date: "2026-08-14", dated_siu: "0.02" }),
    );

    const first = JSON.parse(await readFile(join(dir, "2026-08-14.json"), "utf-8")) as Print;
    const second = JSON.parse(await readFile(join(dir, "2026-08-14b.json"), "utf-8")) as Print;
    expect(first.dated_siu).toBe("0.01");
    expect(second.dated_siu).toBe("0.02");
  });

  it("latest.json always mirrors the most recently written print, even across different dates", async () => {
    await writePrint(dir, print({ print_id: "2026-08-14", date: "2026-08-14" }));
    await writePrint(dir, print({ print_id: "2026-08-15", date: "2026-08-15" }));
    const latest = JSON.parse(await readFile(join(dir, "latest.json"), "utf-8")) as Print;
    expect(latest.date).toBe("2026-08-15");
  });
});

describe("buildPrintsIndex / writePrintsIndex", () => {
  it("lists every print with date, status, and Dated SIU value, oldest first", async () => {
    await writePrint(dir, print({ print_id: "2026-08-15", date: "2026-08-15", dated_siu: "0.02" }));
    await writePrint(dir, print({ print_id: "2026-08-14", date: "2026-08-14", dated_siu: "0.01" }));

    const entries = await buildPrintsIndex(dir);
    expect(entries).toEqual([
      { print_id: "2026-08-14", date: "2026-08-14", status: "provisional", dated_siu: "0.01" },
      { print_id: "2026-08-15", date: "2026-08-15", status: "provisional", dated_siu: "0.02" },
    ]);
  });

  it("excludes latest.json and index.json from the index", async () => {
    await writePrint(dir, print());
    await writePrintsIndex(dir);
    const entries = await buildPrintsIndex(dir);
    expect(entries).toHaveLength(1);
  });

  it("writes index.json to disk", async () => {
    await writePrint(dir, print());
    const path = await writePrintsIndex(dir);
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].date).toBe("2026-08-14");
  });

  it("returns an empty list for an empty directory", async () => {
    expect(await buildPrintsIndex(dir)).toEqual([]);
  });
});
