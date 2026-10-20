import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D, roundHalfUp } from "@touchstone/sdk";
import { addDays, monthsOf } from "../data-desk/dates.js";
import { CHAINS, FIXTURE_AS_OF } from "../data-desk/fixtures/world.js";
import type { DayData } from "./day-data.js";
import { fixtureDay, type FixtureDay } from "./fixture-day.js";
import { plQuarters, solvePL, solveSM, solveUO, solveVS, vsEndMonths } from "./solve.js";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());
const W = FIXTURE_AS_OF;
const r6 = (x: InstanceType<typeof D>) => roundHalfUp(x, 6);

/** A copy of the day with `mutate` applied to deep copies of the maps it touches. */
function changed(mutate: (d: DayData) => void): DayData {
  const copy: DayData = {
    ...f.day,
    perp: new Map([...f.day.perp].map(([k, v]) => [k, new Map(v)])),
    lending: new Map([...f.day.lending].map(([k, v]) => [k, new Map(v)])),
    schedules: new Map([...f.day.schedules].map(([k, v]) => [k, { ...v, days: [...v.days] }])),
    supply: new Map([...f.day.supply].map(([k, v]) => [k, new Map(v)])),
    stablecoins: {
      chain: new Map(f.day.stablecoins.chain),
      issuer: new Map(f.day.stablecoins.issuer),
    },
  };
  mutate(copy);
  return copy;
}

describe("the end months a CR-VS question can ask for", () => {
  it("are the last complete month and the five before it", () => {
    expect(vsEndMonths("2026-10-20")).toEqual([
      "2026-10-01",
      "2026-09-01",
      "2026-08-01",
      "2026-07-01",
      "2026-06-01",
      "2026-05-01",
    ]);
  });
});

describe("solveVS: perp venue volume share", () => {
  for (const endMonth of ["2026-10-01", "2026-07-01"]) {
    it(`matches an independent computation from the fixture world, for a window ending ${endMonth}`, () => {
      const ref = solveVS(f.day, endMonth)!;
      // independent: sum each venue's daily volume straight from the world generator
      const months = monthsOf(addDays(endMonth, -366).slice(0, 8) + "01", endMonth).slice(-12);
      const sums = f.world.venues.map((v) => ({
        id: v.id,
        perMonth: months.map((m) => {
          let s = new D(0);
          for (let d = m.start; d < m.end; d = addDays(d, 1)) {
            const x = f.world.perpPoint(v, d)?.v.volumeUSD;
            if (x !== null && x !== undefined) s = s.plus(x);
          }
          return s;
        }),
      }));
      const ranked = sums
        .map((s) => ({ ...s, total: s.perMonth.reduce((a, b) => a.plus(b), new D(0)) }))
        .sort((a, b) => b.total.comparedTo(a.total) || a.id.localeCompare(b.id));
      const top = ranked.slice(0, 5);
      expect(ref.months).toEqual(months.map((m) => m.month));
      expect(ref.venues).toEqual(top.map((t) => t.id));
      months.forEach((m, i) => {
        const denom = top.reduce((a, t) => a.plus(t.perMonth[i]!), new D(0));
        for (const t of top)
          expect(ref.shares[m.month]![t.id], `${m.month} ${t.id}`).toBe(
            r6(t.perMonth[i]!.div(denom).times(100)),
          );
      });
    });
  }

  it("gives shares that add up to 100 each month, to the rounding of six decimals", () => {
    const ref = solveVS(f.day, "2026-10-01")!;
    for (const m of ref.months) {
      const total = Object.values(ref.shares[m]!).reduce((a, s) => a.plus(s), new D(0));
      expect(total.minus(100).abs().lte("0.000003")).toBe(true);
    }
  });

  it("skips a day the source holds as null, rather than reading it as zero", () => {
    const nullDay = addDays(W, -100);
    const patched = changed((d) =>
      d.perp.get("fixture-perp-c")!.set(nullDay, new D("99999999999")),
    );
    const a = solveVS(f.day, "2026-10-01")!;
    const b = solveVS(patched, "2026-10-01")!;
    expect(a.shares["2026-07"]).not.toEqual(b.shares["2026-07"]); // a real figure for that day changes July, so the null really was skipped
  });

  it("returns undefined with fewer than five venues, or when a month has no volume at all", () => {
    expect(
      solveVS(
        changed((d) => [...d.perp.keys()].slice(0, 4).forEach((k) => d.perp.delete(k))),
        "2026-10-01",
      ),
    ).toBeUndefined();
    expect(
      solveVS(
        changed((d) => d.perp.clear()),
        "2026-10-01",
      ),
    ).toBeUndefined();
    const zeroMonth = changed((d) => {
      for (const m of d.perp.values())
        for (const day of [...m.keys()]) if (day.startsWith("2026-08")) m.set(day, null);
    });
    expect(solveVS(zeroMonth, "2026-10-01")).toBeUndefined();
  });

  it("breaks a tie in twelve-month volume by venue id", () => {
    const same = changed((d) => {
      for (const id of ["fixture-perp-b", "fixture-perp-c"])
        d.perp.set(id, new Map(d.perp.get("fixture-perp-a")!));
    });
    const ref = solveVS(same, "2026-10-01")!;
    expect(ref.venues.slice(0, 3)).toEqual(["fixture-perp-a", "fixture-perp-b", "fixture-perp-c"]);
  });
});

