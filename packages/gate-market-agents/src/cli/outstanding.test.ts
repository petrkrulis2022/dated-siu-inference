import { describe, expect, it } from "vitest";
import type { CapacityEvent, OutstandingClaim } from "../loop/full-run.js";
import { nextOutstanding } from "./outstanding.js";

const ADDR = {
  ORCHESTRATOR: "0x00000000000000000000000000000000000000a1",
  "WORKER-CODE": "0x00000000000000000000000000000000000000b2",
  "WORKER-EXTRACT": "0x00000000000000000000000000000000000000c3",
  "ISSUER-A": "0x00000000000000000000000000000000000000d4",
  "ISSUER-B": "0x00000000000000000000000000000000000000e5",
} as const;

const settle = (tokenId: string, holder?: string): CapacityEvent =>
  ({ agentId: "WORKER-CODE", turn: 1, kind: "settle_window_close", tokenId, ...(holder ? { counterparty: holder } : {}) }) as CapacityEvent;
const redeem = (tokenId: string): CapacityEvent =>
  ({ agentId: "WORKER-CODE", turn: 1, kind: "redeem_claim", tokenId }) as CapacityEvent;

describe("nextOutstanding — what a window leaves for the next one to settle", () => {
  it("lists every holder of a split claim, each with its own quantity and whether it presented", () => {
    // Found by the first scripted walk: one entry per MINT, with the payee as holder, was wrong the
    // moment a claim was passed on — the second holder's share was never settled and its capacity
    // stayed consumed for good.
    const out = nextOutstanding(
      [],
      {
        windowIndex: 1,
        capacityEvents: [],
        claimPositions: [
          { tokenId: "1", holder: "WORKER-CODE", issuer: "ISSUER-B", quantity: "6054", presented: true },
          { tokenId: "1", holder: "WORKER-EXTRACT", issuer: "ISSUER-B", quantity: "3967", presented: false },
        ],
      },
      ADDR,
    );
    expect(out).toEqual([
      { tokenId: "1", holder: ADDR["WORKER-CODE"], holderAgentId: "WORKER-CODE", issuerAgentId: "ISSUER-B", quantityMilliSiu: "6054", mintedInWindow: 1, everPresented: true },
      { tokenId: "1", holder: ADDR["WORKER-EXTRACT"], holderAgentId: "WORKER-EXTRACT", issuerAgentId: "ISSUER-B", quantityMilliSiu: "3967", mintedInWindow: 1, everPresented: false },
    ]);
  });

  it("lists nothing for a window whose every claim was served in full", () => {
    expect(nextOutstanding([], { windowIndex: 1, capacityEvents: [], claimPositions: [] }, ADDR)).toEqual([]);
  });

  it("keeps a holder that is not an agent, by address, rather than losing the claim from view", () => {
    const stranger = "0x00000000000000000000000000000000000000f6";
    const [only] = nextOutstanding(
      [],
      { windowIndex: 2, capacityEvents: [], claimPositions: [{ tokenId: "9", holder: stranger, issuer: "ISSUER-A", quantity: "100", presented: false }] },
      ADDR,
    );
    expect(only).toMatchObject({ tokenId: "9", holder: stranger, issuerAgentId: "ISSUER-A", quantityMilliSiu: "100" });
    expect(only.holderAgentId).toBeUndefined();
  });

  it("drops only the holder whose position was settled, not the token's other holders", () => {
    const carried: OutstandingClaim[] = [
      { tokenId: "1", holder: ADDR["WORKER-CODE"], holderAgentId: "WORKER-CODE", issuerAgentId: "ISSUER-B", quantityMilliSiu: "6054", mintedInWindow: 1, everPresented: true },
      { tokenId: "1", holder: ADDR["WORKER-EXTRACT"], holderAgentId: "WORKER-EXTRACT", issuerAgentId: "ISSUER-B", quantityMilliSiu: "3967", mintedInWindow: 1, everPresented: false },
    ];
    const out = nextOutstanding(
      carried,
      { windowIndex: 2, capacityEvents: [settle("1", ADDR["WORKER-EXTRACT"])], claimPositions: [] },
      ADDR,
    );
    expect(out.map((c) => c.holderAgentId)).toEqual(["WORKER-CODE"]);
  });

  it("matches a settlement by address however the address is cased", () => {
    const carried: OutstandingClaim[] = [
      { tokenId: "1", holder: ADDR["WORKER-CODE"].toUpperCase().replace("0X", "0x"), issuerAgentId: "ISSUER-B", mintedInWindow: 1 },
    ];
    expect(
      nextOutstanding(carried, { windowIndex: 2, capacityEvents: [settle("1", ADDR["WORKER-CODE"])], claimPositions: [] }, ADDR),
    ).toEqual([]);
  });

  it("still drops a claim by token alone when the settlement event carries no holder", () => {
    const carried: OutstandingClaim[] = [
      { tokenId: "1", holder: ADDR["WORKER-CODE"], holderAgentId: "WORKER-CODE", issuerAgentId: "ISSUER-B", mintedInWindow: 1 },
    ];
    expect(nextOutstanding(carried, { windowIndex: 2, capacityEvents: [settle("1")], claimPositions: [] }, ADDR)).toEqual([]);
  });

  it("marks a carried claim presented when it was presented this window", () => {
    const carried: OutstandingClaim[] = [
      { tokenId: "1", holder: ADDR["WORKER-CODE"], holderAgentId: "WORKER-CODE", issuerAgentId: "ISSUER-B", mintedInWindow: 1, everPresented: false },
    ];
    const [c] = nextOutstanding(carried, { windowIndex: 1, capacityEvents: [redeem("1")], claimPositions: [] }, ADDR);
    expect(c.everPresented).toBe(true);
  });

  it("does not mutate what it was given", () => {
    const carried: OutstandingClaim[] = [
      { tokenId: "1", holder: ADDR["WORKER-CODE"], issuerAgentId: "ISSUER-B", mintedInWindow: 1, everPresented: false },
    ];
    nextOutstanding(carried, { windowIndex: 1, capacityEvents: [redeem("1")], claimPositions: [] }, ADDR);
    expect(carried[0].everPresented).toBe(false);
  });
});
