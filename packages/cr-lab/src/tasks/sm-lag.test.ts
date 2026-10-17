/**
 * CR-SM and the one-day publication lag. On the first live day (2026-10-17) every stablecoin series ended on the 16th, not the 17th, and the solver, which wanted the snapshot day itself,
 * offered no question at all. The end date is now the latest day the series reaches (the snapshot day or the day before), and the prompt and the key use the same dates.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../data-desk/dates.js";
import { buildPrompt } from "../runner/prompts.js";
import { gradeAnswer } from "../runner/grade.js";
import { solverFromPrompt } from "../runner/stand-in-models.js";
import type { DayData } from "./day-data.js";
import { fixtureDay, type FixtureDay } from "./fixture-day.js";
import { drawInstances } from "./instances.js";
import { smRows, solveSM } from "./solve.js";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());

const W = () => f.day.window;
/** A copy of the day whose chain series end on `endFor(id)` instead of the snapshot day. */
function withEnds(
  dimension: "chain" | "issuer",
  endFor: (id: string, i: number) => string,
): DayData {
  const m = new Map(f.day.stablecoins[dimension]);
  [...m.entries()].forEach(([id, b], i) =>
    m.set(id, { ...b, last: { ...b.last, day: endFor(id, i) } }),
  );
  return { ...f.day, stablecoins: { ...f.day.stablecoins, [dimension]: m } };
}

describe("CR-SM when the data publishes a day late", () => {
  it("offers a question when every series ends the day before the snapshot day, and says so", () => {
    const d = withEnds("chain", () => addDays(W(), -1));
    const { start, end, rows } = smRows(d, "chain");
    expect(start).toBe(addDays(W(), -90));
    expect(end).toBe(addDays(W(), -1));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(solveSM(d, "chain")).toBeDefined();
  });

  it("still ends on the snapshot day when that is where the series end", () => {
    expect(smRows(f.day, "chain").end).toBe(W());
  });

  it("uses the end day most series reach, and leaves out the ones that end elsewhere", () => {
    const d = withEnds("chain", (_, i) => (i === 0 ? W() : addDays(W(), -1)));
    const { end, rows } = smRows(d, "chain");
    expect(end).toBe(addDays(W(), -1));
    expect(rows).toHaveLength(f.day.stablecoins.chain.size - 1);
  });

  it("takes the later day on a tie, and ignores series that end two or more days early", () => {
    // an even number of series, half ending on each day: a true tie
    const n = f.day.stablecoins.chain.size;
    const even = n - (n % 2);
    const chain = new Map([...f.day.stablecoins.chain].slice(0, even));
    [...chain.entries()].forEach(([id, b], i) =>
      chain.set(id, { ...b, last: { ...b.last, day: i < even / 2 ? W() : addDays(W(), -1) } }),
    );
    const tie: DayData = { ...f.day, stablecoins: { ...f.day.stablecoins, chain } };
    expect(smRows(tie, "chain").end).toBe(W());
    const stale = withEnds("chain", () => addDays(W(), -2));
    expect(smRows(stale, "chain").rows).toHaveLength(0);
    expect(solveSM(stale, "chain")).toBeUndefined();
  });

  it("the prompt names the real end date, and a solver that sees only the prompt passes the gate", () => {
    const d = withEnds("chain", () => addDays(W(), -1));
    const inst = drawInstances(d, "e".repeat(64)).find(
      (i) => i.task === "CR-SM" && i.params.dimension === "chain",
    );
    expect(inst).toBeDefined();
    const prompt = buildPrompt(inst!, d)!;
    expect(prompt.text).toContain(`${addDays(W(), -90)} to ${addDays(W(), -1)}`);
    expect(prompt.text).toContain("latest day the data provider had published");
    const answer = JSON.stringify(solverFromPrompt(prompt.text));
    expect(gradeAnswer(inst!, answer).passed).toBe(true);
  });
});