describe("plQuarters", () => {
  it("are the last four complete quarters, newest first, as half-open windows", () => {
    expect(plQuarters("2026-10-20")).toEqual([
      { label: "2026-Q3", start: "2026-07-01", end: "2026-10-01" },
      { label: "2026-Q2", start: "2026-04-01", end: "2026-07-01" },
      { label: "2026-Q1", start: "2026-01-01", end: "2026-04-01" },
      { label: "2025-Q4", start: "2025-10-01", end: "2026-01-01" },
    ]);
    expect(plQuarters("2026-01-05")[0]).toEqual({
      label: "2025-Q4",
      start: "2025-10-01",
      end: "2026-01-01",
    });
  });
});

describe("solvePL: protocol P&L", () => {
  const q = plQuarters(W)[0]!;
  it("sums the quarter's days and defines the payout as interest minus net interest income (D89), matching the fixture world", () => {
    for (const p of f.world.lending.slice(0, 3)) {
      let fees = new D(0),
        revenue = new D(0),
        interest = new D(0),
        nii = new D(0);
      for (let d = q.start; d < q.end; d = addDays(d, 1)) {
        const v = f.world.lendingPoint(p, d).v;
        fees = fees.plus(v["fees-usd"]!);
        revenue = revenue.plus(v["revenue-usd"]!);
        interest = interest.plus(v["interest-usd"]!);
        nii = nii.plus(v["net-interest-income-usd"]!);
      }
      expect(solvePL(f.day, p.id, q)).toEqual({
        fees: r6(fees),
        payouts: r6(interest.minus(nii)),
        revenue: r6(revenue),
      });
    }
  });

  it("agrees with itself: fees minus payouts is revenue, to the rounding of the sums", () => {
    const ref = solvePL(f.day, "fixture-lend-1", q)!;
    expect(new D(ref.fees).minus(ref.payouts).minus(ref.revenue).abs().lte("0.000002")).toBe(true);
  });

  it("is not offered when any day is missing or any figure is null", () => {
    const gapDay = addDays(q.start, 40);
    expect(
      solvePL(
        changed((d) => d.lending.get("fixture-lend-1")!.delete(gapDay)),
        "fixture-lend-1",
        q,
      ),
    ).toBeUndefined();
    const nulled = changed((d) =>
      d.lending
        .get("fixture-lend-1")!
        .set(gapDay, { ...d.lending.get("fixture-lend-1")!.get(gapDay)!, nii: null }),
    );
    expect(solvePL(nulled, "fixture-lend-1", q)).toBeUndefined();
    expect(solvePL(f.day, "no-such-protocol", q)).toBeUndefined();
  });

  it("is not offered for a quarter the data does not cover", () => {
    expect(
      solvePL(f.day, "fixture-lend-1", { start: "2024-01-01", end: "2024-04-01" }),
    ).toBeUndefined();
  });
});

