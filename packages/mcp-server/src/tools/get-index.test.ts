import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { getIndexTool } from "./get-index.js";

function fixturePrint(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-14",
    date: "2026-08-14",
    status: "provisional",
    basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
    weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
    dated_siu: "0.0019",
    exchange_rate_table: [
      { model_id: "A", usd_per_siu: "0.0019", spread_to_index: "0", siu_per_usd: "526.3" },
    ],
    sensitivity_block: [{ policy_variant: "none", dated_siu: "0.0019", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "0.06",
    price_snapshot_ref: "snap-1.json",
    methodology_version: "v0-draft",
    signature: `0x${"ab".repeat(64)}`,
    public_key: `0x${"cd".repeat(33)}`,
    ...overrides,
  } as Print;
}

describe("getIndexTool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "touchstone-get-index-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("throws an honest error when no print has been published yet", async () => {
    await expect(getIndexTool({}, dir)).rejects.toThrow(/No print has been published/);
  });

  it("serves latest.json when no params are given", async () => {
    const print = fixturePrint({ print_id: "2026-08-15", date: "2026-08-15" });
    await writeFile(join(dir, "latest.json"), JSON.stringify(print));
    const result = await getIndexTool({}, dir);
    expect(result.print_id).toBe("2026-08-15");
  });

  it("serves a print by exact date", async () => {
    const print = fixturePrint({ print_id: "2026-08-13", date: "2026-08-13" });
    await writeFile(join(dir, "2026-08-13.json"), JSON.stringify(print));
    const result = await getIndexTool({ date: "2026-08-13" }, dir);
    expect(result.print_id).toBe("2026-08-13");
  });

  it("throws an honest error for a date with no print", async () => {
    await expect(getIndexTool({ date: "1999-01-01" }, dir)).rejects.toThrow(/No print for date/);
  });

  it("serves the newest print matching a requested version", async () => {
    await writeFile(
      join(dir, "2026-08-13.json"),
      JSON.stringify(
        fixturePrint({ version: "SIU-2026a", print_id: "2026-08-13", date: "2026-08-13" }),
      ),
    );
    await writeFile(
      join(dir, "2026-08-14.json"),
      JSON.stringify(
        fixturePrint({ version: "SIU-2026a", print_id: "2026-08-14", date: "2026-08-14" }),
      ),
    );
    const result = await getIndexTool({ version: "SIU-2026a" }, dir);
    expect(result.print_id).toBe("2026-08-14");
  });

  it("throws an honest error for a version with no print", async () => {
    await writeFile(join(dir, "2026-08-13.json"), JSON.stringify(fixturePrint()));
    await expect(getIndexTool({ version: "SIU-2099z" }, dir)).rejects.toThrow(
      /No print for version/,
    );
  });
});
