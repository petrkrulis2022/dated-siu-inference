import { describe, expect, it } from "vitest";
import { ClaimLedger } from "./claim-ledger.js";
import type { CapacityEvent } from "./full-run.js";

const ADDR: Record<string, "ORCHESTRATOR" | "WORKER-CODE" | "WORKER-EXTRACT"> = {
  "0xorch": "ORCHESTRATOR",
  "0xcode": "WORKER-CODE",
  "0xextract": "WORKER-EXTRACT",
};
const resolve = (a: string) => ADDR[a.toLowerCase()];
const ev = (e: Partial<CapacityEvent> & Pick<CapacityEvent, "agentId" | "kind">): CapacityEvent =>
  ({ turn: 1, ...e }) as CapacityEvent;

describe("ClaimLedger", () => {
  it("credits the RECIPIENT of a claim payment, never the payer", () => {
    const l = new ClaimLedger();
    l.apply(
      ev({ agentId: "ORCHESTRATOR", kind: "pay_with_claim", tokenId: "7", quantityMilliSiu: "10000", counterparty: "0xCODE" }),
      resolve,
    );
    expect(l.heldReceived("WORKER-CODE")).toBe(10000n);
    expect(l.heldReceived("ORCHESTRATOR")).toBe(0n);
    expect(l.heldTotal("ORCHESTRATOR")).toBe(0n);
  });

  it("keeps a claim an agent MINTED apart from one it was GIVEN", () => {
    // The rule is about claims that arrive from somebody else and are passed on. A claim an agent
    // minted for itself was not given to it, so it must not make the agent eligible.
    const l = new ClaimLedger();
    l.apply(ev({ agentId: "WORKER-CODE", kind: "mint_claim", tokenId: "9", quantityMilliSiu: "5000" }), resolve);
    expect(l.heldReceived("WORKER-CODE")).toBe(0n);
    expect(l.heldTotal("WORKER-CODE")).toBe(5000n);
  });

  it("moves a held claim on, debiting the sender and crediting the recipient as received", () => {
    const l = new ClaimLedger();
    l.apply(ev({ agentId: "ORCHESTRATOR", kind: "pay_with_claim", tokenId: "7", quantityMilliSiu: "10000", counterparty: "0xcode" }), resolve);
    l.apply(ev({ agentId: "WORKER-CODE", kind: "transfer_claim", tokenId: "7", quantityMilliSiu: "4000", counterparty: "0xextract" }), resolve);
    expect(l.heldReceived("WORKER-CODE")).toBe(6000n);
    expect(l.heldReceived("WORKER-EXTRACT")).toBe(4000n);
  });

  it("treats a settle_split's claim leg as received by the quote's seller", () => {
    const l = new ClaimLedger();
    l.apply(ev({ agentId: "ORCHESTRATOR", kind: "settle_split", tokenId: "8", quantityMilliSiu: "3000", counterparty: "0xcode" }), resolve);
    expect(l.heldReceived("WORKER-CODE")).toBe(3000n);
  });

  it("debits RECEIVED before minted when an agent holds both of one token", () => {
    // The rule asks about the received claim going onward, so that is the one treated as spent.
    const l = new ClaimLedger();
    l.mint("WORKER-CODE", "7", 2000n);
    l.receive("WORKER-CODE", "7", 3000n);
    l.transfer("WORKER-CODE", "WORKER-EXTRACT", "7", 3000n);
    expect(l.heldReceived("WORKER-CODE")).toBe(0n);
    expect(l.heldTotal("WORKER-CODE")).toBe(2000n);
  });

  it("never goes negative, and credits only what was actually debited", () => {
    // A transfer larger than the ledger knows of is a gap in the record. The chain, which would
    // have reverted, is the authority; the ledger must not invent claims to cover it.
    const l = new ClaimLedger();
    l.receive("WORKER-CODE", "7", 1000n);
    l.transfer("WORKER-CODE", "WORKER-EXTRACT", "7", 5000n);
    expect(l.heldReceived("WORKER-CODE")).toBe(0n);
    expect(l.heldReceived("WORKER-EXTRACT")).toBe(1000n);
  });

  it("ignores addresses that are not agents, and events that carry no claim", () => {
    const l = new ClaimLedger();
    l.apply(ev({ agentId: "ORCHESTRATOR", kind: "pay_with_claim", tokenId: "7", quantityMilliSiu: "10000", counterparty: "0xstranger" }), resolve);
    l.apply(ev({ agentId: "WORKER-CODE", kind: "redeem_claim", tokenId: "7" }), resolve);
    l.apply(ev({ agentId: "WORKER-CODE", kind: "reserve_for_work", quantityMilliSiu: "10000" }), resolve);
    expect(l.heldTotal("WORKER-CODE")).toBe(0n);
  });

  it("does not change on presenting a claim — redeeming is not spending", () => {
    const l = new ClaimLedger();
    l.receive("WORKER-CODE", "7", 10000n);
    l.apply(ev({ agentId: "WORKER-CODE", kind: "redeem_claim", tokenId: "7", quantityMilliSiu: "10000" }), resolve);
    expect(l.heldReceived("WORKER-CODE")).toBe(10000n);
  });
});
