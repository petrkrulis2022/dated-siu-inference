import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { StandInWorker } from "./agents.js";
import { EconomyLog } from "./log.js";
import { MIN_SETTLEMENT, PARTICIPANT } from "./memory-chain.js";
import { loadParams } from "./params.js";
import { parseToolCall, type ToolCall } from "./parse.js";
import { minCommodityRateInRange } from "./print-history.js";
import { buildWorld, loadCrPrint, needsSchedule, passRates, standInSha } from "./runner.js";
import { DATA_AGENT } from "./world.js";
import type { Need } from "./world.js";

function world(
  seed: string,
  patch: (p: ReturnType<typeof loadParams>) => void = () => undefined,
  windowCount?: number,
  priceSchedule?: Parameters<typeof buildWorld>[0]["priceSchedule"],
) {
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
    windowCount,
    priceSchedule,
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

const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({
  tool,
  args: { reasoning: "r", ...args },
});

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
    w.mint("RESEARCH-1", 10_000_000n); // the test funds its own buyer, independent of the parameters' wallets
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
    w.mint("RESEARCH-1", 10_000_000n);
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
    const ok = parseToolCall(call("buy_agu", { agu: "0.2" }), "demand");
    expect(ok.ok && ok.action.tool === "buy_agu" && ok.action.agu).toBe(200_000n);
    expect(parseToolCall(call("buy_agu", { agu: "0.2", usdc: "1" }), "demand").ok).toBe(false);
    expect(parseToolCall(call("buy_agu"), "demand").ok).toBe(false);
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

describe("v2 items 1-5: a real currency choice at every transaction type (docs/marketplace-redesign-v2.md)", () => {
  it("buy_data(pay: 'agu') pays the data agent in AGU-lab instead of USDC, at the live rate", async () => {
    const w = world("buy-data-agu");
    const buy = await w.act(
      "RESEARCH-1",
      { tool: "buy_agu", agu: 1_000_000n },
      "need a working balance",
    );
    expect(buy.ok, buy.note).toBe(true);
    const aguBefore = w.chain.balance("RESEARCH-1", "AGU");
    const usdcBefore = w.chain.balance("RESEARCH-1", "USDC");
    const r = await w.act(
      "RESEARCH-1",
      { tool: "buy_data", dataset: "perp", pay: "agu" },
      "keeping USDC, paying in AGU-lab",
    );
    expect(r.ok, r.note).toBe(true);
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBeLessThan(aguBefore);
    expect(w.chain.balance("RESEARCH-1", "USDC")).toBe(usdcBefore); // no USDC moved for the payer
    expect(w.chain.balance(DATA_AGENT, "AGU")).toBeGreaterThan(0n);
    expect(w.chain.balance(DATA_AGENT, "USDC")).toBe(0n);
    expect(w.log.of("data-purchase").at(-1)?.payUnit).toBe("agu");
    w.checkInvariants();
  });

  it("the data agent's own AGU-lab income converts back to USDC at window close -- its own forced cost, never the payer's (items 6/12)", async () => {
    const w = world("data-agent-exit");
    await w.act("RESEARCH-1", { tool: "buy_agu", agu: 1_000_000n }, "working balance");
    await w.act("RESEARCH-1", { tool: "buy_data", dataset: "perp", pay: "agu" }, "paying in AGU-lab");
    expect(w.chain.balance(DATA_AGENT, "AGU")).toBeGreaterThan(0n);
    w.closeWindow(1);
    expect(w.chain.balance(DATA_AGENT, "AGU")).toBe(0n);
    expect(w.chain.balance(DATA_AGENT, "USDC")).toBeGreaterThan(0n);
    const sale = w.log.of("participant-buyback").find((e) => e.dataAgentCode === true);
    expect(sale?.from).toBe(DATA_AGENT);
    // DATA_AGENT is not a model agent: this conversion must never be attributed to RESEARCH-1's own receipt (items 6/12)
    expect(w.log.of("exit").some((e) => e.actor === "RESEARCH-1")).toBe(false);
    w.checkInvariants();
  });

  it("commission_task(pay: 'usdc') escrows and settles in USDC, never touching AGU-lab", async () => {
    const w = world("commission-usdc");
    w.mint("RESEARCH-1", 10_000_000n);
    const r = await w.act(
      "RESEARCH-1",
      { tool: "commission_task", tasks: ["CR-PL"], issuer: "ISSUER-C1", pay: "usdc" },
      "paying the issuer in USDC, keeping AGU-lab free for briefs",
    );
    expect(r.ok, r.note).toBe(true);
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBe(0n);
    const open = w.log.of("escrow-open").find((e) => e.payUnit === "usdc" && e.task === "CR-PL");
    expect(open).toBeDefined();
    expect(typeof open?.usdc).toBe("bigint");
    w.checkInvariants();
  });

  it("a quote priced in USDC (post_quote price_usdc) escrows, settles and pays in USDC end to end", async () => {
    const w = world("quote-usdc");
    const need = w.needs.find((n) => n.agent === "DEMAND-1" && n.status === "open") as Need;
    expect(need).toBeDefined();
    const quoted = await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: 15_000n },
      "quoting in dollars for once",
    );
    expect(quoted.ok, quoted.note).toBe(true);
    const quote = w.quotes.find((q) => q.researcher === "RESEARCH-1");
    expect(quote?.priceUnit).toBe("usdc");
    expect(quote?.priceUsdcMicro).toBe(15_000n);
    w.mint("DEMAND-1", 10_000_000n);
    const usdcBefore = w.chain.balance("DEMAND-1", "USDC");
    const accepted = await w.act(
      "DEMAND-1",
      { tool: "accept_quote", quote: (quote as { id: string }).id },
      "a dollar price is fine",
    );
    expect(accepted.ok, accepted.note).toBe(true);
    expect(w.chain.balance("DEMAND-1", "USDC")).toBe(usdcBefore - 15_000n);
    // simulate passing outputs for the brief's tasks, directly, to exercise deliver_brief's own USDC settlement path
    for (const t of need.tasks)
      w.outputs.push({
        id: `out-${t}`,
        owner: "RESEARCH-1",
        task: t,
        passed: true,
        dataSha: w.dataSha(1),
        issuer: "ISSUER-C1",
        window: 1,
        used: false,
      });
    const researcherUsdcBefore = w.chain.balance("RESEARCH-1", "USDC");
    const delivered = await w.act(
      "RESEARCH-1",
      { tool: "deliver_brief", quote: (quote as { id: string }).id },
      "delivering for a dollar price",
    );
    expect(delivered.ok, delivered.note).toBe(true);
    expect(w.chain.balance("RESEARCH-1", "USDC")).toBe(researcherUsdcBefore + 15_000n);
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBe(0n); // never touched AGU-lab anywhere in this trade
    w.checkInvariants();
  });

  it("the hedger's genesis wallet is split across both currencies, not minted entirely in USDC (item 5)", () => {
    const w = world("hedger-split");
    expect(w.chain.balance("HEDGER", "AGU")).toBeGreaterThan(0n);
    expect(w.chain.balance("HEDGER", "USDC")).toBeGreaterThan(0n);
    w.checkInvariants();
  });

  it("buy_claims(pay: 'agu') pre-converts through the participant, so the mint's own USDC debit is unaffected and the buyer's AGU-lab falls instead (item 4)", async () => {
    const w = world("buy-claims-agu");
    const buy = await w.act("HEDGER", { tool: "buy_agu", agu: 2_000_000n }, "a working balance");
    expect(buy.ok, buy.note).toBe(true);
    const aguBefore = w.chain.balance("HEDGER", "AGU");
    const usdcBefore = w.chain.balance("HEDGER", "USDC");
    const r = await w.act(
      "HEDGER",
      { tool: "buy_claims", task: "CR-PL", milli: 250n, windowsAhead: 1, pay: "agu" },
      "paying in AGU-lab, keeping USDC for forward-brief bonuses",
    );
    expect(r.ok, r.note).toBe(true);
    expect(w.chain.balance("HEDGER", "AGU")).toBeLessThan(aguBefore);
    expect(w.chain.balance("HEDGER", "USDC")).toBeGreaterThanOrEqual(usdcBefore); // unaffected, or a tiny surplus from the conversion's own rounding
    expect(w.log.of("claim-mint").at(-1)?.payUnit).toBe("agu");
    w.checkInvariants();
  });

  it("order_front_claim(pay: 'agu') is filled by the roll in AGU-lab, pre-converted through the participant before the roll's own USDC check runs (item 4)", async () => {
    const w = world("front-claim-agu");
    await w.act("DEMAND-1", { tool: "buy_agu", agu: 5_000_000n }, "a large AGU-lab balance");
    const ordered = await w.act(
      "DEMAND-1",
      { tool: "order_front_claim", task: "CR-PL", milli: 250n, pay: "agu" },
      "paying the roll in AGU-lab",
    );
    expect(ordered.ok, ordered.note).toBe(true);
    expect(ordered.note).toMatch(/AGU-lab/);
    const aguBefore = w.chain.balance("DEMAND-1", "AGU");
    w.startWindow(
      2,
      needsSchedule(
        "front-claim-agu",
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    );
    expect(w.chain.balance("DEMAND-1", "AGU")).toBeLessThan(aguBefore);
    expect(w.log.of("roll-sale").some((e) => e.to === "DEMAND-1")).toBe(true);
    expect(w.log.of("participant-buyback").some((e) => e.from === "DEMAND-1" && e.forPurchase === "front-claim-order")).toBe(
      true,
    );
    w.checkInvariants();
  });

  it("parses order_front_claim and buy_claims's optional pay unit", () => {
    const front = parseToolCall(call("order_front_claim", { task: "CR-PL", siu: "0.25", pay: "agu" }), "demand");
    expect(front.ok && front.action.tool === "order_front_claim" && front.action.pay).toBe("agu");
    const claims = parseToolCall(
      call("buy_claims", { task: "CR-PL", siu: "0.25", windows_ahead: 1, pay: "agu" }),
      "hedger",
    );
    expect(claims.ok && claims.action.tool === "buy_claims" && claims.action.pay).toBe("agu");
  });

  it("parses buy_data and commission_task's optional pay unit, and rejects an invalid one", () => {
    const ok = parseToolCall(call("buy_data", { dataset: "perp", pay: "agu" }), "research");
    expect(ok.ok && ok.action.tool === "buy_data" && ok.action.pay).toBe("agu");
    const bad = parseToolCall(call("buy_data", { dataset: "perp", pay: "eur" }), "research");
    expect(bad.ok).toBe(false);
  });

  it("parses post_quote with exactly one of price_msiu or price_usdc", () => {
    const usd = parseToolCall(
      call("post_quote", { need: "n1", tasks: ["CR-PL", "CR-UO"], price_usdc: "0.015" }),
      "research",
    );
    expect(usd.ok && usd.action.tool === "post_quote" && usd.action.priceUsdcMicro).toBe(15_000n);
    const both = parseToolCall(
      call("post_quote", { need: "n1", tasks: ["CR-PL", "CR-UO"], price_msiu: "250", price_usdc: "0.015" }),
      "research",
    );
    expect(both.ok).toBe(false);
    const neither = parseToolCall(call("post_quote", { need: "n1", tasks: ["CR-PL", "CR-UO"] }), "research");
    expect(neither.ok).toBe(false);
  });
});

