import { describe, expect, it } from "vitest";
import { renderPurchaseSummary, summarisePurchases } from "./purchases.js";
import type { CapacityEvent, FullRunWindowResult } from "./full-run.js";

const result = (
  events: Partial<CapacityEvent>[] | Record<string, never>,
  logs: Record<
    string,
    { turn: number; parsed: string; toolCall?: { name: string; ok: boolean } }[]
  > = {},
): FullRunWindowResult =>
  ({
    capacityEvents: (Array.isArray(events) ? events : []).map((e) => ({
      agentId: "ORCHESTRATOR",
      turn: 1,
      kind: "mint_claim",
      ...e,
    })),
    turnLogsByAgent: logs,
  }) as unknown as FullRunWindowResult;

describe("summarisePurchases", () => {
  it("attributes each decision to its own buyer and never pools them", () => {
    // Phase 5's shape: two deciders, buying different things, in different assets. A pooled
    // "1 of 2 chose fSIU" would describe neither of them.
    const s = summarisePurchases(
      result(
        [{ agentId: "ORCHESTRATOR", turn: 1, kind: "pay_with_claim", quantityMilliSiu: "10000", tokenId: "1" }],
        { "WORKER-CODE": [{ turn: 3, parsed: '{"tool": "pay"}' }] },
      ),
    );
    expect(s.decisions).toHaveLength(2);
    expect(s.decisions.find((d) => d.buyer === "ORCHESTRATOR")?.asset).toBe("fsiu");
    expect(s.decisions.find((d) => d.buyer === "WORKER-CODE")?.asset).toBe("usdc");
    const lines = renderPurchaseSummary(s).join("\n");
    expect(lines).toContain("ORCHESTRATOR: 0 in USDC, 1 in fSIU");
    expect(lines).toContain("WORKER-CODE: 1 in USDC, 0 in fSIU");
  });

  it("does NOT count a dollar payment that failed as a settled USDC purchase", () => {
    // The mirror of spec §4.6af, found while fixing it. On a failed tool call the loop records
    // `parsed` as `{"tool":"pay",...} -> tool call error: ...`, which still contains `"pay"` —
    // so a reverted or refused payment was reported as a settled one. The dollar route's success
    // was never observed from a fact, only guessed from the text of the model's own tool call,
    // and that one mistake produced an over-count here and an under-count in the classifier.
    const s = summarisePurchases(
      result({}, {
        ORCHESTRATOR: [
          {
            turn: 1,
            parsed: '{"tool":"pay","args":{"requestId":"qr-1"}} -> tool call error: reverted NoIssuerWithHeadroom',
            toolCall: { name: "pay", ok: false },
          },
        ],
      }),
    );
    expect(s.decisions).toHaveLength(0);
    expect(renderPurchaseSummary(s).join("\n")).toContain("no purchase decision was reached");
  });

  it("counts a dollar payment that genuinely returned", () => {
    const s = summarisePurchases(
      result({}, {
        ORCHESTRATOR: [
          { turn: 2, parsed: '{"tool":"pay","args":{"requestId":"qr-1"}}', toolCall: { name: "pay", ok: true } },
        ],
      }),
    );
    expect(s.decisions).toHaveLength(1);
    expect(s.decisions[0]?.asset).toBe("usdc");
  });

  it("records a split with its ratio rather than collapsing it to one asset", () => {
    const s = summarisePurchases(
      result([{ agentId: "WORKER-CODE", turn: 2, kind: "settle_split", claimShare: "0.3000", tokenId: "7" }]),
    );
    expect(s.decisions[0]?.asset).toBe("split");
    expect(s.decisions[0]?.claimShare).toBe("0.3000");
    expect(renderPurchaseSummary(s).join("\n")).toContain("1 split (claim share 0.3000)");
  });

  it("counts a claim PASSED ONWARD separately from one redeemed — the circulation result", () => {
    const s = summarisePurchases(
      result([
        { agentId: "ORCHESTRATOR", turn: 1, kind: "pay_with_claim", tokenId: "9" },
        { agentId: "WORKER-CODE", turn: 4, kind: "transfer_claim", tokenId: "9" },
      ]),
    );
    const j = s.journeys.find((x) => x.tokenId === "9");
    expect(j?.outcome).toBe("passed_onward");
    expect(j?.hops).toBe(1);
    expect(j?.turnsHeld).toBe(3);
    expect(renderPurchaseSummary(s).join("\n")).toContain("PASSED ONWARD rather than redeemed: 1");
  });

  it("says plainly when fSIU settled without circulating — the result of every run so far", () => {
    const s = summarisePurchases(
      result([
        { agentId: "ORCHESTRATOR", turn: 1, kind: "pay_with_claim", tokenId: "2" },
        { agentId: "WORKER-CODE", turn: 2, kind: "redeem_claim", tokenId: "2" },
      ]),
    );
    expect(s.journeys[0]?.outcome).toBe("redeemed");
    expect(s.journeys[0]?.turnsHeld).toBe(1);
    expect(renderPurchaseSummary(s).join("\n")).toContain("it did not circulate");
  });
});
