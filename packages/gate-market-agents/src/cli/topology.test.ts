import { describe, expect, it } from "vitest";
import { checkAfterDrain, f1Clean, planDrain, readUntilStable } from "./topology.js";
import { assertSameInstrument, instrumentOf, parseInstrumentFlags } from "./instrument.js";
import { readFileSync } from "node:fs";

const DRAIN = { afterWindow: 1, issuer: "ISSUER-B", classId: "code", datedTo: "run_end" } as const;

describe("planDrain", () => {
  it("takes the issuer's entire remaining headroom after the configured window", () => {
    expect(planDrain(DRAIN, 1, 15_000n)).toEqual({ action: "drain", quantityMilliSiu: 15_000n });
  });

  it("does nothing in any other window", () => {
    for (const w of [2, 3]) expect(planDrain(DRAIN, w, 15_000n).action, `window ${w}`).toBe("none");
  });

  it("does nothing when there is nothing to take, and says why", () => {
    const plan = planDrain(DRAIN, 1, 0n);
    expect(plan).toEqual({ action: "none", reason: "the issuer's headroom is already zero" });
  });

  it("does nothing when no drain is configured — the fifth trio's behaviour, unchanged", () => {
    expect(planDrain(undefined, 1, 15_000n).action).toBe("none");
  });
});

