import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { StandInWorker } from "./agents.js";
import { EconomyLog } from "./log.js";
import { PARTICIPANT } from "./memory-chain.js";
import { loadParams } from "./params.js";
import { parseReply } from "./parse.js";
import { buildWorld, loadCrPrint, needsSchedule, passRates, standInSha } from "./runner.js";

function world(seed: string, patch: (p: ReturnType<typeof loadParams>) => void = () => undefined) {
  const params = { ...loadParams(), seed };
  patch(params);
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

describe("buying AGU-lab (found in DW2, 2026-11-05)", () => {
  it("buys an exact amount of AGU-lab at the ask, so a quote can be met to the base unit", async () => {
    const w = world("exact");
    const r = await w.act("DEMAND-1", { tool: "buy_agu", agu: 200_000n }, "exactly the quote");
    expect(r.ok).toBe(true);
    expect(w.chain.balance("DEMAND-1", "AGU")).toBe(200_000n);
  });

  it("has the participant create on demand when its inventory is short, from its own USDC, never the reserve's or the buffer's", async () => {
    const w = world("topup");
    const inventory = w.chain.balance(PARTICIPANT, "AGU");
    const buffer = w.chain.balance("buffer", "USDC");
    const want = inventory + 2_000_000n;
    const usdcBefore = w.chain.balance(PARTICIPANT, "USDC");
    const r = await w.act("RESEARCH-1", { tool: "buy_agu", agu: want }, "a large working balance");
    expect(r.ok, r.note).toBe(true);
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBe(want);
    expect(w.log.of("create").some((e) => e.onDemand === true)).toBe(true);
    expect(w.chain.balance("buffer", "USDC")).toBe(buffer);
    // it paid issuers for the claims it created with, and was paid the ask by the buyer
    expect(w.chain.balance(PARTICIPANT, "USDC")).not.toBe(usdcBefore);
    w.checkInvariants();
  });

  it("fills a purchase only partly when the participant cannot create the rest, and says so", async () => {
    const w = world("broke", (p) => {
      p.participant = { ...p.participant, usdc: 200_000n }; // enough for the starting ladder (15 lots of 13,163 base units), little more
    });
    const inventory = w.chain.balance(PARTICIPANT, "AGU");
    const r = await w.act(
      "RESEARCH-1",
      { tool: "buy_agu", agu: 50_000_000n },
      "far beyond what it can create",
    );
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/partly filled/);
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBeGreaterThanOrEqual(inventory);
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBeLessThan(50_000_000n);
    w.checkInvariants();
  });

  it("refuses once the issuers' capacity for the window is used up and the participant has nothing left to sell", async () => {
    const w = world("empty");
    w.mint("RESEARCH-1", 1_000_000_000n); // a buyer far richer than the window's capacity
    let last = { ok: true, note: "" };
    for (let i = 0; i < 40 && last.ok; i++)
      last = await w.act("RESEARCH-1", { tool: "buy_agu", agu: 50_000_000n }, "take everything");
    expect(last.ok).toBe(false);
    expect(last.note).toMatch(/no AGU-lab to sell/);
    expect(w.chain.balance(PARTICIPANT, "AGU")).toBe(0n);
    w.checkInvariants();
  });

  it("lists the agents on the board and delivers a message to all of them", async () => {
    const w = world("msg");
    const r = await w.act(
      "DEMAND-3",
      { tool: "message", to: "all", text: "who quotes CR-PL?" },
      "asking",
    );
    expect(r.ok).toBe(true);
    for (const a of ["RESEARCH-1", "RESEARCH-2", "DEMAND-1", "HEDGER"])
      expect((w.notices.get(a) ?? []).some((n) => n.includes("who quotes CR-PL?"))).toBe(true);
    expect((w.notices.get("DEMAND-3") ?? []).some((n) => n.includes("who quotes"))).toBe(false);
  });

  it("parses buy_agu with exactly one of agu or usdc", () => {
    const ok = parseReply(
      '{"reasoning": "r", "action": {"tool": "buy_agu", "args": {"agu": "0.2"}}}',
      "demand",
    );
    expect(ok.ok && ok.action.tool === "buy_agu" && ok.action.agu).toBe(200_000n);
    expect(
      parseReply(
        '{"reasoning": "r", "action": {"tool": "buy_agu", "args": {"agu": "0.2", "usdc": "1"}}}',
        "demand",
      ).ok,
    ).toBe(false);
    expect(
      parseReply('{"reasoning": "r", "action": {"tool": "buy_agu", "args": {}}}', "demand").ok,
    ).toBe(false);
  });
});

describe("when the issuers' capacity runs out (found in DW3, 2026-11-05)", () => {
  it("never crashes: the ladder falls short and says so, the roll is refused whole and its front lots lapse, and every invariant holds", async () => {
    const w = world("no-capacity");
    w.mint("RESEARCH-1", 1_000_000_000n);
    // window 1 closes first (its expiries hand capacity back), then the capacity is used up just before window 2 opens
    w.closeWindow(1);
    for (const c of ["CR-PL", "CR-UO", "CR-SM"])
      for (const iss of w.chain.issuersForClass.get(c) ?? []) {
        const h = w.chain.headroom(iss, c);
        if (h > 0n) {
          w.mint("HEDGER", 1_000_000_000n);
          w.chain.mint(
            "HEDGER",
            c,
            "commodity",
            h,
            w.windowFrom(3),
            w.windowTo(3),
            w.commodityRate,
          );
        }
      }
    expect(() => w.startWindow(2, needsSchedule("no-capacity", TASKS))).not.toThrow();
    w.checkInvariants();
    expect(w.log.of("error").some((e) => e.ladderShort !== undefined)).toBe(true);
    const roll2 = w.log
      .of("roll-buy")
      .filter((e) => e.summary === true)
      .at(-1);
    expect(roll2?.refused).toMatch(/NoIssuerWithHeadroom/);
    w.closeWindow(2);
    w.checkInvariants();
    // the refused roll's front lots were never retired: they lapsed in the reserve at window 2's end
    const closes2 = w.log
      .of("claim-close")
      .filter((e) => e.window === w.dayLabel(2) && e.holder === "reserve");
    expect(closes2.length).toBeGreaterThan(0);
    expect(closes2.every((e) => e.retiredReserveLot === false)).toBe(true);
  });
});
