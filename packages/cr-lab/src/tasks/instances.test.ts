import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FIXTURE_AS_OF } from "../data-desk/fixtures/world.js";
import type { DayData } from "./day-data.js";
import { fixtureDay, type FixtureDay } from "./fixture-day.js";
import { INSTANCES_PER_TASK, TASKS, drawInstances, optionsFor } from "./instances.js";
import { plQuarters, solvePL, solveSM, solveUO, solveVS } from "./solve.js";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());
const SEED = "a".repeat(64);

describe("the options a day offers", () => {
  it("lists, for each task, only questions its solver can answer", () => {
    const o = optionsFor(f.day);
    expect(o["CR-VS"]).toHaveLength(6); // the last six end months
    expect(o["CR-SM"].map((x) => x.key)).toEqual(["chain", "issuer"]);
    expect(o["CR-PL"].length).toBeGreaterThan(0);
    expect(o["CR-PL"].length).toBeLessThanOrEqual(6 * 4);
    expect(o["CR-UO"].length).toBeGreaterThan(0);
  });

  it("leaves out a task's questions when its data is missing, and a protocol that has a gap in a quarter", () => {
    const empty: DayData = {
      ...f.day,
      perp: new Map(),
      stablecoins: { chain: new Map(), issuer: new Map() },
    };
    const o = optionsFor(empty);
    expect(o["CR-VS"]).toEqual([]);
    expect(o["CR-SM"]).toEqual([]);
    const q = plQuarters(FIXTURE_AS_OF)[0]!;
    const gappy: DayData = {
      ...f.day,
      lending: new Map([...f.day.lending].map(([k, v]) => [k, new Map(v)])),
    };
    gappy.lending.get("fixture-lend-1")!.delete(q.start);
    const keys = optionsFor(gappy)["CR-PL"].map((x) => x.key);
    expect(keys).not.toContain(`fixture-lend-1/${q.label}`);
    expect(keys).toContain(`fixture-lend-2/${q.label}`);
  });
});

describe("drawInstances", () => {
  it("draws at most three per task, fewer where there are fewer options, in task order, with stable ids", () => {
    const xs = drawInstances(f.day, SEED);
    expect(INSTANCES_PER_TASK).toBe(3);
    expect(xs.filter((x) => x.task === "CR-VS")).toHaveLength(3);
    expect(xs.filter((x) => x.task === "CR-PL")).toHaveLength(3);
    expect(xs.filter((x) => x.task === "CR-UO")).toHaveLength(3);
    expect(xs.filter((x) => x.task === "CR-SM")).toHaveLength(2); // only chains and issuers
    expect(xs.map((x) => x.task)).toEqual(
      [...xs.map((x) => x.task)].sort((a, b) => TASKS.indexOf(a) - TASKS.indexOf(b)),
    );
    expect(xs[0]!.id).toBe(`CR-VS-${FIXTURE_AS_OF}-1`);
    expect(new Set(xs.map((x) => x.id)).size).toBe(xs.length);
  });

  it("is the same questions for the same seed over the same snapshot, and different questions for another seed", () => {
    const a = drawInstances(f.day, SEED);
    const b = drawInstances(f.day, SEED);
    const c = drawInstances(f.day, "b".repeat(64));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.map((x) => x.params))).not.toBe(JSON.stringify(c.map((x) => x.params)));
  });

  it("does not depend on the order the snapshot's maps were filled in", () => {
    const reversed: DayData = {
      ...f.day,
      lendingProtocols: [...f.day.lendingProtocols].reverse(),
      schedules: new Map([...f.day.schedules].reverse()),
    };
    expect(JSON.stringify(drawInstances(reversed, SEED).map((x) => x.params))).toBe(
      JSON.stringify(drawInstances(f.day, SEED).map((x) => x.params)),
    );
  });

  it("never repeats a question within a task on the same day", () => {
    const xs = drawInstances(f.day, SEED, 6);
    for (const t of TASKS) {
      const keys = xs.filter((x) => x.task === t).map((x) => JSON.stringify(x.params));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("carries the reference answer its solver gives, so the gate and the key cannot disagree", () => {
    for (const x of drawInstances(f.day, SEED)) {
      if (x.task === "CR-VS") expect(x.reference).toEqual(solveVS(f.day, x.params.endMonth));
      if (x.task === "CR-PL")
        expect(x.reference).toEqual(solvePL(f.day, x.params.protocolId, x.params));
      if (x.task === "CR-UO") expect(x.reference).toEqual(solveUO(f.day, x.params.slug));
      if (x.task === "CR-SM") expect(x.reference).toEqual(solveSM(f.day, x.params.dimension));
    }
  });

  it("draws nothing for a task whose data is missing, and carries on with the others", () => {
    const noPerp: DayData = { ...f.day, perp: new Map() };
    const xs = drawInstances(noPerp, SEED);
    expect(xs.some((x) => x.task === "CR-VS")).toBe(false);
    expect(xs.some((x) => x.task === "CR-PL")).toBe(true);
  });

  it("takes a perTask of zero to mean none", () => {
    expect(drawInstances(f.day, SEED, 0)).toEqual([]);
  });
});
