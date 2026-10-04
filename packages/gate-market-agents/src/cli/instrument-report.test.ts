import { describe, expect, it } from "vitest";
import { buildF1Report, type WindowFacts } from "./instrument-report.js";

const B = "0xB000000000000000000000000000000000000001";
const A = "0xA000000000000000000000000000000000000001";

const mint = (issuer?: string, kind = "mint_claim") => ({ kind, ...(issuer ? { issuer } : {}) });
const moment = (agentId: string, tool: string, held: string) => ({ agentId, tool, heldReceivedMilliSiu: held });

const w = (windowIndex: number, events: WindowFacts["capacityEvents"], moments: WindowFacts["paymentMoments"] = []): WindowFacts => ({
  windowIndex,
  capacityEvents: events,
  paymentMoments: moments,
});

describe("buildF1Report", () => {
  it("is clean when every window-1 mint, of any kind, is backed by the expected issuer", () => {
    const r = buildF1Report(
      [w(1, [mint(B), mint(B, "pay_with_claim"), mint(B, "settle_split")])],
      B,
    );
    expect(r.clean).toEqual({ expectedIssuer: B, clean: true, mints: 3, backedByOthers: 0 });
  });

  it("is unclean when a window-1 mint was backed by the other issuer, and says how many", () => {
    const r = buildF1Report([w(1, [mint(B), mint(A), mint(A, "pay_with_claim")])], B);
    expect(r.clean).toMatchObject({ clean: false, mints: 3, backedByOthers: 2 });
  });

  it("does NOT read later windows: a window-2 mint backed by the other issuer is the design, not contamination", () => {
    const r = buildF1Report([w(1, [mint(B)]), w(2, [mint(A), mint(A)]), w(3, [mint(A)])], B);
    expect(r.clean).toEqual({ expectedIssuer: B, clean: true, mints: 1, backedByOthers: 0 });
  });

  it("counts a mint whose issuer was not recorded as unclean — an unknown backer is not a clean one", () => {
    const r = buildF1Report([w(1, [mint(B), mint(undefined)])], B);
    expect(r.clean).toMatchObject({ clean: false, backedByOthers: 1 });
  });

  it("ignores events that are not mints", () => {
    const r = buildF1Report([w(1, [mint(B), { kind: "transfer_claim" }, { kind: "redeem_claim", issuer: A }])], B);
    expect(r.clean).toMatchObject({ clean: true, mints: 1 });
  });

  it("derives opportunity from window 1's moments only", () => {
    const r = buildF1Report(
      [
        w(1, [mint(B)], [moment("ORCHESTRATOR", "pay", "0"), moment("WORKER-CODE", "transfer_claim", "5000")]),
        w(2, [], [moment("ORCHESTRATOR", "transfer_claim", "9000")]),
      ],
      B,
    );
    expect(r.opportunities).toEqual({
      ORCHESTRATOR: { eligible: false, spentOnward: false },
      "WORKER-CODE": { eligible: true, spentOnward: true },
    });
  });

  it("states that window 1 was not reached rather than reporting an empty clean window", () => {
    const r = buildF1Report([], B);
    expect(r).toMatchObject({ reached: false, cleanNotComputedBecause: "window 1 was not reached" });
    expect(r.clean).toBeUndefined();
  });

  it("states why cleanliness is not computed when the instrument names no expected issuer", () => {
    const r = buildF1Report([w(1, [mint(A)])], undefined);
    expect(r.clean).toBeUndefined();
    expect(r.cleanNotComputedBecause).toMatch(/no expected issuer/);
  });
});
