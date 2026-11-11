import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadParams, type EconomyParams } from "../economy/params.js";
import { loadCrPrint } from "../economy/runner.js";
import { CR_PUBLIC_DIR } from "../paths.js";
import { buildRoster } from "./roster.js";

/** the roster now runs genesis itself (v3a Phase 2 item 6), which needs real issuers: the frozen v2 set */
const V2_ISSUERS = loadParams(join(CR_PUBLIC_DIR, "economy-params.v2.json")).issuers;
const roster = (p: EconomyParams, seed: string): ReturnType<typeof buildRoster> => buildRoster(p, seed, loadCrPrint());

function params(): EconomyParams {
  return {
    status: "test fixture",
    secondsPerWindow: 86400,
    roundsPerWindow: 8,
    ladderWindows: 3,
    reserve: {
      series: "commodity",
      faceMilliPerWindow: 3_000n,
      minTenorSeconds: 43200,
      discountBps: 1_000n,
      bufferSeedUsdc: 500_000n,
      bufferTargetUsdc: 500_000n,
    },
    participant: { usdc: 2_000_000n, spreadBps: 200n, buybackCapBps: 1_000n },
    issuers: V2_ISSUERS,
    deliveryFloorBps: 8_000n,
    deliveryTrailingWindows: 5,
    probeShareBps: 500n,
    probesToClear: 3,
    dataShadowPriceUsdc: 1_000n,
    briefMarkupBps: 12_000n,
    agents: { research: ["RESEARCH-1", "RESEARCH-2"], demand: ["DEMAND-1", "DEMAND-2", "DEMAND-3"], hedger: "HEDGER" },
    mandates: {
      "DEMAND-1": { usdc: 100_000n, spendLimitAguPerWindow: 2_000_000n, holdingCeilingDays: 3, minUsdcBuffer: 16_666n, sweepDays: [7, 14] },
      "DEMAND-2": { usdc: 100_000n, spendLimitAguPerWindow: 2_000_000n, holdingCeilingDays: 3, minUsdcBuffer: 16_666n, sweepDays: [7, 14] },
      "DEMAND-3": { usdc: 100_000n, spendLimitAguPerWindow: 2_000_000n, holdingCeilingDays: 3, minUsdcBuffer: 16_666n, sweepDays: [7, 14] },
    },
    researchUsdc: 50_000n,
    hedger: { usdc: 100_000n, briefsSold: 10, priceUsdcPerBrief: 50_000n },
    needsPerDemandAgentPerWindow: 1,
    mirroredShareBps: 1_000n,
    spendCapUsdPerWindow: new D("1.50"),
    seed: "dev-0",
    counted: {
      days: ["2026-10-29", "2026-10-30", "2026-11-01"],
      seats: ["claude-sonnet-5", "gpt-5.1"],
      settlement: "test",
      redemptionIsFinding: true,
    },
  };
}

describe("buildRoster", () => {
  it("returns exactly seven entries: 2 research, 3 demand, 1 hedger, 1 participant", () => {
    const r = roster(params(), "counted-2026-11-06");
    expect(r.agents).toHaveLength(7);
    expect(r.agents.filter((a) => a.role === "research").map((a) => a.id)).toEqual(["RESEARCH-1", "RESEARCH-2"]);
    expect(r.agents.filter((a) => a.role === "demand").map((a) => a.id)).toEqual(["DEMAND-1", "DEMAND-2", "DEMAND-3"]);
    expect(r.agents.filter((a) => a.role === "hedger").map((a) => a.id)).toEqual(["HEDGER"]);
    expect(r.agents.filter((a) => a.role === "participant").map((a) => a.id)).toEqual(["PARTICIPANT"]);
  });

  // v3a Phase 2 item 6: this asserted the params file's raw numbers ("never AGU-lab at genesis", the hedger at 0.10 USDC), which is the bug the code check found; the
  // wallets are now what genesis itself leaves
  it("reports each agent's starting wallet as genesis leaves it: research and demand in USDC only, the hedger split across both, the participant holding what it created", () => {
    const r = roster(params(), "counted-2026-11-06");
    const byId = new Map(r.agents.map((a) => [a.id, a]));
    expect(byId.get("RESEARCH-1")?.startingUsdc).toBe("0.050000");
    expect(byId.get("RESEARCH-1")?.startingAgu).toBe("0.000000");
    expect(byId.get("DEMAND-2")?.startingUsdc).toBe("0.100000");
    expect(byId.get("DEMAND-2")?.startingAgu).toBe("0.000000");
    expect(byId.get("HEDGER")?.startingUsdc).toBe("0.050000");
    expect(Number(byId.get("HEDGER")?.startingAgu)).toBeGreaterThan(0);
    expect(Number(byId.get("PARTICIPANT")?.startingAgu)).toBeGreaterThan(0);
  });

  it("rotates the seat schedule through counted.seats by window, matching economy-window.ts's own rotation", () => {
    const r = roster(params(), "counted-2026-11-06");
    expect(r.seatSchedule.map((s) => s.model)).toEqual(["claude-sonnet-5", "gpt-5.1", "claude-sonnet-5"]);
  });

  it("uses the SEED PASSED IN, never the params file's own seed field (the exact mistake D133 found in the scorer)", () => {
    const withRealSeed = roster(params(), "counted-2026-11-06");
    const withParamsDefaultSeed = roster(params(), "dev-0");
    const needs = (r: ReturnType<typeof roster>): string =>
      r.agents
        .flatMap((a) => a.needsByWindow ?? [])
        .map((n) => n.tasks.join(","))
        .join("|");
    expect(needs(withRealSeed)).not.toBe(needs(withParamsDefaultSeed));
  });

  it("gives every demand agent one real need per window, for every counted day", () => {
    const r = roster(params(), "counted-2026-11-06");
    const demand1 = r.agents.find((a) => a.id === "DEMAND-1");
    expect(demand1?.needsByWindow).toHaveLength(3);
    for (const n of demand1?.needsByWindow ?? []) {
      expect(n.tasks).toHaveLength(2);
      expect(new Set(n.tasks).size).toBe(2); // two DISTINCT task types, as the brief requires
    }
  });

  it("carries the hedger's narrative price-per-brief and flags it as never a real transaction", () => {
    const r = roster(params(), "counted-2026-11-06");
    const hedger = r.agents.find((a) => a.id === "HEDGER");
    expect(hedger?.hedger).toEqual({ briefsSold: 10, priceUsdcPerBriefNarrativeOnly: "0.050000" });
  });
});
