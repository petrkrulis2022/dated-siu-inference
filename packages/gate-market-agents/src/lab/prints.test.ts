import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { buildPrintPath, ceilingPrint, describeMove, moveTenthsOfPercent, printIdOfRound, printText, reachablePrints, stepDown, stepUp } from "./prints.js";

const P = 1_437_000n; // illustrative: the real print the lab started from on 2026-10-07

describe("the lab's scenario print (D41)", () => {
  it("steps up and down by the step, in integers, rounded down", () => {
    expect(stepUp(P, 1500)).toBe(1_652_550n); // 1.15 x
    expect(stepDown(P, 1500)).toBe(1_221_450n); // 0.85 x
    expect(stepUp(1_000_001n, 1500)).toBe(1_150_001n); // 1,150,001.15 rounded down
  });

  it("starts at the real print and moves by exactly the step every round, from the seed", () => {
    for (const seed of [1, 2, 3, 9, 77, 12345]) {
      const path = buildPrintPath(seed, P, DEFAULT_PARAMS, "real-print");
      expect(path.byRound).toHaveLength(DEFAULT_PARAMS.rounds);
      expect(path.byRound[0]).toBe(P);
      for (let r = 1; r < path.byRound.length; r++) {
        const prev = path.byRound[r - 1];
        expect([stepUp(prev, 1500), stepDown(prev, 1500)], `seed ${seed} round ${r + 1}`).toContain(path.byRound[r]);
      }
    }
  });

  it("is the same for the same seed and differs between seeds — a run is reproducible from its seed", () => {
    const a = buildPrintPath(9, P, DEFAULT_PARAMS, "x").byRound;
    expect(buildPrintPath(9, P, DEFAULT_PARAMS, "x").byRound).toEqual(a);
    const paths = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => buildPrintPath(s, P, DEFAULT_PARAMS, "x").byRound.join(",")));
    expect(paths.size).toBeGreaterThan(1);
  });

  it("goes up and down about equally often, so nothing in the scenario says which way it will go", () => {
    let up = 0;
    let down = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const path = buildPrintPath(seed, P, DEFAULT_PARAMS, "x").byRound;
      for (let r = 1; r < path.length; r++) {
        if (path[r] > path[r - 1]) up++;
        else down++;
      }
    }
    expect(up + down).toBe(800);
    expect(Math.abs(up - down)).toBeLessThan(100); // 400 each, give or take
  });

  it("keeps the print fixed when the step is zero, as through v5", () => {
    const fixed = buildPrintPath(5, P, { ...DEFAULT_PARAMS, printStepBps: 0 }, "x").byRound;
    expect(fixed).toEqual([P, P, P]);
  });

  it("refuses a step that is not a whole number of basis points below 100%", () => {
    for (const bad of [-1, 1.5, 10_000]) expect(() => buildPrintPath(1, P, { ...DEFAULT_PARAMS, printStepBps: bad }, "x")).toThrow(/printStepBps/);
  });

  it("names round 1's print by the real print's id and the others as scenario prints, which are not the published one", () => {
    const ids = buildPrintPath(1, P, DEFAULT_PARAMS, "2026-10-05-commodity").ids;
    expect(ids).toEqual(["2026-10-05-commodity", "lab-scenario-round-2", "lab-scenario-round-3"]);
    expect(printIdOfRound(1, "real")).toBe("real");
  });

  describe("what it can reach", () => {
    it("is every print on every path of three rounds, ascending, with the two ways to the middle meeting at one print", () => {
      // 1,437,000 x 1.15 = 1,652,550 and x 0.85 = 1,221,450; from there x 1.15 and x 0.85 again, each rounded down.
      expect(reachablePrints(P, DEFAULT_PARAMS)).toEqual([1_038_232n, 1_221_450n, 1_404_667n, 1_437_000n, 1_652_550n, 1_900_432n]);
    });

    it("includes every print a seeded path actually takes", () => {
      const reachable = new Set(reachablePrints(P, DEFAULT_PARAMS));
      for (let seed = 1; seed <= 200; seed++) for (const p of buildPrintPath(seed, P, DEFAULT_PARAMS, "x").byRound) expect(reachable.has(p), `seed ${seed}`).toBe(true);
    });

    it("has a ceiling the opening is sized at, and is just the start when the print is fixed", () => {
      expect(ceilingPrint(P, DEFAULT_PARAMS)).toBe(1_900_432n);
      expect(reachablePrints(P, { ...DEFAULT_PARAMS, printStepBps: 0 })).toEqual([P]);
    });

    it("grows with the number of rounds", () => {
      expect(ceilingPrint(P, { ...DEFAULT_PARAMS, rounds: 4 })).toBeGreaterThan(1_900_432n);
    });
  });

  describe("how it is shown", () => {
    it("states a move as a signed tenth of a percent, in integers", () => {
      expect(moveTenthsOfPercent(P, 1_652_550n)).toBe(150);
      expect(moveTenthsOfPercent(P, 1_221_450n)).toBe(-150);
      expect(moveTenthsOfPercent(P, P)).toBe(0);
      expect(moveTenthsOfPercent(1_652_550n, 1_900_432n)).toBe(150); // 14.99997%, to the nearest tenth
    });

    it("describes it as up, down or unchanged, to a tenth of a percent", () => {
      expect(describeMove(P, 1_652_550n)).toBe("up 15.0%");
      expect(describeMove(P, 1_221_450n)).toBe("down 15.0%");
      expect(describeMove(P, P)).toBe("unchanged");
      expect(describeMove(1_000_000n, 1_023_000n)).toBe("up 2.3%");
    });

    it("writes a print as the decimal USD per SIU an agent reads", () => {
      expect(printText(1_437_000n)).toBe("0.001437");
      expect(printText(1_652_550n)).toBe("0.00165255");
    });
  });
});