describe("v2 item 8: a running economic objective (docs/marketplace-redesign-v2.md)", () => {
  it("debits a research agent's objective for a data purchase, in whichever currency it actually paid", async () => {
    const w = world("objective-data-usdc");
    await w.act("RESEARCH-1", { tool: "buy_data", dataset: "perp", pay: "usdc" }, "buying data");
    const o = w.objective.get("RESEARCH-1");
    expect(o?.usdcNet).toBe(-w.params.dataShadowPriceUsdc);
    expect(o?.aguNet).toBe(0n);
  });

  it("credits a research agent's objective on a passing, delivered brief, in whichever currency it was paid", async () => {
    const w = world("objective-brief-usdc");
    const need = w.needs.find((n) => n.agent === "DEMAND-1" && n.status === "open") as Need;
    await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: 15_000n },
      "dollar price",
    );
    const quote = w.quotes.find((q) => q.researcher === "RESEARCH-1") as { id: string };
    w.mint("DEMAND-1", 10_000_000n);
    await w.act("DEMAND-1", { tool: "accept_quote", quote: quote.id }, "fine");
    for (const t of need.tasks)
      w.outputs.push({
        id: `out-${t}`,
        owner: "RESEARCH-1",
        task: t,
        passed: true,
        dataSha: w.dataSha(1),
        issuer: "ISSUER-C1",
        window: 1,
        used: false,
      });
    await w.act("RESEARCH-1", { tool: "deliver_brief", quote: quote.id }, "delivering");
    expect(w.objective.get("RESEARCH-1")?.usdcNet).toBe(15_000n);
  });

  it("charges a demand agent's objective for a need that lapses unmet, as a pure scoring deduction -- never a real balance debit", () => {
    const w = world("objective-unmet", (p) => {
      p.unmetNeedCostMicroSiu = 200_000n;
    });
    const usdcBefore = w.chain.balance("DEMAND-1", "USDC");
    const aguBefore = w.chain.balance("DEMAND-1", "AGU");
    w.closeWindow(1);
    expect(w.objective.get("DEMAND-1")?.unmetMicroSiu).toBe(200_000n);
    expect(w.chain.balance("DEMAND-1", "USDC")).toBe(usdcBefore);
    expect(w.chain.balance("DEMAND-1", "AGU")).toBe(aguBefore);
    expect(w.log.of("need-lapsed").some((e) => e.actor === "DEMAND-1")).toBe(true);
  });

  it("never charges anything when unmetNeedCostMicroSiu is absent (every v1 log/fixture, opt-in only)", () => {
    const w = world("objective-unmet-off");
    w.closeWindow(1);
    expect(w.objective.has("DEMAND-1")).toBe(false);
    expect(w.log.of("need-lapsed")).toHaveLength(0);
  });

  it("pays the hedger's on-time bonus and charges its late penalty against its own due-by-window schedule, plus a final reconciliation at the run's last window", async () => {
    const w = world(
      "objective-hedger",
      (p) => {
        p.hedger = { ...p.hedger, briefsSold: 2, priceUsdcPerBrief: 1_000n, latePenaltyUsdcPerBrief: 500n };
      },
      2, // totalWindows
    );
    // window 1: owed = ceil(2*1/2) = 1 -- deliver exactly one, on time, no penalty
    for (const t of ["CR-PL", "CR-UO"] as const)
      w.outputs.push({
        id: `h1-${t}`,
        owner: "HEDGER",
        task: t,
        passed: true,
        dataSha: w.dataSha(1),
        issuer: "ISSUER-C1",
        window: 1,
        used: false,
      });
    const delivered = await w.act("HEDGER", { tool: "deliver_forward" }, "on time");
    expect(delivered.ok, delivered.note).toBe(true);
    w.closeWindow(1);
    let o = w.objective.get("HEDGER");
    expect(o?.onTime).toBe(1);
    expect(o?.late).toBe(0);
    expect(o?.usdcNet).toBe(1_000n);
    // window 2: owed by now = ceil(2*2/2) = 2, one more due this window; deliver NONE -- late, and this is also the run's last window, so the same shortfall
    // is the final reconciliation too (never counted twice: dueThisWindow already is exactly the one brief still owed)
    w.startWindow(
      2,
      needsSchedule(
        "objective-hedger",
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    );
    w.closeWindow(2);
    o = w.objective.get("HEDGER");
    expect(o?.late).toBe(1);
    expect(o?.usdcNet).toBe(1_000n - 500n);
  });

  it("the owner's requirement: the objective's combined figure is currency-neutral -- the same real economic value via opposite currencies gives the identical combined result (within rounding)", async () => {
    const w = world("objective-neutral");
    const rate = w.commodityRate;
    const valueUsdc = 15_000n;
    const valueMicroSiu = (valueUsdc * 1_000_000_000n) / rate;
    const valueAgu = w.aguFor(valueMicroSiu);
    w.objective.set("RESEARCH-1", { usdcNet: valueUsdc, aguNet: 0n, unmetMicroSiu: 0n, onTime: 0, late: 0 });
    w.objective.set("RESEARCH-2", { usdcNet: 0n, aguNet: valueAgu, unmetMicroSiu: 0n, onTime: 0, late: 0 });
    const { boardFor } = await import("./board.js");
    const combinedUsdc = Number(boardFor(w, "RESEARCH-1").objective?.combinedUsd ?? "0");
    const combinedAgu = Number(boardFor(w, "RESEARCH-2").objective?.combinedUsd ?? "0");
    expect(Math.abs(combinedUsdc - combinedAgu)).toBeLessThan(0.00005);
  });
});

