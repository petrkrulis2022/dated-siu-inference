import { describe, expect, it } from "vitest";
import { SeedStream } from "../tasks/seeds.js";
import { dailyVolatility, pricePath, pricePathSeedHash, shockPpm, type PricePathSpec } from "./price-path.js";

const spec = (over: Partial<PricePathSpec> = {}): PricePathSpec => ({
  seed: "path-test",
  volPpm: 50_000n,
  classNoisePpm: 3_000n,
  burnIn: 15,
  windows: 8,
  start: { commodity: 13_163_480n, frontier: 380_442_167n },
  classes: ["CR-PL", "CR-UO", "CR-SM", "CR-VS"],
  ...over,
});

describe("v3a seeded print path", () => {
  it("is fixed by its seed: the same seed gives the same path, another seed another", () => {
    expect(pricePath(spec())).toEqual(pricePath(spec()));
    expect(pricePath(spec({ seed: "other" }))).not.toEqual(pricePath(spec()));
    expect(pricePathSeedHash("a")).not.toBe(pricePathSeedHash("b"));
  });

  it("has a burn-in of 15 simulated prints ending at the opening print (window 0), then one print per window", () => {
    const p = pricePath(spec());
    expect(p.map((x) => x.window)).toEqual(Array.from({ length: 23 }, (_, i) => i - 14));
    expect(p.filter((x) => x.simulated)).toHaveLength(15);
    expect(p[0]?.rates).toEqual({ commodity: 13_163_480n, frontier: 380_442_167n });
    expect(p[0]?.classPpm["CR-PL"]).toBe(1_000_000n);
  });

  it("moves the Commodity and Frontier prints by the same factor every window", () => {
    for (const x of pricePath(spec())) {
      const ratio = (x.rates.frontier * 1_000_000n) / x.rates.commodity;
      expect(Number(ratio - (380_442_167n * 1_000_000n) / 13_163_480n)).toBeLessThan(2_000); // equal up to integer rounding
    }
  });

  it("draws zero-mean moves with the stated standard deviation, never beyond six of them", () => {
    const s = new SeedStream("moments", "x");
    const n = 20_000;
    let sum = 0n;
    let sumSq = 0n;
    let maxAbs = 0n;
    for (let i = 0; i < n; i++) {
      const e = shockPpm(s, 10_000n);
      sum += e;
      sumSq += e * e;
      if ((e < 0n ? -e : e) > maxAbs) maxAbs = e < 0n ? -e : e;
    }
    const mean = Number(sum) / n;
    const sd = Math.sqrt(Number(sumSq) / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(150); // 1.5% of one sd: zero drift within sampling error (sd / sqrt(n) is about 71)
    expect(sd).toBeGreaterThan(9_800);
    expect(sd).toBeLessThan(10_200);
    expect(maxAbs).toBeLessThanOrEqual(60_000n);
  });

  it("measures a real series' daily volatility over consecutive calendar days only", () => {
    const v = dailyVolatility([
      { date: "2026-10-01", datedSiu: "0.0100" },
      { date: "2026-10-02", datedSiu: "0.0101" },
      { date: "2026-10-03", datedSiu: "0.0100" },
      { date: "2026-10-05", datedSiu: "0.0200" }, // a gap: the jump is never counted as a one-day move
      { date: "2026-10-06", datedSiu: "0.0202" },
    ]);
    expect(v.pairs).toBe(3);
    expect(v.maxMove.date).toBe("2026-10-02");
    // moves +1%, -0.990099%, +1%: sample sd of those three
    expect(Number(v.sdPpm)).toBeGreaterThan(11_400);
    expect(Number(v.sdPpm)).toBeLessThan(11_500);
  });
});
