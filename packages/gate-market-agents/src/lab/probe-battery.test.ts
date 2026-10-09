import { describe, expect, it } from "vitest";
import { ARMS, BATTERY_ISSUER_ID, CELLS, CELL_IDS, EARMARK_REASON, RATIONALE_PARAGRAPH, REASONING_PARAGRAPH, armPrompt, buildCellScreen, findBatterySetup, parseBatteryReply, toolListFor, trendPath, type CellId } from "./probe-battery.js";
import { milliSiuAsUsdcMinor } from "./money.js";
import { FIXED_ROUTE_ORDER } from "./route-order.js";
import { LAB_TRADER_TOOLS } from "./roster.js";

const screens = Object.fromEntries(CELL_IDS.map((id) => [id, buildCellScreen(id)])) as Record<CellId, ReturnType<typeof buildCellScreen>>;
const NEUTRALITY = "converting between the two assets changes nothing about your result";
const EXPIRY = "has expired and counts for nothing in your result";
const total = (id: CellId, p: bigint): bigint => screens[id].held.usdcMinor + milliSiuAsUsdcMinor(screens[id].held.fsiuMilliSiu, p);

describe("the cells", () => {
  it("defines the thirteen cells of the plan, each compared against cells that exist", () => {
    expect(CELL_IDS).toHaveLength(13);
    for (const id of CELL_IDS) for (const a of CELLS[id].against) expect(CELL_IDS).toContain(a);
  });

  it("builds every cell the same way twice", () => {
    for (const id of CELL_IDS) expect(buildCellScreen(id).prompt).toBe(screens[id].prompt);
  });

  it("finds a seed whose trader has two open needs and two buyers, for both lab lengths", () => {
    const three = findBatterySetup(false);
    expect(three.atRound).toBe(2);
    expect(three.buyers.length).toBeGreaterThanOrEqual(2);
    const six = findBatterySetup(true);
    expect(six.atRound).toBe(5);
    expect(six.needB.round).toBeLessThanOrEqual(5);
  });

  it("makes P0 a real round-2 turn: print up 15%, one delivery owed, the opening wallet less the first need's payment, one quote to pay, USDC first", () => {
    const p0 = screens.P0;
    expect(p0.round).toBe(2);
    expect(p0.printByRound).toEqual(["1437000", "1652550"]);
    expect(p0.prompt).toContain("Round 2: 0.00165255 USD per SIU (up 15.0% on round 1)");
    expect(p0.prompt).toContain("You owe 1 delivery and hold 0 units of raw work.");
    expect(p0.prompt).toContain("YOU HOLD: 6,639 USDC minor units");
    expect(p0.prompt).toContain("Quotes you have received");
    expect(p0.prompt).toContain(NEUTRALITY);
    expect(p0.prompt).not.toContain(EXPIRY);
    expect(p0.prompt.indexOf("pay_with_usdc(requestId)")).toBeLessThan(p0.prompt.indexOf("pay_with_held_claim(requestId)"));
    expect(p0.prompt).toContain(`(no turns yet — this is your first turn)`);
  });

  it("has no open need to ask for in any cell: the first need is met, so the only thing to settle is the quote in front (D62)", () => {
    for (const id of CELL_IDS) {
      expect(screens[id].prompt).not.toContain("Needs you can buy now");
      expect(screens[id].prompt).toContain("YOUR RESULT SO FAR: 1 of 2 needs met.");
      expect(screens[id].prompt).toContain("Quotes you have received");
    }
  });

  it("P3 has no delivery owed and P4 has two", () => {
    expect(screens.P3.prompt).not.toContain("You owe");
    expect(screens.P3.prompt).not.toContain("Jobs you have been paid for");
    expect(screens.P4.prompt).toContain("You owe 2 deliveries and hold 0 units of raw work.");
  });

  it("P5 and P6 keep the total value of P0 at the print shown, weight the wallet 80/20, and can pay the quote in either asset", () => {
    const p = 1_652_550n;
    for (const id of ["P5", "P6"] as const) {
      const diff = total(id, p) - total("P0", p);
      expect(diff >= -2n && diff <= 2n).toBe(true);
      expect(screens[id].held.usdcMinor).toBeGreaterThanOrEqual(1_984n);
      expect(screens[id].held.fsiuMilliSiu).toBeGreaterThanOrEqual(1_200n);
    }
    expect(screens.P5.held.usdcMinor).toBeGreaterThan(screens.P5.held.fsiuMilliSiu);
    expect(milliSiuAsUsdcMinor(screens.P6.held.fsiuMilliSiu, p)).toBeGreaterThan(screens.P6.held.usdcMinor * 3n);
    expect(screens.P5.prompt).toContain(`YOU HOLD: ${screens.P5.held.usdcMinor.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} USDC minor units`);
  });

  it("P7 removes the neutrality sentence and nothing else in the brief; P8 adds the expiry sentence", () => {
    expect(screens.P7.prompt).not.toContain(NEUTRALITY);
    expect(screens.P7.prompt).not.toContain("never required to convert");
    expect(screens.P8.prompt).toContain(NEUTRALITY);
    expect(screens.P8.prompt).toContain(EXPIRY);
    for (const id of CELL_IDS.filter((c) => c !== "P8")) expect(screens[id].prompt).not.toContain(EXPIRY);
    expect(screens.P7.prompt.length).toBeLessThan(screens.P0.prompt.length);
    expect(screens.P8.prompt.length).toBeGreaterThan(screens.P0.prompt.length);
  });

  it("P9 names fSIU and its route first wherever the lab names both, in the brief, the board and the tool list", () => {
    const t = screens.P9.prompt;
    expect(t.indexOf('"tool": "pay_with_held_claim"')).toBeLessThan(t.indexOf('"tool": "pay_with_usdc"'));
    expect(t.indexOf("pay_with_held_claim(requestId)")).toBeLessThan(t.indexOf("pay_with_usdc(requestId)"));
    expect(t).toMatch(/YOU HOLD: \d[\d,]* mSIU of fSIU/);
    expect(t).toMatch(/settle 1,200 mSIU of fSIU or 0\.001984 USD/);
  });

  it("P10 and P11 show the earlier USDC payment in the lab's own history format with the stated purpose; no other cell has a history", () => {
    for (const id of ["P10", "P11"] as const) {
      expect(screens[id].prompt).toContain("Turn 1 — called request_quote(");
      expect(screens[id].prompt).toMatch(/Turn 2 — called pay_with_usdc\(\{"requestId":"qr-1"\}\) -> \{"txHash":"0x[0-9a-f]{64}"\} — your reason then: "preserve fSIU for raw work"/);
      expect(screens[id].held).toEqual(screens.P0.held);
    }
    expect(screens.P0.held.usdcMinor).toBe(8_364n - 1_725n);
    for (const id of CELL_IDS.filter((c) => c !== "P10" && c !== "P11")) expect(screens[id].prompt).not.toContain(EARMARK_REASON);
    expect(screens.P10.prompt).toContain("You owe 1 delivery");
    expect(screens.P11.prompt).not.toContain("You owe");
  });

  it("T1, T2 and T3 are round 5 of a six-round lab, with five prints rising, falling or flat", () => {
    const [t1, t2, t3] = [screens.T1, screens.T2, screens.T3];
    for (const t of [t1, t2, t3]) {
      expect(t.round).toBe(5);
      expect(t.printByRound).toHaveLength(5);
      expect(t.prompt).toContain("THE LAB — ROUND 5 OF 6");
      expect(t.prompt).toContain("The lab has 6 rounds");
    }
    expect(t1.printByRound.map(BigInt).every((p, i, a) => i === 0 || p > a[i - 1])).toBe(true);
    expect(t2.printByRound.map(BigInt).every((p, i, a) => i === 0 || p < a[i - 1])).toBe(true);
    expect(new Set(t3.printByRound).size).toBe(1);
    expect(t1.prompt).toContain("(up 15.0% on round 4)");
    expect(t2.prompt).toContain("(down 15.0% on round 4)");
    expect(t3.prompt).toContain("(unchanged on round 4)");
  });

  it("builds a trend path from the lab's own step", () => {
    const p = trendPath("rising", 1_437_000n, 6);
    expect(p.byRound).toHaveLength(6);
    expect(p.byRound[1]).toBe(1_652_550n);
  });

  it("every cell's wallet can pay the quote in front of the trader in either asset", () => {
    for (const id of CELL_IDS) {
      expect(screens[id].held.fsiuMilliSiu).toBeGreaterThanOrEqual(1_200n);
      expect(screens[id].held.usdcMinor).toBeGreaterThan(1_000n);
    }
  });

  it("lists the same payment tools in P0 and P9, in different order", () => {
    expect(toolListFor(FIXED_ROUTE_ORDER)).toEqual(LAB_TRADER_TOOLS);
    expect([...toolListFor({ assetFirst: "fsiu", tools: ["pay_with_held_claim", "pay_with_usdc", "pay_split"] })].sort()).toEqual([...LAB_TRADER_TOOLS].sort());
  });
});