describe("v2 item 10: moving prices replay the real published Dated SIU history", () => {
  it("applies the schedule's own rate for each window, propagating through commodityRate/the board with no other change -- absent, one fixed rate for the whole run as before", () => {
    const schedule = new Map([
      [1, { commodity: 1_000_000_000n, frontier: 9_000_000_000n }],
      [2, { commodity: 2_000_000_000n, frontier: 9_000_000_000n }],
    ]);
    const w = world("print-history", undefined, undefined, schedule);
    expect(w.commodityRate).toBe(1_000_000_000n);
    w.startWindow(
      2,
      needsSchedule(
        "print-history",
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    );
    expect(w.commodityRate).toBe(2_000_000_000n);
  });

  it("keeps the original fixed-for-the-whole-run rate when no schedule is supplied (every existing caller/test)", () => {
    const w = world("no-print-history");
    const before = w.commodityRate;
    w.startWindow(
      2,
      needsSchedule(
        "no-print-history",
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    );
    expect(w.commodityRate).toBe(before);
  });
});

describe("v2 fix 1 (owner, 2026-11-07): a USDC commission never gets stuck below the real settlement floor", () => {
  it("at the REAL worst-case commodity rate across the full available print history, CR-UO's USDC commission floors to exactly MIN_SETTLEMENT and settles -- not just the one rate the first dev-test happened to hit", async () => {
    // the survey this fix is sized against: the lowest commodity rate published anywhere in the full available real history
    const worstCaseRate = minCommodityRateInRange("2026-09-02", "2026-10-10");
    const schedule = new Map([[1, { commodity: worstCaseRate, frontier: 12_000_000n }]]);
    const w = world("fix1-worst-case", undefined, undefined, schedule);
    w.mint("RESEARCH-1", 10_000_000n);
    const r = await w.act(
      "RESEARCH-1",
      { tool: "commission_task", tasks: ["CR-UO"], issuer: "ISSUER-C1", pay: "usdc" },
      "paying in USDC even though CR-UO is cheap",
    );
    expect(r.ok, r.note).toBe(true);
    expect(r.note).not.toMatch(/refused/);
    const open = w.log.of("escrow-open").find((e) => e.task === "CR-UO" && e.payUnit === "usdc");
    expect(open?.usdc).toBe(MIN_SETTLEMENT); // floored up from the raw conversion
    expect(open?.flooredFromUsdc).toBeLessThan(MIN_SETTLEMENT); // the real, un-floored price was genuinely below the floor
    expect(w.log.of("error").some((e) => e.refused === "BelowMinSettlement")).toBe(false);
    w.checkInvariants();
  });

  it("a refusal's concrete numbers ride along onto the agent's NEXT board (lastResult), not just the bare rule name", async () => {
    const w = world("fix1-refusal-message");
    // redeem_agu with more than held hits a ChainRule the agent can act on if it sees the real numbers
    const r = await w.act("DEMAND-1", { tool: "redeem_agu", agu: 1_000_000n }, "trying to redeem more than I hold");
    expect(r.ok).toBe(false);
    const lastResult = w.lastResult.get("DEMAND-1");
    expect(lastResult).toContain("refused:");
    // whichever ChainRule fires here, confirm the general mechanism: an error-kind log entry exists and lastResult echoes its own refused reason
    const errorEntry = w.log.of("error").find((e) => e.actor === "DEMAND-1");
    expect(errorEntry).toBeDefined();
    expect(lastResult).toContain(String(errorEntry?.refused));
  });

  it("BelowMinSettlement specifically round-trips its actual amount and the floor onto the next board", () => {
    // a direct, minimal reproduction of the exact refusal the dev-test hit, isolated from the commission/pricing machinery above
    const w = world("fix1-belowmin-detail");
    const before = w.chain.balance("DEMAND-1", "USDC");
    expect(before).toBeGreaterThan(0n);
    // force the exact failure by opening and settling a tiny escrow directly against the chain, bypassing #commission's own new floor -- this is what the OLD code path produced
    w.chain.escrowOpen("tiny-1", "USDC", "DEMAND-1", "RESEARCH-1", "GATE-RUNNER", 50n, w.windowTo(w.window));
    expect(() => w.chain.escrowSettle("tiny-1", "GATE-RUNNER", 50n)).toThrowError(/BelowMinSettlement/);
    try {
      w.chain.escrowSettle("tiny-1", "GATE-RUNNER", 50n);
    } catch (e) {
      const detail = (e as { detail?: { actual: bigint; min: bigint } }).detail;
      expect(detail?.actual).toBe(50n);
      expect(detail?.min).toBe(MIN_SETTLEMENT);
    }
  });
});

describe("v2 fix 2 (owner, 2026-11-07): scripted conversions never use up the cap a model agent's own currency choice depends on", () => {
  it("the data agent's own forced AGU-lab conversion still goes through IN FULL, even when an issuer's own scripted sale, in the SAME window, is far bigger than the old shared cap would ever have allowed", async () => {
    const w = world("fix2-cap-collision", (p) => {
      // a tight cap: reproduces D134's exact collision (10% of supply let the issuer alone exhaust it) -- fix 2 must make this cap irrelevant to scripted conversions entirely
      p.participant = { ...p.participant, buybackCapBps: 1_000n }; // 10%, same as the real dev-test
    });
    // the participant needs enough of its own USDC to pay out BOTH conversions below; top it up directly (test setup only, not part of the fix itself)
    w.mint(PARTICIPANT, 10_000_000n);
    // the data agent earns a little AGU-lab (item 1's own mechanism)
    await w.act("RESEARCH-1", { tool: "buy_agu", agu: 1_000_000n }, "working balance");
    await w.act("RESEARCH-1", { tool: "buy_data", dataset: "perp", pay: "agu" }, "paying the data agent in AGU-lab");
    const dataAgentBalance = w.chain.balance(DATA_AGENT, "AGU");
    expect(dataAgentBalance).toBeGreaterThan(0n);
    // give an issuer a balance far larger than the old 10%-of-supply cap would ever have allowed through alone, mirroring D134's own finding
    const oldCap = (w.chain.aguSupply * 1_000n) / 10_000n;
    const issuerBalance = oldCap * 3n;
    w.mint("RESEARCH-1", 10_000_000n);
    await w.act("RESEARCH-1", { tool: "buy_agu", agu: issuerBalance }, "funding the issuer seed below");
    w.chain.escrowOpen("seed-issuer-agu", "AGU", "RESEARCH-1", "ISSUER-C1", "GATE-RUNNER", issuerBalance, w.windowTo(w.window));
    w.chain.escrowSettle("seed-issuer-agu", "GATE-RUNNER", issuerBalance);
    expect(w.chain.balance("ISSUER-C1", "AGU")).toBe(issuerBalance);
    w.closeWindow(1);
    const issuerSale = w.log.of("participant-buyback").find((e) => e.issuerCode === true);
    const dataAgentSale = w.log.of("participant-buyback").find((e) => e.dataAgentCode === true);
    // the issuer's own sale is NOT truncated to the old 10% cap -- it converts its full balance, well beyond what that cap would have allowed
    expect(issuerSale?.agu).toBe(issuerBalance);
    expect(issuerSale?.agu as bigint).toBeGreaterThan(oldCap);
    // AND the data agent's own conversion still fires in full, in the SAME window, never crowded out by the issuer's much larger sale
    expect(dataAgentSale).toBeDefined();
    expect(dataAgentSale?.from).toBe(DATA_AGENT);
    expect(dataAgentSale?.agu).toBe(dataAgentBalance);
    expect(w.chain.balance(DATA_AGENT, "AGU")).toBe(0n);
    w.checkInvariants();
  });

  it("a model agent's own sell_agu is still bounded by buybackCapBps, unaffected by fix 2 (the agent-facing cap is untouched)", async () => {
    const w = world("fix2-agent-cap-unchanged", (p) => {
      p.participant = { ...p.participant, buybackCapBps: 1_000n }; // 10% of opening supply
    });
    const cap = (w.chain.aguSupply * 1_000n) / 10_000n;
    w.mint("DEMAND-1", 10_000_000n);
    const tooMuch = cap * 2n;
    await w.act("DEMAND-1", { tool: "buy_agu", agu: tooMuch }, "a balance well beyond the window's buy-back cap");
    const r = await w.act("DEMAND-1", { tool: "sell_agu", agu: tooMuch }, "selling more than 10% of supply");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/buy-back cap/);
  });
});

describe("v2 fix 3 (found live testing D137, native tool-calling): accept_quote beyond the buyer's real balance", () => {
  it("refuses cleanly, leaves the quote exactly as posted (no phantom escrow), and the quote is still genuinely acceptable once funded", async () => {
    // the mandate's own spend-limit check runs first and is independent of this bug: raise it out of the way so the test isolates the real-balance failure specifically
    const w = world("accept-insufficient", (p) => {
      p.mandates = {
        ...p.mandates,
        "DEMAND-1": { ...p.mandates["DEMAND-1"], spendLimitAguPerWindow: 1_000_000_000_000n },
      };
    });
    const need = w.needs.find((n) => n.agent === "DEMAND-1" && n.status === "open") as Need;
    const usdcBefore = w.chain.balance("DEMAND-1", "USDC");
    const tooMuch = usdcBefore + 1n; // just beyond what DEMAND-1 actually holds
    const quoted = await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: tooMuch },
      "pricing above what this buyer can afford",
    );
    expect(quoted.ok, quoted.note).toBe(true);
    const quote = w.quotes.find((q) => q.researcher === "RESEARCH-1") as { id: string };
    const r = await w.act("DEMAND-1", { tool: "accept_quote", quote: quote.id }, "trying to accept anyway");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/refused:/);
    // the one bug this exposed: before the fix, status/escrow were set BEFORE the failing transfer, leaving a quote stuck "accepted" with an escrow id
    // that was never actually opened -- crashing window-close's own cleanup (`NoEscrow`) trying to expire it. Confirm it never happened here.
    const stillPosted = w.quotes.find((x) => x.id === quote.id);
    expect(stillPosted?.status).toBe("posted");
    expect(stillPosted?.escrow).toBeUndefined();
    w.checkInvariants();
    // fund the buyer and accept again: the quote is genuinely unharmed, not merely "not crashing"
    w.mint("DEMAND-1", tooMuch);
    const accepted = await w.act("DEMAND-1", { tool: "accept_quote", quote: quote.id }, "funded now");
    expect(accepted.ok, accepted.note).toBe(true);
    expect(w.quotes.find((x) => x.id === quote.id)?.status).toBe("accepted");
    w.checkInvariants();
    expect(() => w.closeWindow(1)).not.toThrow(); // the original crash site
  });
});
