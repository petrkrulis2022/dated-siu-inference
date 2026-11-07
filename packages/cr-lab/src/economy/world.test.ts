import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { StandInWorker } from "./agents.js";
import { EconomyLog } from "./log.js";
import { PARTICIPANT } from "./memory-chain.js";
import { loadParams } from "./params.js";
import { parseReply } from "./parse.js";
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
    const front = parseReply(
      '{"reasoning": "r", "action": {"tool": "order_front_claim", "args": {"task": "CR-PL", "siu": "0.25", "pay": "agu"}}}',
      "demand",
    );
    expect(front.ok && front.action.tool === "order_front_claim" && front.action.pay).toBe("agu");
    const claims = parseReply(
      '{"reasoning": "r", "action": {"tool": "buy_claims", "args": {"task": "CR-PL", "siu": "0.25", "windows_ahead": 1, "pay": "agu"}}}',
      "hedger",
    );
    expect(claims.ok && claims.action.tool === "buy_claims" && claims.action.pay).toBe("agu");
  });

  it("parses buy_data and commission_task's optional pay unit, and rejects an invalid one", () => {
    const ok = parseReply(
      '{"reasoning": "r", "action": {"tool": "buy_data", "args": {"dataset": "perp", "pay": "agu"}}}',
      "research",
    );
    expect(ok.ok && ok.action.tool === "buy_data" && ok.action.pay).toBe("agu");
    const bad = parseReply(
      '{"reasoning": "r", "action": {"tool": "buy_data", "args": {"dataset": "perp", "pay": "eur"}}}',
      "research",
    );
    expect(bad.ok).toBe(false);
  });

  it("parses post_quote with exactly one of price_msiu or price_usdc", () => {
    const usd = parseReply(
      '{"reasoning": "r", "action": {"tool": "post_quote", "args": {"need": "n1", "tasks": ["CR-PL", "CR-UO"], "price_usdc": "0.015"}}}',
      "research",
    );
    expect(usd.ok && usd.action.tool === "post_quote" && usd.action.priceUsdcMicro).toBe(15_000n);
    const both = parseReply(
      '{"reasoning": "r", "action": {"tool": "post_quote", "args": {"need": "n1", "tasks": ["CR-PL", "CR-UO"], "price_msiu": "250", "price_usdc": "0.015"}}}',
      "research",
    );
    expect(both.ok).toBe(false);
    const neither = parseReply(
      '{"reasoning": "r", "action": {"tool": "post_quote", "args": {"need": "n1", "tasks": ["CR-PL", "CR-UO"]}}}',
      "research",
    );
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