describe("the arms", () => {
  it("arms A and C show the lab's own prompt; arm B changes exactly the one paragraph", () => {
    const a = screens.P0.prompt;
    expect(armPrompt(a, "A")).toBe(a);
    expect(armPrompt(a, "C")).toBe(a);
    const b = armPrompt(a, "B");
    expect(b).toBe(a.replace(RATIONALE_PARAGRAPH, REASONING_PARAGRAPH));
    expect(b).toContain('"reasoning"');
    expect(b).not.toContain('"rationale"');
    expect(a).toContain(RATIONALE_PARAGRAPH);
  });

  it("works on every cell", () => {
    for (const id of CELL_IDS) for (const arm of ARMS) expect(armPrompt(screens[id].prompt, arm).length).toBeGreaterThan(1000);
  });

  it("throws, rather than quietly doing nothing, if the paragraph is not there", () => {
    expect(() => armPrompt("no such paragraph", "B")).toThrow(/expected exactly one/);
  });
});

describe("parseBatteryReply", () => {
  it("reads the three routes", () => {
    expect(parseBatteryReply('{"tool":"pay_with_usdc","args":{"requestId":"qr-3"},"rationale":"simple"}', "A")).toEqual({ outcome: "payment", action: "pay_usdc", route: "usdc", tool: "pay_with_usdc", statedReason: "simple" });
    expect(parseBatteryReply('{"tool":"pay_with_held_claim","args":{"requestId":"qr-3"}}', "A")).toEqual({ outcome: "payment", action: "pay_fsiu", route: "fsiu", tool: "pay_with_held_claim" });
    expect(parseBatteryReply('{"tool":"pay_split","args":{"requestId":"qr-3","claimQuantityMilliSiu":"600"}}', "C").route).toBe("split");
  });

  it("reads the reasoning field in arm B, and ignores the rationale field there", () => {
    const r = parseBatteryReply('{"reasoning":"Keep fSIU for raw work.","tool":"pay_with_usdc","args":{"requestId":"qr-3"}}', "B");
    expect(r.statedReason).toBe("Keep fSIU for raw work.");
    expect(parseBatteryReply('{"reasoning":"a","tool":"pay_with_usdc","args":{},"rationale":"b"}', "B").statedReason).toBe("a");
    expect(parseBatteryReply('{"reasoning":"a","tool":"pay_with_usdc","args":{},"rationale":"b"}', "A").statedReason).toBe("b");
  });

  it("counts any other tool, a wait and a done as not a payment, and keeps the reason", () => {
    expect(parseBatteryReply('{"tool":"request_quote","args":{},"rationale":"ask first"}', "A")).toEqual({ outcome: "not_payment", action: "request_job", tool: "request_quote", statedReason: "ask first" });
    expect(parseBatteryReply('{"wait":true}', "A")).toEqual({ outcome: "not_payment", action: "wait" });
    expect(parseBatteryReply('{"done":true,"summary":"x"}', "B").outcome).toBe("not_payment");
  });

  it("calls a reply that does not parse unparsed", () => {
    expect(parseBatteryReply("I would pay with USDC.", "A")).toEqual({ outcome: "unparsed", action: "unparsed" });
    expect(parseBatteryReply("{not json}", "A")).toEqual({ outcome: "unparsed", action: "unparsed" });
  });

  it("records which kind of not-a-payment a reply was, fixed before any data (D63)", () => {
    const kind = (text: string) => parseBatteryReply(text, "A").action;
    expect(kind(`{"tool":"request_quote","args":{"sellerId":"${BATTERY_ISSUER_ID}","siu":"1"}}`)).toBe("request_raw_work");
    expect(kind('{"tool":"request_quote","args":{"sellerId":"erc8004:0xTRADER3","siu":"1.2"}}')).toBe("request_job");
    expect(kind('{"tool":"request_quote","args":{}}')).toBe("request_job");
    expect(kind('{"tool":"issue_quote","args":{"requestId":"qr-1"}}')).toBe("issue_quote");
    expect(kind('{"tool":"deliver_job","args":{"requestId":"qr-1"}}')).toBe("deliver_job");
    expect(kind('{"tool":"get_balances","args":{}}')).toBe("get_balances");
    expect(kind('{"tool":"something_else","args":{}}')).toBe("other_tool");
    expect(kind('{"wait":true}')).toBe("wait");
    expect(kind('{"done":true,"summary":"x"}')).toBe("done");
    expect(kind('{"tool":"pay_split","args":{}}')).toBe("pay_split");
  });

  it("treats a blank reasoning or rationale as no reason", () => {
    expect(parseBatteryReply('{"reasoning":"  ","tool":"pay_with_usdc","args":{}}', "B").statedReason).toBeUndefined();
    expect(parseBatteryReply('{"tool":"pay_with_usdc","args":{},"rationale":""}', "A").statedReason).toBeUndefined();
  });

  it("reads a reply with prose around the object", () => {
    expect(parseBatteryReply('Here is my call:\n```json\n{"reasoning":"r","tool":"pay_with_held_claim","args":{"requestId":"qr-3"}}\n```', "B")).toMatchObject({ outcome: "payment", route: "fsiu", statedReason: "r" });
  });
});
