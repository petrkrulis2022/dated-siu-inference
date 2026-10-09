import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import type { DecisionRecord } from "./decisions.js";
import { renderOverview, type OverviewReport } from "./overview.js";

const SEATS = { "TRADER-1": "ORCHESTRATOR", "TRADER-2": "WORKER-CODE", "TRADER-3": "WORKER-EXTRACT", "TRADER-4": "ISSUER-A" };
const traders = (usdc: string, fsiu: string, needsMet = 0) => Object.keys(SEATS).map((t) => ({ trader: t, usdcMinor: usdc, fsiuMilliSiu: fsiu, needsMet, resultNano: "15000000" }));

/**
 * A small v8 model run with three payments — one in each asset — and a print that moved. Prices as v8 states them (D50): a job at 1.2 SIU and a
 * unit of raw work at 1 SIU, their dollars at six decimals rounded up at the print of the round each was asked for in.
 */
function report(over: Partial<OverviewReport> = {}): OverviewReport {
  const decisions: DecisionRecord[] = [
    { agentId: "ORCHESTRATOR", turn: 1, seq: 1, round: 1, tool: "request_quote", requestId: "qr-1", rationale: "ask TRADER-2", raw: '{"tool":"request_quote","args":{"sellerId":"s"},"rationale":"ask TRADER-2"}', outcome: "asked for a quote, qr-1" },
    { agentId: "WORKER-CODE", turn: 1, seq: 2, round: 1, tool: "issue_quote", requestId: "qr-1", raw: '{"tool":"issue_quote","args":{"requestId":"qr-1"}}', outcome: "quoted" },
    {
      agentId: "ORCHESTRATOR", turn: 2, seq: 3, round: 1, tool: "pay_with_usdc", requestId: "qr-1",
      rationale: "I have sufficient USDC (0.008364 USD > 0.001725 USD required).",
      raw: '{"tool":"pay_with_usdc","args":{"requestId":"qr-1"},"rationale":"I have sufficient USDC (0.008364 USD > 0.001725 USD required)."}',
      outcome: "paid", reasoningTokens: 0,
    },
    {
      agentId: "ISSUER-A", turn: 4, seq: 4, round: 2, tool: "pay_with_held_claim", requestId: "qr-2",
      rationale: "paying with held fSIU to conserve USDC | and a pipe",
      raw: '{"tool":"pay_with_held_claim","args":{"requestId":"qr-2"},"rationale":"paying with held fSIU to conserve USDC | and a pipe"}',
      thinking: "I hold 4,400 mSIU of fSIU; the quote is 1,200 mSIU.", reasoningTokens: 1_400, outcome: "paid",
    },
    { agentId: "WORKER-CODE", turn: 5, seq: 5, round: 2, tool: "pay_split", requestId: "qr-3", raw: '{"tool":"pay_split","args":{"requestId":"qr-3","claimQuantityMilliSiu":"500"}}', reasoningTokens: 900, outcome: "paid" },
    { agentId: "WORKER-CODE", turn: 6, seq: 6, round: 3, tool: "wait", rationale: "the print is up 15%, so I will expect it to settle", raw: '{"wait":true,"rationale":"the print is up 15%, so I will expect it to settle"}', outcome: "waited" },
    { agentId: "ORCHESTRATOR", turn: 7, seq: 7, round: 3, tool: "request_quote", raw: '{"tool":"request_quote","args":{"siu":"1"}}', outcome: "refused before it ran: a job is priced at 1.2 SIU." },
  ];
  return {
    runId: "lab-test", seed: 1, scripted: false, params: DEFAULT_PARAMS, print: { rateUsdPerSiu: "0.001437" }, seats: SEATS,
    models: { "TRADER-1": "claude-haiku-4-5", "TRADER-2": "gpt-5.1", "TRADER-3": "claude-haiku-4-5", "TRADER-4": "grok-4.6" },
    prints: { byRound: ["1437000", "1652550", "1404667"], stepBps: 1500 },
    routeOrder: { assetFirst: "fsiu", tools: ["pay_split", "pay_with_usdc", "pay_with_held_claim"] },
    thinkingCapture: {
      "TRADER-1": { model: "claude-haiku-4-5", turns: 3, turnsWithReasoningText: 0, reasoningTokensBilled: 0, reasoningCharsReturned: 0 },
      "TRADER-2": { model: "gpt-5.1", turns: 4, turnsWithReasoningText: 0, reasoningTokensBilled: 900, reasoningCharsReturned: 0 },
      "TRADER-4": { model: "grok-4.6", turns: 2, turnsWithReasoningText: 1, reasoningTokensBilled: 1_400, reasoningCharsReturned: 52 },
    },
    sampling: {
      "TRADER-1": { model: "claude-haiku-4-5", turns: 3, temperatures: ["0.7"], turnsNotReported: 0 },
      "TRADER-2": { model: "claude-sonnet-5", turns: 4, temperatures: ["provider-default"], turnsNotReported: 1 },
    },
    opening: { fsiuMilliSiuPerTrader: "4400" },
    economy: { needs: [
      { id: "a", buyer: "TRADER-1", seller: "TRADER-2", round: 1, type: "TYPE-3" } as never,
      { id: "b", buyer: "TRADER-4", seller: "TRADER-2", round: 2, type: "TYPE-3" } as never,
      { id: "c", buyer: "TRADER-2", seller: "TRADER-4", round: 3, type: "TYPE-1" } as never,
    ] },
    sales: [
      { requestId: "qr-1", round: 1, kind: "trade", buyer: "TRADER-1", seller: "TRADER-2", needId: "a", quoted: true, paid: true, paidAsset: "usdc", delivered: true },
      { requestId: "qr-2", round: 2, kind: "trade", buyer: "TRADER-4", seller: "TRADER-2", needId: "b", quoted: true, paid: true, paidAsset: "fsiu", delivered: false },
      { requestId: "qr-3", round: 2, kind: "rawwork", buyer: "TRADER-2", seller: "ISSUER", quoted: true, paid: true, paidAsset: "split", delivered: false },
      { requestId: "qr-4", round: 3, kind: "trade", buyer: "TRADER-2", seller: "TRADER-4", needId: "c", quoted: false, paid: false, delivered: false },
    ],
    paymentMoments: [
      { agentId: "ORCHESTRATOR", turn: 2, tool: "pay", requestId: "qr-1", heldReceivedMilliSiu: "0", heldTotalMilliSiu: "4400", quotedUsdMax: "0.001725" },
      { agentId: "ISSUER-A", turn: 4, tool: "transfer_claim", requestId: "qr-2", heldReceivedMilliSiu: "0", heldTotalMilliSiu: "4400", quotedUsdMax: "0.001984" },
      { agentId: "WORKER-CODE", turn: 5, tool: "settle_split_held", requestId: "qr-3", heldReceivedMilliSiu: "1211", heldTotalMilliSiu: "5611", quotedUsdMax: "0.001653" },
    ],
    capacityEvents: [
      { kind: "transfer_claim", agentId: "ISSUER-A", quantityMilliSiu: "1200", settlesRequestId: "qr-2" },
      { kind: "transfer_claim", agentId: "WORKER-CODE", quantityMilliSiu: "500", settlesRequestId: "qr-3" },
    ],
    operatorActions: [
      { kind: "expiry", holder: "TRADER-1", quantityMilliSiu: "4400" },
      { kind: "expiry", holder: "TRADER-4", quantityMilliSiu: "3200" },
    ],
    snapshots: [{ label: "opening", round: 1, traders: traders("8364", "4400") }], final: { traders: traders("8000", "4000", 1) },
    measuredBeforeClose: true, needsMet: { "TRADER-1": 1, "TRADER-2": 0, "TRADER-3": 0, "TRADER-4": 0 },
    totalRealizedUsd: "0.100000", workCostUsd: "0.004000", labErrors: [], pool: { whole: true, restored: true },
    instrument: { version: LAB_INSTRUMENT_VERSION },
    haltedReason: { "WORKER-CODE": "nothing_to_act_on" }, turnsByAgent: { ORCHESTRATOR: 3, "WORKER-CODE": 4 },
    waits: [{ agentId: "WORKER-CODE", turn: 6, hadWork: ["a quote it was sent and has not paid"] }],
    refusals: [{ agentId: "ORCHESTRATOR", turn: 7, kind: "refused", sentence: "a job is priced at 1.2 SIU." }],
    toolErrors: [], lag: { writesRetried: 1, recovered: 1, gaveUp: 0 }, spendByProvider: { anthropic: "0.1", xai: "0.0" },
    decisions,
    ...over,
  };
}

