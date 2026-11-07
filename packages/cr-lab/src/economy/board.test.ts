/**
 * New in v2 (marketplace-redesign-v2.md, items 3/4/9): the board's own live prices for data and the front-claim roll, and a demand agent's forward-visible needs. Every
 * other existing field is already exercised indirectly by `world.test.ts`'s own scenarios; this file is scoped to what changed.
 */
import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { StandInWorker } from "./agents.js";
import { boardFor, FORWARD_VISIBILITY_WINDOWS, renderBoard } from "./board.js";
import { EconomyLog } from "./log.js";
import { loadParams } from "./params.js";
import { buildWorld, loadCrPrint, needsSchedule, passRates, standInSha } from "./runner.js";

function world(seed: string) {
  const params = { ...loadParams(), seed };
  const wp0 = loadCrPrint();
  const sha = standInSha(seed);
  const w = buildWorld({
    params,
    wp0,
    log: new EconomyLog("stand-in"),
    worker: new StandInWorker(seed, passRates(wp0), sha),
    t0: 1_799_971_200,
    dataSha: sha,
  });
  w.genesis();
  w.startWindow(
    1,
    needsSchedule(
      seed,
      TASKS.filter((t) => t !== "CR-VS"),
    ),
  );
  return w;
}

describe("boardFor/renderBoard: v2 items 3/4/9", () => {
  it("shows the data price and the front-claim roll's discounted price live, every round, for a research agent", () => {
    const w = world("board-prices");
    const b = boardFor(w, "RESEARCH-1");
    expect(b.dataPriceMicroSiu).toBeGreaterThan(0n);
    expect(b.frontClaimDiscountBps).toBe(w.params.reserve.discountBps);
    expect(Number(b.frontClaimPriceUsdPerSiu)).toBeGreaterThan(0);
    // the discounted price must be strictly below the plain print rate
    expect(Number(b.frontClaimPriceUsdPerSiu)).toBeLessThan(Number(b.printUsdPerSiu));
    const text = renderBoard(b);
    expect(text).toMatch(/Front-claim roll: order work claims/);
    expect(text).toMatch(/Data bought today:.*once per day, in USDC or AGU-lab/);
  });

  it("gives a demand agent its own needs for the next N windows, from the same deterministic schedule the engine itself uses", () => {
    const w = world("board-needs-ahead");
    const b = boardFor(w, "DEMAND-1");
    expect(b.needsAhead).toHaveLength(FORWARD_VISIBILITY_WINDOWS);
    expect(b.needsAhead?.[0]?.window).toBe(2);
    expect(b.needsAhead?.[1]?.window).toBe(3);
    for (const n of b.needsAhead ?? []) expect(n.tasks.length).toBeGreaterThan(0);
    const expected = needsSchedule(
      "board-needs-ahead",
      TASKS.filter((t) => t !== "CR-VS"),
    )("DEMAND-1", 2);
    expect(b.needsAhead?.[0]?.tasks).toEqual([...new Set(expected)]);
    expect(renderBoard(b)).toMatch(/Your own needs ahead: window 2:/);
  });

  it("never gives a research agent or the hedger a needsAhead field (it is demand-only; the hedger's own forward visibility is its delivery schedule, item 8)", () => {
    const w = world("board-needs-ahead-scope");
    expect(boardFor(w, "RESEARCH-1").needsAhead).toBeUndefined();
    expect(boardFor(w, "HEDGER").needsAhead).toBeUndefined();
  });
});
