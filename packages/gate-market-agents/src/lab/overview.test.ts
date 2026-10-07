import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import type { DecisionRecord } from "./decisions.js";
import { renderOverview, type OverviewReport } from "./overview.js";

const SEATS = { "TRADER-1": "ORCHESTRATOR", "TRADER-2": "WORKER-CODE", "TRADER-3": "WORKER-EXTRACT", "TRADER-4": "ISSUER-A" };
const traders = (fsiu: string, needsMet = 0) => Object.keys(SEATS).map((t) => ({ trader: t, usdcMinor: "8583", fsiuMilliSiu: fsiu, needsMet, resultNano: "15000000" }));

/** A small model run with three payments — one in each asset — and a print that moved. */
function report(over: Partial<OverviewReport> = {}): OverviewReport {
  const decisions: DecisionRecord[] = [
    { agentId: "ORCHESTRATOR", turn: 2, round: 1, tool: "pay_with_usdc", requestId: "qr-1", rationale: "I have sufficient USDC (0.008583 USD > 0.0017 USD required)." },
    { agentId: "ISSUER-A", turn: 4, round: 2, tool: "pay_with_held_claim", requestId: "qr-2", rationale: "paying with held fSIU to conserve USDC | and a pipe" },
    { agentId: "WORKER-CODE", turn: 5, round: 2, tool: "pay_split", requestId: "qr-3" },
    { agentId: "ORCHESTRATOR", turn: 1, round: 1, tool: "request_quote", rationale: "ask TRADER-2" },
    { agentId: "WORKER-CODE", turn: 6, round: 3, tool: "wait", rationale: "the print is up 15%, so I will expect it to settle" },
  ];
  return {
    runId: "lab-test", seed: 1, scripted: false, params: DEFAULT_PARAMS, print: { rateUsdPerSiu: "0.001437" }, seats: SEATS,
    models: { "TRADER-1": "claude-haiku-4-5", "TRADER-2": "gpt-5.1", "TRADER-3": "claude-haiku-4-5", "TRADER-4": "grok-4.6" },
    prints: { byRound: ["1437000", "1652550", "1404667"], stepBps: 1500 },
    opening: { fsiuMilliSiuPerTrader: "4516" },
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
      { agentId: "ORCHESTRATOR", turn: 2, tool: "pay", requestId: "qr-1", heldReceivedMilliSiu: "0", quotedUsdMax: "0.0017" },
      { agentId: "ISSUER-A", turn: 4, tool: "transfer_claim", requestId: "qr-2", heldReceivedMilliSiu: "0", quotedUsdMax: "0.0020" },
      { agentId: "WORKER-CODE", turn: 5, tool: "settle_split_held", requestId: "qr-3", heldReceivedMilliSiu: "1211", quotedUsdMax: "0.0017" },
    ],
    capacityEvents: [
      { kind: "transfer_claim", agentId: "ISSUER-A", quantityMilliSiu: "1211", settlesRequestId: "qr-2" },
      { kind: "transfer_claim", agentId: "WORKER-CODE", quantityMilliSiu: "500", settlesRequestId: "qr-3" },
    ],
    operatorActions: [], snapshots: [{ label: "opening", round: 1, traders: traders("4516") }], final: { traders: traders("4000", 1) },
    measuredBeforeClose: true, needsMet: { "TRADER-1": 1, "TRADER-2": 0, "TRADER-3": 0, "TRADER-4": 0 },
    totalRealizedUsd: "0.100000", workCostUsd: "0.004000", labErrors: [], pool: { whole: true, restored: true },
    instrument: { version: LAB_INSTRUMENT_VERSION },
    haltedReason: { "WORKER-CODE": "nothing_to_act_on" }, turnsByAgent: { ORCHESTRATOR: 3, "WORKER-CODE": 4 },
    refusals: [{ agentId: "ORCHESTRATOR", turn: 7, kind: "refused", sentence: "a job is priced at 0.00198306 USD per SIU." }],
    toolErrors: [], lag: { writesRetried: 1, recovered: 1, gaveUp: 0 }, spendByProvider: { anthropic: "0.1", xai: "0.0" },
    decisions,
    ...over,
  };
}

describe("the overview every run carries", () => {
  const text = renderOverview(report());

  it("lists every payment with who paid whom, for what, at what price, in what asset, and the payer's own words", () => {
    expect(text).toContain("| 1 | r1 / r1 | TRADER-1 → TRADER-2 | a TYPE-3 job | $0.0017 | USDC (1700 USDC-minor) | yes | I have sufficient USDC (0.008583 USD > 0.0017 USD required). |");
    expect(text).toContain("| 2 | r2 / r2 | TRADER-4 → TRADER-2 | a TYPE-3 job | $0.0020 | fSIU (1211 mSIU) | NO | paying with held fSIU to conserve USDC \\| and a pipe |");
    // The payee of raw work is the issuer, named so; a split shows both parts, the dollar part being the price less the claim's value at its print.
    // 500 mSIU at round 2's print of 1,652,550 is worth 826 minor units (rounded down), so the dollar part of the $0.0017 is 874.
    expect(text).toContain("| 3 | r2 / r2 | TRADER-2 → ISSUER-B | 1 unit of raw work | $0.0017 | USDC + fSIU (500 mSIU + 874 USDC-minor) | — | (none given) |");
  });

  it("says plainly when a payment was made with no reason given, and escapes the table's own separator in a reason", () => {
    expect(text).toContain("(none given)");
    expect(text).not.toMatch(/conserve USDC \| and a pipe/);
  });

  it("lists what was asked for and never paid", () => {
    expect(text).toContain("## Asked for but never paid");
    expect(text).toContain("qr-4: TRADER-2 asked TRADER-4 for a job; it was never quoted.");
  });

  it("states the headline, each trader's use of each asset, and the print by round", () => {
    expect(text).toContain("Payments: **1 in USDC, 1 from a held claim, 1 split**");
    expect(text).toContain("round 1 1437000, round 2 1652550, round 3 1404667");
    expect(text).toContain("| TRADER-4 | grok-4.6 |");
  });

  it("shows what traders said that mentions the print, holding, expiry or conserving — on any call, a wait included", () => {
    expect(text).toContain("TRADER-3");
    expect(text).toMatch(/TRADER-2, round 3, turn 6, `wait`: the print is up 15%/);
    expect(text).toMatch(/TRADER-4, round 2, turn 4, `pay_with_held_claim`: paying with held fSIU to conserve USDC/);
  });

  it("states the stated-reason coverage and the emphasis check", () => {
    expect(text).toContain("## Stated reasons: coverage, and the emphasis check");
    expect(text).toContain("A rationale accompanied 2 of 3 (67%) payment calls and 2 of 2 (100%) of every other call.");
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
    expect(renderOverview(withService)).toContain("A rationale accompanied 2 of 3 (67%) payment calls and 2 of 2 (100%) of every other call.");
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
    const old = report({ prints: undefined, models: undefined, opening: undefined, decisions: undefined, refusals: undefined, lag: undefined, turnsByAgent: undefined });
    expect(() => renderOverview(old)).not.toThrow();
    expect(renderOverview(report({ scripted: true }))).toContain("a scripted walk (no model was called)");
  });
});