describe("the overview every run carries", () => {
  const text = renderOverview(report());

  it("lists every payment with the round and print it was asked and paid in, who paid whom, for what, its price in SIU and in both assets, the asset used, the outcome and the payer's own words", () => {
    expect(text).toContain(
      "| 1 | r1 / r1 | 0.001437 / 0.001437 | TRADER-1 → TRADER-2 | a TYPE-3 job | 1.2 SIU = 0.001725 USD = 1,200 mSIU of fSIU (print 0.001437) | USDC (1,725 USDC minor units) | paid; job delivered | I have sufficient USDC (0.008364 USD > 0.001725 USD required). |",
    );
    expect(text).toContain(
      "| 2 | r2 / r2 | 0.00165255 / 0.00165255 | TRADER-4 → TRADER-2 | a TYPE-3 job | 1.2 SIU = 0.001984 USD = 1,200 mSIU of fSIU (print 0.00165255) | fSIU (1,200 mSIU) | paid; job NOT delivered | paying with held fSIU to conserve USDC \\| and a pipe |",
    );
    // The payee of raw work is the issuer, named so; a split shows both parts, the dollar part being the quote's dollars less the claim's value at its print.
    // 500 mSIU at round 2's print of 1,652,550 is worth 826 minor units (rounded down), so the dollar part of 1,653 is 827.
    expect(text).toContain(
      "| 3 | r2 / r2 | 0.00165255 / 0.00165255 | TRADER-2 → ISSUER-B | 1 unit of raw work | 1 SIU = 0.001653 USD = 1,000 mSIU of fSIU (print 0.00165255) | USDC + fSIU (500 mSIU + 827 USDC minor units) | paid; unit of raw work received | (none given) |",
    );
  });

  it("says plainly when a payment was made with no reason given, and escapes the table's own separator in a reason", () => {
    expect(text).toContain("(none given)");
    expect(text).not.toMatch(/conserve USDC \| and a pipe \|/);
  });

  it("lists what was asked for and never paid, with its price", () => {
    expect(text).toContain("## Asked for but never paid");
    expect(text).toContain(
      "qr-4, round 3, print 0.001404667: TRADER-2 asked TRADER-4 for a TYPE-1 job; it was never quoted. Price: 1.2 SIU = 0.001686 USD = 1,200 mSIU of fSIU (print 0.001404667).",
    );
  });

  it("states the headline, the order of routes the lab used, each trader's use of each asset, and the print by round", () => {
    expect(text).toContain("Payments: **1 in USDC, 1 from a held claim, 1 split**");
    expect(text).toContain("fSIU first; routes pay_split, pay_with_usdc, pay_with_held_claim");
    expect(text).toContain("round 1 1437000, round 2 1652550, round 3 1404667");
    expect(text).toContain("| TRADER-4 | grok-4.6 |");
  });

  describe("every decision, in the order it was taken (D52)", () => {
    const ledger = text.slice(text.indexOf("## Every decision, in the order it was taken"), text.indexOf("## Each trader"));

    it("opens with the endowment and lists requests, quotes, payments, waits and refusals, each with its round and print", () => {
      expect(ledger).toContain("**Endowment** (before any turn): TRADER-1 8,364 USDC minor units and 4,400 mSIU of fSIU;");
      expect(ledger).toContain("- **1. Turn 1, round 1, print 0.001437 — TRADER-1 asks for a quote from TRADER-2 for a TYPE-3 job (qr-1)**");
      expect(ledger).toContain("- **2. Turn 1, round 1, print 0.001437 — TRADER-2 issues the quote qr-1 to TRADER-1**");
      expect(ledger).toContain("- **3. Turn 2, round 1, print 0.001437 — TRADER-1 pays TRADER-2 for a TYPE-3 job (qr-1) with `pay_with_usdc`**");
      expect(ledger).toContain("- **6. Turn 6, round 3, print 0.001404667 — TRADER-2 waits**");
      expect(ledger).toContain("- **7. Turn 7, round 3, print 0.001404667 — TRADER-1 asks for a quote**");
    });

    it("orders by the loop's own counter, not by each agent's turn number", () => {
      const at = (s: string): number => ledger.indexOf(s);
      expect(at("TRADER-2 issues the quote qr-1")).toBeGreaterThan(at("TRADER-1 asks for a quote"));
      expect(at("TRADER-1 pays TRADER-2")).toBeGreaterThan(at("TRADER-2 issues the quote qr-1"));
      expect(at("TRADER-4 pays TRADER-2")).toBeGreaterThan(at("TRADER-1 pays TRADER-2"));
      // Agent turn 1 (TRADER-2's issue) comes before agent turn 2 (TRADER-1's payment) only because the loop took it first.
      const shuffled = renderOverview(report({ decisions: report().decisions!.map((d) => (d.tool === "issue_quote" ? { ...d, seq: 9 } : d)) }));
      const l2 = shuffled.slice(shuffled.indexOf("## Every decision"), shuffled.indexOf("## Each trader"));
      expect(l2.indexOf("TRADER-2 issues the quote qr-1")).toBeGreaterThan(l2.indexOf("TRADER-4 pays TRADER-2"));
    });

    it("marks each round where it first appears, with its print and the move from the last", () => {
      expect(ledger).toContain("### Round 1 — print 0.001437 USD per SIU");
      expect(ledger).toContain("### Round 2 — print 0.00165255 USD per SIU (the previous round's was 0.001437)");
      expect(ledger).toContain("### Round 3 — print 0.001404667 USD per SIU (the previous round's was 0.00165255)");
    });

    it("gives each decision its price, the asset it used, what it held, its outcome, its stated reason and its raw reply", () => {
      expect(ledger).toContain("  - Price: 1.2 SIU = 0.001725 USD = 1,200 mSIU of fSIU (print 0.001437)");
      expect(ledger).toContain("  - Asset used: USDC (1,725 USDC minor units)");
      expect(ledger).toContain("  - Held 4,400 mSIU of fSIU before paying; raw work still to buy after this payment: 0; the fSIU held could have paid this quote in full.");
      expect(ledger).toContain("  - Outcome: paid");
      expect(ledger).toContain('  - Stated reason: "ask TRADER-2"');
      expect(ledger).toContain("  - Stated reason: (none given)");
      expect(ledger).toContain('  - Raw reply: `{"tool":"pay_with_usdc","args":{"requestId":"qr-1"},"rationale":"I have sufficient USDC (0.008364 USD > 0.001725 USD required)."}`');
    });

    it("states a refusal with the lab's own sentence, and what was on a wait's screen", () => {
      expect(ledger).toContain("  - Outcome: refused before it ran: a job is priced at 1.2 SIU.");
      expect(ledger).toContain("  - On its screen: a quote it was sent and has not paid");
      expect(ledger).toContain("  - Outcome: waited");
    });

    it("shows any reasoning the provider returned, and says when none came back and whether tokens were billed for it", () => {
      expect(ledger).toContain('  - Reasoning returned by the provider: "I hold 4,400 mSIU of fSIU; the quote is 1,200 mSIU."');
      expect(ledger).toContain("  - Reasoning returned by the provider: none (900 reasoning tokens billed, text not returned)");
      expect(ledger).toContain("  - Reasoning returned by the provider: none\n");
    });

    it("ends with the expiries the operator swept", () => {
      expect(text).toContain("**Expiries** (swept by the operator after the window closed): TRADER-1 4,400 mSIU; TRADER-4 3,200 mSIU.");
    });

    it("lists a reply that could not be read as a call, which is not a decision", () => {
      const unread = renderOverview(report({ refusals: [{ agentId: "WORKER-CODE", turn: 8, seq: 8, kind: "format", sentence: "Unparseable model response: I think I will wait." }] }));
      expect(unread).toContain("Replies that could not be read as a call (not decisions):");
      expect(unread).toContain("- TRADER-2, turn 8: Unparseable model response: I think I will wait.");
    });
  });

  it("reports, for each payment made while holding fSIU, what the payer still had to buy and what it paid in (H2, decision level)", () => {
    expect(text).toContain("## H2 at the decision level: every payment made while holding fSIU");
    expect(text).toContain("| Payer | Round | For | Held before paying (mSIU) | Raw work still to buy | Could the fSIU have paid it in full | Paid in |");
    expect(text).toContain("| TRADER-1 | 1 | a job | 4,400 | 0 | yes | USDC |");
    expect(text).toContain("Hedging predicts the first group pays USDC and the second spends fSIU; inertia predicts USDC from both.");
  });

  it("states the sampling each request was actually sent with, and what 'provider-default' means (D59)", () => {
    expect(text).toContain("Sampling each request was actually sent with: TRADER-1 0.7; TRADER-2 provider-default (1 of 4 turns not reported).");
    expect(text).toContain('"provider-default" means no temperature was sent: the model does not accept the lab\'s 0.7.');
  });

  it("states per model what its provider returned of its reasoning, and what it did not (D52)", () => {
    expect(text).toContain("## Reasoning each model returned");
    expect(text).toContain("No extended thinking was switched on and no reasoning effort was changed to get more.");
    expect(text).toContain("- TRADER-1 (claude-haiku-4-5): no reasoning text returned and no reasoning tokens billed over 3 turns.");
    expect(text).toContain("- TRADER-2 (gpt-5.1): 900 reasoning tokens billed over 4 turns and no reasoning text returned: the provider does not hand it back at the lab's settings.");
    expect(text).toContain("- TRADER-4 (grok-4.6): reasoning text returned on 1 of 2 turns (52 characters; 1400 reasoning tokens billed).");
  });

  it("shows what traders said that mentions the print, holding, expiry or conserving — on any call, a wait included", () => {
    expect(text).toMatch(/TRADER-2, round 3, turn 6, `wait`: the print is up 15%/);
    expect(text).toMatch(/TRADER-4, round 2, turn 4, `pay_with_held_claim`: paying with held fSIU to conserve USDC/);
  });

  it("states the stated-reason coverage and the emphasis check", () => {
    expect(text).toContain("## Stated reasons: coverage, and the emphasis check");
    expect(text).toContain("A rationale accompanied 2 of 3 (67%) payment calls and 2 of 4 (50%) of every other call.");
    expect(text).toContain("No emphasis effect");
    expect(text).toContain("the raw reply is authoritative");
  });

  it("raises the emphasis flag when only payments carry reasons", () => {
    const only = report({
      decisions: [
        ...Array.from({ length: 6 }, (_, i): DecisionRecord => ({ agentId: "ORCHESTRATOR", turn: i, tool: "pay_with_usdc", rationale: "r" })),
        ...Array.from({ length: 6 }, (_, i): DecisionRecord => ({ agentId: "ORCHESTRATOR", turn: 20 + i, tool: "request_quote" })),
      ],
    });
    expect(renderOverview(only)).toContain("EMPHASIS FLAG");
  });

  it("keeps two questions apart: whether it was a sound run of its own instrument, and whether it pools with the current one", () => {
    const older = renderOverview(report({ instrument: { version: LAB_INSTRUMENT_VERSION - 1 } }));
    expect(older).toContain("A sound run of its own instrument: yes");
    expect(older).toContain("Pooled with runs under the current instrument (v" + LAB_INSTRUMENT_VERSION + "): no — made under another version");
    const stopped = renderOverview(report({ haltedReason: { "WORKER-CODE": "adapter_error" } }));
    expect(stopped).toMatch(/A sound run of its own instrument: NO — a seat was stopped by its provider/);
  });

  it("leaves the issuer service's replies out of the decisions: no model is behind them", () => {
    const withService = report({ decisions: [...report().decisions!, { agentId: "ISSUER-B", turn: 1, tool: "issue_quote" }] });
    expect(renderOverview(withService)).toContain("A rationale accompanied 2 of 3 (67%) payment calls and 2 of 4 (50%) of every other call.");
  });

  it("says where the decisions came from when they were rebuilt, and that none are shown when they cannot be", () => {
    expect(renderOverview(report(), { decisionsNote: "rebuilt from the recorder folder" })).toContain("> rebuilt from the recorder folder");
    const none = renderOverview(report({ decisions: undefined }), { decisionsNote: "no recorder folder" });
    expect(none).toContain("(decision not recorded)");
    expect(none).toContain("No decisions are recorded for this run");
  });

  it("draws no conclusion of its own about why an agent chose what it chose", () => {
    expect(text).not.toMatch(/\bbecause\b.*\b(agents|traders) (prefer|default)/i);
    expect(text).not.toMatch(/\b(prefers?|defaults? to|habit|bias)\b/i);
  });

  it("renders a scripted walk and an older report without the newer fields, without failing", () => {
    const old = report({ prints: undefined, models: undefined, opening: undefined, decisions: undefined, refusals: undefined, lag: undefined, turnsByAgent: undefined, routeOrder: undefined, thinkingCapture: undefined });
    expect(() => renderOverview(old)).not.toThrow();
    expect(renderOverview(report({ scripted: true }))).toContain("a scripted walk (no model was called)");
    expect(renderOverview(old)).toContain("Not recorded: this report predates the capture.");
  });

  it("says, at the top of a report made before v8, that it is not a test of H1 or H2 and states its prices as they were, not as SIU (D53)", () => {
    const v7 = renderOverview(
      report({
        instrument: { version: 7 },
        paymentMoments: [{ agentId: "ORCHESTRATOR", turn: 2, tool: "pay", requestId: "qr-1", heldReceivedMilliSiu: "0", quotedUsdMax: "0.0017" }],
      }),
    );
    expect(v7).toContain("Made before instrument v8: no agent in this run saw a quote in SIU or its own fSIU holdings, so it is not a test of H1 or H2.");
    expect(v7).toContain("$0.0017 (a quote not denominated in SIU: made before instrument v8)");
    expect(v7).toContain("Not recorded: reports made before instrument v8 do not carry what the payer held at each payment.");
    expect(text).not.toContain("Made before instrument v8");
  });
});