describe("checkAfterDrain", () => {
  const ok = { drainIssuerHeadroom: 0n, routedTo: "0xAAA", expectedRoute: "0xaaa" };

  it("passes when the drained issuer is empty and the router picks the expected one", () => {
    expect(checkAfterDrain(ok)).toEqual({ ok: true });
  });

  it("fails if the drained issuer still has headroom", () => {
    const r = checkAfterDrain({ ...ok, drainIssuerHeadroom: 1n });
    expect(r.ok).toBe(false);
  });

  it("fails if the router would pick someone else, even with the headroom at zero", () => {
    // The stronger check: headroom 0 is an inference, the router's answer is the decision.
    const r = checkAfterDrain({ ...ok, routedTo: "0xBBB" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not 0xaaa/);
  });

  it("fails — and says it is NOT scarcity — if nobody can serve the next mint", () => {
    const r = checkAfterDrain({ ...ok, routedTo: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/must not be read as scarcity/);
  });

  it("compares addresses case-insensitively", () => {
    expect(checkAfterDrain({ ...ok, routedTo: "0xAbC", expectedRoute: "0xaBc" }).ok).toBe(true);
  });
});

describe("f1Clean", () => {
  it("is clean only when every mint was backed by the expected issuer", () => {
    expect(f1Clean([{ issuer: "0xB" }, { issuer: "0xb" }], "0xB")).toEqual({
      clean: true,
      mints: 2,
      backedByOthers: 0,
    });
  });

  it("is NOT clean when first-fit fell through to another issuer", () => {
    // The contamination this instrument exists to remove: 64.1% of agent mints before 2026-10-04
    // were backed by the issuer that cannot serve.
    const r = f1Clean([{ issuer: "0xB" }, { issuer: "0xA" }], "0xB");
    expect(r).toEqual({ clean: false, mints: 2, backedByOthers: 1 });
  });

  it("treats a mint of unknown backing as unclean rather than assuming it is fine", () => {
    expect(f1Clean([{}], "0xB").clean).toBe(false);
  });

  it("is vacuously clean with no mints, and reports that there were none", () => {
    // A window paid entirely in dollars exposes nobody to fSIU. Clean, but uninformative, and the
    // count says so.
    expect(f1Clean([], "0xB")).toEqual({ clean: true, mints: 0, backedByOthers: 0 });
  });
});

describe("instrument configuration", () => {
  const rec = (topology: unknown, id = "single-issuer-windows") =>
    ({ instrument: { id, description: "d" }, topology }) as unknown;
  const GOOD = {
    lotCreationOrder: ["ISSUER-B", "ISSUER-A"],
    expectedIssuerByWindow: { 1: "ISSUER-B", 2: "ISSUER-A", 3: "ISSUER-A" },
    drain: DRAIN,
    routeAfterDrain: "ISSUER-A",
  };

  it("a record with no instrument block is the fifth trio and changes nothing", () => {
    const spec = instrumentOf({});
    expect(spec.id).toBe("fifth-trio-two-issuer");
    expect(spec.topology).toBeUndefined();
  });

  it("reads a valid topology", () => {
    const spec = instrumentOf(rec(GOOD));
    expect(spec.topology?.lotCreationOrder).toEqual(["ISSUER-B", "ISSUER-A"]);
    expect(spec.topology?.expectedIssuerByWindow[2]).toBe("ISSUER-A");
  });

  it("names no issuer in code: the same logic runs with the roles swapped", () => {
    // "One issuer per window is configuration, never code." Swap which issuer serves first and the
    // same validator and the same planner run unchanged.
    const swapped = {
      lotCreationOrder: ["ISSUER-A", "ISSUER-B"],
      expectedIssuerByWindow: { 1: "ISSUER-A", 2: "ISSUER-B" },
      drain: { ...DRAIN, issuer: "ISSUER-A" as const },
      routeAfterDrain: "ISSUER-B",
    };
    expect(instrumentOf(rec(swapped)).topology?.drain?.issuer).toBe("ISSUER-A");
    expect(planDrain(swapped.drain, 1, 5n).action).toBe("drain");
  });

  it("refuses a drain that asserts nothing afterwards", () => {
    const noRoute: Record<string, unknown> = { ...GOOD };
    delete noRoute.routeAfterDrain;
    expect(() => instrumentOf(rec(noRoute))).toThrow(/requires routeAfterDrain/);
  });

  it("refuses a drain whose expected route is the drained issuer itself", () => {
    expect(() => instrumentOf(rec({ ...GOOD, routeAfterDrain: "ISSUER-B" }))).toThrow(/different issuer/);
  });

  it("refuses issuers that are not in the registration order", () => {
    expect(() =>
      instrumentOf(rec({ ...GOOD, expectedIssuerByWindow: { 1: "ISSUER-X" } })),
    ).toThrow(/not in lotCreationOrder/);
    expect(() => instrumentOf(rec({ ...GOOD, drain: { ...DRAIN, issuer: "ISSUER-X" } }))).toThrow();
  });

  it("refuses a duplicated or empty registration order", () => {
    expect(() => instrumentOf(rec({ ...GOOD, lotCreationOrder: [] }))).toThrow(/each issuer once/);
    expect(() =>
      instrumentOf(rec({ ...GOOD, lotCreationOrder: ["ISSUER-A", "ISSUER-A"] })),
    ).toThrow(/each issuer once/);
  });

  it("parses --deployment, defaulting to the fifth trio's record", () => {
    expect(parseInstrumentFlags([]).deploymentFile).toBe("data/deployments/base-sepolia-gate-market.json");
    expect(parseInstrumentFlags(["--deployment", "x.json"]).deploymentFile).toBe("x.json");
    expect(() => parseInstrumentFlags(["--deployment"])).toThrow(/expects a path/);
    expect(() => parseInstrumentFlags(["--deployment", "--debug"])).toThrow(/expects a path/);
  });

  it("refuses to pool runs from different instruments", () => {
    expect(() =>
      assertSameInstrument([
        { runId: "a", instrument: { id: "single-issuer-windows" } },
        { runId: "b" }, // predates the field: the fifth trio
      ]),
    ).toThrow(/cannot be pooled/);
    expect(assertSameInstrument([{ runId: "a" }, { runId: "b" }])).toBe("fifth-trio-two-issuer");
  });
});

describe("the multi-issuer path is intact", () => {
  // The written constraint (plan §7): nothing supporting several issuers per class may be deleted,
  // simplified or hardcoded. This reads the source rather than trusting a reviewer's memory.
  const src = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");

  it("the topology and instrument modules name no issuer", () => {
    for (const f of ["./topology.ts", "./instrument.ts"]) {
      const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/ISSUER-[AB]/);
    }
  });

  it("the router still iterates issuersForClass rather than being replaced by a single address", () => {
    const router = readFileSync(
      new URL("../../../contracts/src/ClaimRouter.sol", import.meta.url),
      "utf-8",
    );
    expect(router).toMatch(/issuersForClass/);
    expect(router).toMatch(/for \(uint256 i = 0; i < candidates\.length; i\+\+\)/);
  });

  it("token ids still carry the issuer", () => {
    const wc = readFileSync(new URL("../../../contracts/src/WorkClaim.sol", import.meta.url), "utf-8");
    expect(wc).toMatch(/function tokenIdFor\(\s*address issuer,/);
  });
});


describe("readUntilStable", () => {
  const noSleep = async () => {};

  it("returns as soon as two consecutive reads agree", async () => {
    const seen = [15_000n, 15_000n];
    expect(await readUntilStable(async () => seen.shift() as bigint, { sleep: noSleep })).toBe(15_000n);
  });

  it("does NOT trust a stale-high read that is followed by a lower one", async () => {
    // The failure it exists for: the first read shows capacity that is already consumed. Sizing a
    // drain from 32,000 when the truth is 15,000 would make first-fit skip the drained issuer and
    // mint against the other one.
    const seen = [32_000n, 15_000n, 15_000n];
    expect(await readUntilStable(async () => seen.shift() as bigint, { sleep: noSleep })).toBe(15_000n);
  });

  it("throws, rather than returning a figure, when it never settles", async () => {
    let n = 0n;
    await expect(
      readUntilStable(async () => n++, { attempts: 4, sleep: noSleep }),
    ).rejects.toThrow(/did not settle across 4 reads/);
  });

  it("waits between reads, but not after the last one", async () => {
    const waits: number[] = [];
    let n = 0n;
    await expect(
      readUntilStable(async () => n++, {
        attempts: 3,
        delayMs: 7,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).rejects.toThrow();
    expect(waits).toEqual([7, 7]);
  });
});
