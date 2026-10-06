import { describe, expect, it } from "vitest";
import { AGENT_IDS } from "../identity/resolve.js";
import {
  DEFAULT_PARAMS,
  ISSUER_SEAT,
  JOB_TYPES,
  LAB_TRADERS,
  SEAT_OF,
  buildEconomy,
  needsInRound,
  needsOf,
  salesOf,
  traderForSeat,
} from "./economy.js";

describe("the seats", () => {
  it("are four distinct, existing seats, none of them the issuer", () => {
    const seats = LAB_TRADERS.map((t) => SEAT_OF[t]);
    expect(new Set(seats).size).toBe(4);
    for (const s of seats) expect(AGENT_IDS).toContain(s);
    expect(seats).not.toContain(ISSUER_SEAT);
  });

  it("map back from seat to label, and only for the four", () => {
    for (const t of LAB_TRADERS) expect(traderForSeat(SEAT_OF[t])).toBe(t);
    expect(traderForSeat(ISSUER_SEAT)).toBeUndefined();
    expect(traderForSeat("HEDGER")).toBeUndefined();
  });
});

describe("buildEconomy — the schedule, generated once from the seed", () => {
  const e = buildEconomy(20261006);

  it("gives every trader exactly one skill, each skill to exactly one trader", () => {
    expect(new Set(Object.values(e.skillOf)).size).toBe(4);
    for (const t of LAB_TRADERS) expect(e.sellerOf[e.skillOf[t]]).toBe(t);
    expect([...Object.values(e.skillOf)].sort()).toEqual([...JOB_TYPES].sort());
  });

  it("gives every trader two needs, of types it cannot deliver itself", () => {
    expect(e.needs).toHaveLength(8);
    for (const t of LAB_TRADERS) {
      const mine = needsOf(e, t);
      expect(mine).toHaveLength(2);
      for (const n of mine) {
        expect(n.type).not.toBe(e.skillOf[t]);
        expect(n.seller).toBe(e.sellerOf[n.type]);
        expect(n.seller).not.toBe(t);
      }
      expect(new Set(mine.map((n) => n.type)).size, "two different types").toBe(2);
    }
  });

  it("is balanced: every seller sells the same number of jobs", () => {
    for (const t of LAB_TRADERS) expect(salesOf(e, t)).toHaveLength(2);
  });

  it("puts a trader's needs in different rounds, and at least one need in every round", () => {
    for (const t of LAB_TRADERS) {
      const rounds = needsOf(e, t).map((n) => n.round);
      expect(new Set(rounds).size).toBe(rounds.length);
      for (const r of rounds) expect(r).toBeGreaterThanOrEqual(1);
      for (const r of rounds) expect(r).toBeLessThanOrEqual(DEFAULT_PARAMS.rounds);
    }
    for (let r = 1; r <= DEFAULT_PARAMS.rounds; r++) expect(needsInRound(e, r).length).toBeGreaterThan(0);
  });

  it("names each need uniquely and stably", () => {
    expect(new Set(e.needs.map((n) => n.id)).size).toBe(8);
    expect(e.needs[0].id).toMatch(/^TRADER-\d#\d$/);
  });

  it("is the same for the same seed and differs across seeds — same seeds across any comparison", () => {
    expect(buildEconomy(7)).toEqual(buildEconomy(7));
    const fingerprints = new Set(
      Array.from({ length: 20 }, (_, i) => JSON.stringify([buildEconomy(i).skillOf, buildEconomy(i).needs.map((n) => n.round)])),
    );
    expect(fingerprints.size).toBeGreaterThan(5);
  });

  it("holds the structure for every seed, not just one", () => {
    for (let seed = 0; seed < 200; seed++) {
      const x = buildEconomy(seed);
      expect(x.needs).toHaveLength(8);
      for (const t of LAB_TRADERS) expect(salesOf(x, t)).toHaveLength(2);
      for (const n of x.needs) expect(n.type).not.toBe(x.skillOf[n.buyer]);
      for (let r = 1; r <= 3; r++) expect(needsInRound(x, r).length).toBeGreaterThan(0);
    }
  });

  it("refuses parameters that cannot make a balanced schedule", () => {
    expect(() => buildEconomy(1, { ...DEFAULT_PARAMS, needsPerTrader: 0 })).toThrow(/needsPerTrader/);
    expect(() => buildEconomy(1, { ...DEFAULT_PARAMS, needsPerTrader: 4 })).toThrow(/needsPerTrader/);
    expect(() => buildEconomy(1, { ...DEFAULT_PARAMS, rounds: 1, needsPerTrader: 2 })).toThrow(/rounds/);
  });
});