describe("solveUO: unlock overhang", () => {
  const slug = (): string => [...f.day.schedules.keys()][0]!;
  const token = () => f.world.tokens.find((t) => t.slug === slug())!;

  it("sums the next 30 and 90 daily snapshots, beginning with the snapshot day, over the circulating supply on that day", () => {
    const t = token();
    const sum = (n: number) => {
      let s = 0n;
      for (let i = 0; i < n; i++) s += f.world.unlockedOn(t, addDays(W, i));
      return new D(s.toString()).div(1_000_000); // millionths of a token to tokens
    };
    const supply = new D(f.world.circulatingAt(t, W).toString()).div(1_000_000);
    expect(solveUO(f.day, slug())).toEqual({
      unlock30Pct: r6(sum(30).div(supply).times(100)),
      unlock90Pct: r6(sum(90).div(supply).times(100)),
      unlock30Tokens: r6(sum(30)),
      unlock90Tokens: r6(sum(90)),
      circulating: r6(supply),
      supplyDay: W,
    });
  });

  it("never reports fewer tokens unlocking in 90 days than in 30", () => {
    for (const s of f.day.schedules.keys()) {
      const r = solveUO(f.day, s);
      if (r !== undefined) expect(new D(r.unlock90Tokens).gte(r.unlock30Tokens)).toBe(true);
    }
  });

  it("is not offered when the schedule is short, starts on another day, or the supply is missing or zero", () => {
    expect(
      solveUO(
        changed((d) => {
          const s = d.schedules.get(slug())!;
          s.days = s.days.slice(0, 80);
        }),
        slug(),
      ),
    ).toBeUndefined();
    expect(
      solveUO(
        changed((d) => {
          const s = d.schedules.get(slug())!;
          s.days = s.days.slice(1);
        }),
        slug(),
      ),
    ).toBeUndefined();
    const id = f.day.tokenIds.get(slug())!;
    // a null at the snapshot day, with nothing earlier, is a missing figure and never a zero
    expect(
      solveUO(
        changed((d) => {
          const m = d.supply.get(id)!;
          m.clear();
          m.set(W, null);
        }),
        slug(),
      ),
    ).toBeUndefined();
    expect(
      solveUO(
        changed((d) => d.supply.get(id)!.set(W, new D(0))),
        slug(),
      ),
    ).toBeUndefined();
    expect(
      solveUO(
        changed((d) => d.supply.delete(id)),
        slug(),
      ),
    ).toBeUndefined();
    expect(solveUO(f.day, "no-such-token")).toBeUndefined();
  });
});

