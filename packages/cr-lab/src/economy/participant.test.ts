import { beforeEach, describe, expect, it } from "vitest";
import { BUFFER, MemoryChain, PARTICIPANT, RESERVE } from "./memory-chain.js";
import { Participant, ParticipantRefused } from "./participant.js";

const DAY = 86_400;
const T0 = 1_800_000_000;
const RATE = 13_163_480n;
let chain: MemoryChain;
let p: Participant;

beforeEach(() => {
  chain = new MemoryChain(
    {
      reserveSeries: "commodity",
      minTenorSeconds: DAY / 2,
      discountBps: 1_000n,
      bufferTarget: 1_000_000n,
    },
    "agu-issuer",
    () => T0,
  );
  chain.mintTestUsdc("C1", 10_000_000n);
  chain.createLot("C1", "CR-PL", 100n, 1_000n, 5_000_000n);
  chain.mintTestUsdc(PARTICIPANT, 1_000_000n);
  const id = chain.mint(PARTICIPANT, "CR-PL", "commodity", 10_000n, T0 + DAY, T0 + 2 * DAY, RATE);
  chain.create(PARTICIPANT, id, 10_000n); // 10 AGU-lab, NAV 1
  chain.seedBuffer("C1", 500_000n);
  chain.mintTestUsdc("agent", 1_000_000n);
  p = new Participant(chain, 200n, 1_000n);
  p.startWindow();
});

describe("the participant's prices (Q10: NAV × the Commodity print)", () => {
  it("sells at NAV × print plus half the spread and buys back at minus half, rounding in its own favour", () => {
    // 1 AGU-lab at NAV 1 = 1 SIU = 13,163,480 nano-USD = 13,163.48 USDC base units
    const q = p.quote(1_000_000n, RATE);
    expect(q.ask).toBe(13_296n); // 13,163.48 × 1.01 = 13,295.1148 → up
    expect(q.bid).toBe(13_031n); // 13,163.48 × 0.99 = 13,031.8452 → down
  });

  it("an agent buys from inventory at the ask and the units fit the USDC offered", () => {
    const units = p.unitsFor(26_590n, RATE);
    expect(p.quote(units, RATE).ask).toBeLessThanOrEqual(26_590n);
    expect(p.quote(units + 1n, RATE).ask).toBeGreaterThan(26_590n);
    p.sell("agent", units, RATE);
    expect(chain.balance("agent", "AGU")).toBe(units);
  });
});

describe("test 3 (must fail loudly): the participant refuses beyond its cap or its own USDC", () => {
  it("refuses a buy-back beyond 10% of the window's opening supply, and nothing moves", () => {
    chain.transfer("AGU", PARTICIPANT, "agent", 2_000_000n);
    p.buyBack("agent", 1_000_000n, RATE); // exactly the cap: 10% of 10 AGU-lab
    const before = snapshot();
    expect(() => p.buyBack("agent", 1n, RATE)).toThrow(ParticipantRefused);
    expect(() => p.buyBack("agent", 1n, RATE)).toThrow(/buy-back cap/);
    expect(snapshot()).toEqual(before);
  });

  it("refuses when its own USDC runs out, and the reserve's and the buffer's balances do not move", () => {
    chain.transfer("USDC", PARTICIPANT, "agent", chain.balance(PARTICIPANT, "USDC") - 100n);
    chain.transfer("AGU", PARTICIPANT, "agent", 1_000_000n);
    const before = snapshot();
    expect(() => p.buyBack("agent", 1_000_000n, RATE)).toThrow(/own USDC has run out/);
    expect(snapshot()).toEqual(before);
  });

  it("starts each window's cap afresh from that window's opening supply", () => {
    chain.transfer("AGU", PARTICIPANT, "agent", 2_000_000n);
    p.buyBack("agent", 1_000_000n, RATE);
    p.startWindow();
    expect(p.boughtBackThisWindow).toBe(0n);
    p.buyBack("agent", 1_000_000n, RATE);
  });
});

function snapshot(): Record<string, string> {
  return {
    reserveUsdc: String(chain.balance(RESERVE, "USDC")),
    bufferUsdc: String(chain.balance(BUFFER, "USDC")),
    participantUsdc: String(chain.balance(PARTICIPANT, "USDC")),
    participantAgu: String(chain.balance(PARTICIPANT, "AGU")),
    agentAgu: String(chain.balance("agent", "AGU")),
    agentUsdc: String(chain.balance("agent", "USDC")),
    liveFace: String(chain.liveFace()),
  };
}
