import { describe, expect, it } from "vitest";
import { renderPurchaseSummary, summarisePurchases } from "./purchases.js";
import type { CapacityEvent, FullRunWindowResult } from "./full-run.js";

const result = (
  events: Partial<CapacityEvent>[],
  logs: Record<string, { turn: number; parsed: string }[]> = {},
): FullRunWindowResult =>
  ({
    capacityEvents: events.map((e) => ({ agentId: "ORCHESTRATOR", turn: 1, kind: "mint_claim", ...e })),
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