describe("solveUO when the provider has not yet published the snapshot day's supply", () => {
  const slug = (): string => [...f.day.schedules.keys()][0]!;
  const id = (): string => f.day.tokenIds.get(slug())!;
  /** the same supply figure, but published only on the day `daysBack` days before the snapshot day (the fixture also holds the day before, so the series is cleared first) */
  const lagged = (daysBack: number): DayData =>
    changed((d) => {
      const m = d.supply.get(id())!;
      const v = m.get(W)!;
      m.clear();
      m.set(addDays(W, -daysBack), v);
    });

  it("uses the latest day published, up to three days back, and says which day it is", () => {
    const ref = solveUO(f.day, slug())!;
    for (const k of [1, 2, 3]) {
      const r = solveUO(lagged(k), slug());
      expect(r?.supplyDay, `${k} days back`).toBe(addDays(W, -k));
      // the same figure on an earlier day gives the same answer: only the date it is as of changes
      expect(r?.unlock30Pct).toBe(ref.unlock30Pct);
      expect(r?.circulating).toBe(ref.circulating);
    }
  });

  it("prefers the snapshot day itself when it is there, and the latest of several earlier days", () => {
    expect(solveUO(f.day, slug())?.supplyDay).toBe(W);
    const both = changed((d) => {
      const m = d.supply.get(id())!;
      const v = m.get(W)!;
      m.clear();
      m.set(addDays(W, -1), v);
      m.set(addDays(W, -3), v.times(2));
    });
    expect(solveUO(both, slug())?.supplyDay).toBe(addDays(W, -1));
  });

  it("is not offered when the only figure is older than three days", () => {
    expect(solveUO(lagged(4), slug())).toBeUndefined();
  });

  it("skips a null on the latest day and uses the day before, never reading a null as zero", () => {
    const d = changed((x) => {
      const m = x.supply.get(id())!;
      const v = m.get(W)!;
      m.clear();
      m.set(W, null);
      m.set(addDays(W, -2), v);
    });
    expect(solveUO(d, slug())?.supplyDay).toBe(addDays(W, -2));
  });
});

describe("solveSM: stablecoin movers", () => {
  it("ranks chains by absolute change in USD supply over 90 days, signed, matching the fixture world", () => {
    const start = addDays(W, -90);
    const rows = CHAINS.map((c) => ({
      id: c as string,
      change: new D(f.world.chainPoint(c, W)!.v.circulatingSupplyUSD!).minus(
        f.world.chainPoint(c, start)!.v.circulatingSupplyUSD!,
      ),
    }));
    rows.sort((a, b) => b.change.abs().comparedTo(a.change.abs()) || a.id.localeCompare(b.id));
    expect(solveSM(f.day, "chain")).toEqual({
      dimension: "chain",
      top5: rows.slice(0, 5).map((r) => ({ id: r.id, changeUsd: r6(r.change) })),
    });
  });

  it("gives five entries in non-increasing order of absolute change, for chains and for issuers", () => {
    for (const dim of ["chain", "issuer"] as const) {
      const ref = solveSM(f.day, dim)!;
      expect(ref.top5).toHaveLength(5);
      const abs = ref.top5.map((r) => new D(r.changeUsd).abs());
      for (let i = 1; i < 5; i++) expect(abs[i - 1]!.gte(abs[i]!)).toBe(true);
    }
  });

  it("keeps the sign of a fall", () => {
    const ref = solveSM(
      changed((d) => {
        const b = d.stablecoins.chain.get("fixture-chain-a")!;
        d.stablecoins.chain.set("fixture-chain-a", {
          first: { day: b.first.day, usd: new D("1000000000000") },
          last: { day: b.last.day, usd: new D("1") },
        });
      }),
      "chain",
    )!;
    expect(ref.top5[0]).toEqual({ id: "fixture-chain-a", changeUsd: "-999999999999.000000" });
  });

  it("ignores a series with a missing end or the wrong dates, and needs five that remain", () => {
    expect(
      solveSM(
        changed((d) =>
          d.stablecoins.chain.set("fixture-chain-a", {
            ...d.stablecoins.chain.get("fixture-chain-a")!,
            last: { day: W, usd: null },
          }),
        ),
        "chain",
      )!.top5.map((r) => r.id),
    ).not.toContain("fixture-chain-a");
    expect(
      solveSM(
        changed((d) =>
          [...d.stablecoins.chain.keys()].slice(0, 3).forEach((k) => d.stablecoins.chain.delete(k)),
        ),
        "chain",
      ),
    ).toBeUndefined();
    expect(
      solveSM(
        changed((d) => {
          for (const [k, b] of d.stablecoins.issuer)
            d.stablecoins.issuer.set(k, {
              ...b,
              first: { ...b.first, day: addDays(b.first.day, 1) },
            });
        }),
        "issuer",
      ),
    ).toBeUndefined();
  });
});
