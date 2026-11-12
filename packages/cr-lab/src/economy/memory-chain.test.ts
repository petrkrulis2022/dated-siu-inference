import { beforeEach, describe, expect, it } from "vitest";
import {
  BUFFER,
  INCOME,
  MemoryChain,
  PARTICIPANT,
  RESERVE,
  type AguParams,
} from "./memory-chain.js";
import { usdcFor } from "./units.js";

const DAY = 86_400;
const T0 = 1_800_000_000; // a day boundary is not needed: windows are explicit
const RATE = 13_163_480n; // nano-USD per SIU, the WP0 Commodity print
const PARAMS: AguParams = {
  reserveSeries: "commodity",
  minTenorSeconds: DAY / 2,
  discountBps: 1_000n,
  bufferTarget: 1_000_000n, // 1 test USDC
};

let now = T0;
let c: MemoryChain;
const w = (k: number) => ({ from: T0 + k * DAY, to: T0 + (k + 1) * DAY });

/** C1 bonds a CR-PL lot; the participant buys `milli` of window `k` claims and creates AGU-lab with them */
function seedReserve(milli: bigint, k = 1): string {
  const id = c.mint(PARTICIPANT, "CR-PL", "commodity", milli, w(k).from, w(k).to, RATE);
  c.create(PARTICIPANT, id, milli);
  return id;
}

beforeEach(() => {
  now = T0;
  c = new MemoryChain(PARAMS, "agu-issuer", () => now);
  c.mintTestUsdc("C1", 50_000_000n);
  c.mintTestUsdc("C2", 50_000_000n);
  c.mintTestUsdc(PARTICIPANT, 20_000_000n);
  c.mintTestUsdc("agent-1", 5_000_000n);
  c.createLot("C1", "CR-PL", 100n, 1_000n, 10_000_000n); // limit 50,000 mSIU
  c.createLot("C2", "CR-PL", 100n, 1_000n, 10_000_000n);
});

describe("creation and redemption (R3, R4)", () => {
  it("first creation mints 1,000 base units per mSIU of face; later ones at NAV, rounded down", () => {
    seedReserve(1_000n);
    expect(c.balance(PARTICIPANT, "AGU")).toBe(1_000_000n); // 1 SIU of face = 1 AGU-lab
    // NAV moves to 0.5 SIU per AGU-lab if half the face leaves (simulated by a retired lot)
    const id2 = c.mint(PARTICIPANT, "CR-PL", "commodity", 1_000n, w(1).from, w(1).to, RATE);
    const before = c.nav();
    c.create(PARTICIPANT, id2, 1_000n);
    const after = c.nav();
    // per-unit value unchanged by a creation (exact here)
    expect(after.num * before.den).toBe(before.num * after.den);
  });

  it("creates at NAV when NAV is below 1: a creator gets fewer units per mSIU than at face, and per-unit value is unchanged up to dust", () => {
    const front = seedReserve(2_000n, 1); // 2 AGU-lab, NAV 1
    c.seedBuffer("C2", usdcFor(500n, RATE)); // the buffer covers only a quarter of the face
    now = w(1).from + 60;
    c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [],
      buys: [{ classId: "CR-PL", milli: 500n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    const before = c.nav(); // 500 mSIU behind 2 AGU-lab: NAV 0.25
    expect(before.num * 4n).toBe(before.den);
    const id = c.mint(PARTICIPANT, "CR-PL", "commodity", 1_000n, w(2).from, w(2).to, RATE);
    const units = c.create(PARTICIPANT, id, 1_000n);
    expect(units).toBe(4_000_000n); // 1 SIU of face at NAV 0.25 is 4 AGU-lab, not 1
    const after = c.nav();
    // per-unit value unchanged: after.num/after.den == before.num/before.den
    expect(after.num * before.den).toBe(before.num * after.den);
  });

  it("creates at NAV when NAV is above 1, never diluting existing holders", () => {
    const a = seedReserve(1_000n, 1); // 1 AGU-lab
    c.transfer("AGU", PARTICIPANT, "agent-1", 500_000n);
    c.redeem("agent-1", 1_500n); // floor(1,500 × 1,000 ÷ 1,000,000) = 1 mSIU for 1,500 units: dust stays in the reserve, NAV a hair above 1
    const before = c.nav();
    expect(before.num * 1n > before.den * 1n).toBe(true);
    const id = c.mint(PARTICIPANT, "CR-PL", "commodity", 1_000n, w(1).from, w(1).to, RATE);
    c.create(PARTICIPANT, id, 1_000n);
    const after = c.nav();
    // non-dilution in holders' favour: per-unit value never falls
    expect(after.num * before.den >= before.num * after.den).toBe(true);
    expect(a).toBeDefined();
  });

  it("refuses a Frontier lot, too little tenor, and anyone but the participant", () => {
    c.mintTestUsdc("F", 1n);
    c.createLot("F", "CR-VS", 100n, 1_000n, 1n);
    const fr = c.mint(PARTICIPANT, "CR-VS", "frontier", 10n, w(1).from, w(1).to, RATE);
    expect(() => c.create(PARTICIPANT, fr, 10n)).toThrow(
      /R3: the reserve holds commodity claims only/,
    );
    const late = c.mint(PARTICIPANT, "CR-PL", "commodity", 10n, w(0).from, T0 + 100, RATE);
    expect(() => c.create(PARTICIPANT, late, 10n)).toThrow(/tenor/);
    const ok = c.mint(PARTICIPANT, "CR-PL", "commodity", 10n, w(1).from, w(1).to, RATE);
    c.transferClaim(ok, PARTICIPANT, "agent-1", 10n);
    expect(() => c.create("agent-1", ok, 10n)).toThrow(/only the authorised participant/);
  });

  it("redeems in kind and pro rata over every live lot, never paying USDC or touching the buffer", () => {
    const a = seedReserve(3_000n, 1);
    const b = c.mint(PARTICIPANT, "CR-PL", "commodity", 1_000n, w(2).from, w(2).to, RATE);
    c.create(PARTICIPANT, b, 1_000n);
    c.seedBuffer(PARTICIPANT, 500_000n);
    c.transfer("AGU", PARTICIPANT, "agent-1", 1_000_000n); // a quarter of supply
    const usdcBefore = c.balance("agent-1", "USDC");
    const r = c.redeem("agent-1", 1_000_000n);
    expect(r.lots).toEqual([
      { tokenId: a, milli: 750n, windowTo: w(1).to },
      { tokenId: b, milli: 250n, windowTo: w(2).to },
    ]);
    expect(c.balance("agent-1", "USDC")).toBe(usdcBefore);
    expect(c.balance(BUFFER, "USDC")).toBe(500_000n);
    expect(c.balance(RESERVE, "USDC")).toBe(0n);
  });

  it("refuses a redemption too small to deliver any claim (AguLab: NothingToRedeem), and zero units", () => {
    seedReserve(1_000n);
    c.transfer("AGU", PARTICIPANT, "agent-1", 999n);
    expect(() => c.redeem("agent-1", 999n)).toThrow(/NothingToRedeem/); // 999 × 1000 / 1,000,000 = 0.999 → 0
    expect(c.balance("agent-1", "AGU")).toBe(999n); // nothing burned
    expect(() => c.redeem("agent-1", 0n)).toThrow(/ZeroAmount/);
  });
});

describe("the reserve and the buffer outside the roll", () => {
  it("the reserve never presents, never transfers a claim and never sends USDC outside the roll", () => {
    const id = seedReserve(1_000n);
    now = w(1).from + 10;
    expect(() => c.present(RESERVE, id)).toThrow(/never presents/);
    expect(() => c.transferClaim(id, RESERVE, "agent-1", 1n)).toThrow(
      /only through create, redeem and the roll/,
    );
    c.mintTestUsdc(RESERVE, 5n); // an unsolicited transfer in
    expect(() => c.transfer("USDC", RESERVE, "agent-1", 5n)).toThrow(
      /R5: the reserve holds no USDC outside the roll/,
    );
  });

  it("the buffer pays out only inside the roll; the income ledger only receives", () => {
    c.seedBuffer(PARTICIPANT, 100n);
    expect(() => c.transfer("USDC", BUFFER, "agent-1", 1n)).toThrow(/roll cover/);
    c.transfer("USDC", "agent-1", INCOME, 1n);
    expect(() => c.transfer("USDC", INCOME, "agent-1", 1n)).toThrow(/only ever receives/);
  });
});

describe("the roll (R5 to R7)", () => {
  it("sells front claims at the discounted print, covers the discount and the unsold face from the buffer, restores the face and ends at zero USDC", () => {
    const front = seedReserve(2_000n, 1);
    c.seedBuffer("C2", 1_000_000n);
    now = w(1).from + 60;
    const res = c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [{ buyer: "agent-1", tokenId: front, milli: 1_500n }],
      buys: [{ classId: "CR-PL", milli: 2_000n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    const price = (RATE * 9_000n) / 10_000n;
    expect(res.proceeds).toBe(usdcFor(1_500n, price));
    expect(res.faceSold).toBe(1_500n);
    expect(res.faceUnsold).toBe(500n);
    expect(res.faceBought).toBe(2_000n);
    // sold at a discount to today's print and rebought at it: the gap is the roll cost, paid by the buffer
    expect(res.cover).toBe(usdcFor(2_000n, RATE) - res.proceeds);
    expect(res.carryToBuffer + res.carryToIncome).toBe(0n);
    expect(c.claimBalance("agent-1", front)).toBe(1_500n);
    expect(c.liveFace()).toBe(2_000n); // the retired front lot no longer counts
    expect(c.balance(RESERVE, "USDC")).toBe(0n);
  });

  it("covers a shortfall from the buffer first, never from the participant", () => {
    const front = seedReserve(2_000n, 1);
    c.seedBuffer("C2", 1_000_000n);
    const participantUsdc = c.balance(PARTICIPANT, "USDC");
    now = w(1).from + 60;
    const res = c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [],
      buys: [{ classId: "CR-PL", milli: 2_000n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    expect(res.cover).toBe(usdcFor(2_000n, RATE));
    expect(c.balance(BUFFER, "USDC")).toBe(1_000_000n - usdcFor(2_000n, RATE));
    expect(c.balance(PARTICIPANT, "USDC")).toBe(participantUsdc);
    expect(c.liveFace()).toBe(2_000n); // face restored
  });

  it("with the buffer exhausted, buys the most face it can afford and NAV falls", () => {
    const front = seedReserve(2_000n, 1);
    c.seedBuffer("C2", usdcFor(500n, RATE));
    now = w(1).from + 60;
    const navBefore = c.nav();
    // too much: refused
    expect(() =>
      c.roll("agu-issuer", {
        rate: RATE,
        frontLots: [front],
        sales: [],
        buys: [{ classId: "CR-PL", milli: 2_000n }],
        buyFrom: w(2).from,
        buyTo: w(2).to,
      }),
    ).toThrow(/RollShortfallExceedsBuffer|R6/);
    // too little while more is affordable: refused
    expect(() =>
      c.roll("agu-issuer", {
        rate: RATE,
        frontLots: [front],
        sales: [],
        buys: [{ classId: "CR-PL", milli: 400n }],
        buyFrom: w(2).from,
        buyTo: w(2).to,
      }),
    ).toThrow(/most face it can afford/);
    const res = c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [],
      buys: [{ classId: "CR-PL", milli: 500n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    expect(res.faceBought).toBe(500n);
    expect(c.balance(BUFFER, "USDC")).toBe(0n);
    const navAfter = c.nav();
    expect(navAfter.num * navBefore.den).toBeLessThan(navBefore.num * navAfter.den);
  });

  it("sends positive carry above the buffer's target to the income ledger, and the reserve's face is unchanged by carry", () => {
    const front = seedReserve(1_000n, 1);
    c.mintTestUsdc("agent-1", 100_000_000n);
    now = w(1).from + 60;
    // a rate far above the front lots' sale value would make no carry; sell everything at a high print and rebuy at the same print: proceeds 90% of cost, a shortfall.
    // carry needs proceeds above cost, so rebuy fewer... the rule forbids it. Carry arises only from stray USDC: an unsolicited transfer.
    c.mintTestUsdc(RESERVE, 3_000_000n);
    const res = c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [{ buyer: "agent-1", tokenId: front, milli: 1_000n }],
      buys: [{ classId: "CR-PL", milli: 1_000n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    expect(res.carryToBuffer).toBe(1_000_000n); // up to the target
    expect(res.carryToIncome).toBeGreaterThan(0n);
    expect(c.balance(INCOME, "USDC")).toBe(res.carryToIncome);
    expect(c.liveFace()).toBe(1_000n);
    expect(c.balance(RESERVE, "USDC")).toBe(0n);
  });

  it("only the issuer role rolls, and only front lots are sold", () => {
    const front = seedReserve(1_000n, 1);
    const later = seedReserve(1_000n, 2);
    now = w(1).from + 60;
    expect(() =>
      c.roll("agent-1", {
        rate: RATE,
        frontLots: [front],
        sales: [],
        buys: [],
        buyFrom: w(3).from,
        buyTo: w(3).to,
      }),
    ).toThrow(/only the AGU-lab issuer role/);
    c.mintTestUsdc("agent-1", 10_000_000n);
    expect(() =>
      c.roll("agu-issuer", {
        rate: RATE,
        frontLots: [front],
        sales: [{ buyer: "agent-1", tokenId: later, milli: 1n }],
        buys: [{ classId: "CR-PL", milli: 1_000n }],
        buyFrom: w(3).from,
        buyTo: w(3).to,
      }),
    ).toThrow(/front lots only/);
  });
});

describe("window close, routing and escrow", () => {
  it("a never-presented claim expires with no bond draw; a presented, unserved one defaults and the bond pays the holder", () => {
    const id = c.mint("agent-1", "CR-PL", "commodity", 100n, w(1).from, w(1).to, RATE);
    const id2 = c.mint("agent-1", "CR-PL", "commodity", 100n, w(1).from, w(1).to + 1, RATE);
    now = w(1).from + 1;
    c.present("agent-1", id2);
    now = w(1).to + 10;
    expect(c.settleWindowClose(id, "agent-1", RATE)).toMatchObject({ kind: "expired", usdc: 0n });
    expect(c.settleWindowClose(id2, "agent-1", RATE)).toMatchObject({
      kind: "defaulted",
      usdc: usdcFor(100n, RATE),
    });
    expect(() => c.settleWindowClose(id2, "agent-1", RATE)).toThrow(/AlreadySettled/);
  });

  it("routes first-fit in registration order, skipping a skipped issuer unless its probe is open", () => {
    expect(c.route("CR-PL", 1n)).toBe("C1");
    c.skipped.add("C1");
    expect(c.route("CR-PL", 1n)).toBe("C2");
    c.probeOpen.add("C1");
    expect(c.route("CR-PL", 1n)).toBe("C1");
  });

  it("settles an escrow in full, refunds on 0, refuses below the minimum and anyone but the settler, and expires", () => {
    c.transfer("USDC", "agent-1", "agent-2", 0n);
    seedReserve(1_000n);
    c.transfer("AGU", PARTICIPANT, "agent-1", 500_000n);
    c.escrowOpen("q1", "AGU", "agent-1", "agent-2", "gate", 200_000n, T0 + DAY);
    expect(() => c.escrowSettle("q1", "agent-2", 200_000n)).toThrow(/NotSettler/);
    expect(() => c.escrowSettle("q1", "gate", 99n)).toThrow(/BelowMinSettlement/);
    c.escrowSettle("q1", "gate", 200_000n);
    expect(c.balance("agent-2", "AGU")).toBe(200_000n);
    c.escrowOpen("q2", "AGU", "agent-1", "agent-2", "gate", 100_000n, T0 + DAY);
    c.escrowSettle("q2", "gate", 0n);
    expect(c.balance("agent-1", "AGU")).toBe(300_000n);
    c.escrowOpen("q3", "AGU", "agent-1", "agent-2", "gate", 100_000n, T0 + 5);
    now = T0 + 6;
    c.escrowExpire("q3");
    expect(c.balance("agent-1", "AGU")).toBe(300_000n);
  });
});

describe("every call is atomic, as a contract call is, and journalled", () => {
  it("a mint the buyer cannot pay for leaves headroom, claims and balances exactly as they were", () => {
    const head = c.headroom("C1", "CR-PL");
    const before = JSON.stringify([...c.claims], (_k, v) =>
      typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v,
    );
    const types = c.claimTypes.size;
    expect(() => c.mint("pauper", "CR-PL", "commodity", 1_000n, w(1).from, w(1).to, RATE)).toThrow(
      /needs/,
    );
    expect(c.headroom("C1", "CR-PL")).toBe(head);
    expect(
      JSON.stringify([...c.claims], (_k, v) =>
        typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v,
      ),
    ).toBe(before);
    expect(c.claimTypes.size).toBe(types);
  });

  it("a refused roll leaves the front lots unretired and every balance unchanged", () => {
    const front = seedReserve(2_000n, 1);
    now = w(1).from + 60;
    const face = c.liveFace();
    const usdc = c.balance("agent-1", "USDC");
    expect(() =>
      c.roll("agu-issuer", {
        rate: RATE,
        frontLots: [front],
        sales: [{ buyer: "agent-1", tokenId: front, milli: 1_000n }],
        buys: [{ classId: "CR-PL", milli: 2_000n }], // no buffer: unaffordable, refused after the sale moved money
        buyFrom: w(2).from,
        buyTo: w(2).to,
      }),
    ).toThrow(/R6/);
    expect(c.retired.has(front)).toBe(false);
    expect(c.liveFace()).toBe(face);
    expect(c.balance("agent-1", "USDC")).toBe(usdc);
    expect(c.claimBalance("agent-1", front)).toBe(0n);
  });

  it("journals only successful top-level calls, with the time they happened", () => {
    const n = c.journal.length;
    expect(() => c.mint("pauper", "CR-PL", "commodity", 1n, w(1).from, w(1).to, RATE)).toThrow();
    expect(c.journal.length).toBe(n);
    seedReserve(1_000n); // a mint and a create
    const tail = c.journal.slice(n).map((j) => j.op);
    expect(tail).toEqual(["mint", "create"]);
    now = w(1).from + 60;
    c.seedBuffer("C2", 1_000_000n);
    const before = c.journal.length;
    c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [c.reserveLots[0] as string],
      sales: [],
      buys: [{ classId: "CR-PL", milli: 1_000n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    // the roll's own mint and transfers are part of it: one entry
    expect(c.journal.slice(before).map((j) => j.op)).toEqual(["roll"]);
    expect(c.journal.at(-1)?.now).toBe(now);
  });
});

describe("the roll's rules match AguLab's (found by the DW1 replay on anvil, 2026-11-05)", () => {
  it("refuses an ineligible sale buyer, a sale that rounds to zero, and creation into a retired lot", () => {
    const front = seedReserve(1_000n, 1);
    c.seedBuffer("C2", 1_000_000n);
    now = w(1).from + 60;
    expect(() =>
      c.roll("agu-issuer", {
        rate: RATE,
        frontLots: [front],
        sales: [{ buyer: PARTICIPANT, tokenId: front, milli: 250n }],
        buys: [{ classId: "CR-PL", milli: 1_000n }],
        buyFrom: w(2).from,
        buyTo: w(2).to,
      }),
    ).toThrow(/IneligibleBuyer/);
    expect(() =>
      c.roll("agu-issuer", {
        rate: 1_000_000n, // at a print below $0.001 per SIU, 1 mSIU at the discount rounds to zero USDC

        frontLots: [front],
        sales: [{ buyer: "agent-1", tokenId: front, milli: 1n }],
        buys: [{ classId: "CR-PL", milli: 1_000n }],
        buyFrom: w(2).from,
        buyTo: w(2).to,
      }),
    ).toThrow(/SaleRoundsToZero/);
    c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [],
      buys: [{ classId: "CR-PL", milli: 1_000n }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    const more = c.mint(PARTICIPANT, "CR-PL", "commodity", 10n, w(1).from, w(1).to, RATE); // the same lot id as the retired front lot
    expect(more).toBe(front);
    expect(() => c.create(PARTICIPANT, more, 10n)).toThrow(/LotRetired/);
  });

  it("accepts the most face affordable under WorkClaim's rounding and refuses one mSIU less (the replay's case: buffer 40, one 250 mSIU sale)", () => {
    const front = seedReserve(1_000n, 1);
    c.seedBuffer("C2", 40n);
    now = w(1).from + 60;
    const sale = [{ buyer: "agent-1", tokenId: front, milli: 250n }];
    const proceeds = usdcFor(250n, (RATE * 9_000n) / 10_000n);
    const money = proceeds + 40n;
    const most = ((money + 1n) * 1_000_000n - 1n) / RATE; // the engine's formula
    expect(usdcFor(most, RATE)).toBeLessThanOrEqual(money);
    expect(usdcFor(most + 1n, RATE)).toBeGreaterThan(money);
    expect(() =>
      c.roll("agu-issuer", {
        rate: RATE,
        frontLots: [front],
        sales: sale,
        buys: [{ classId: "CR-PL", milli: most - 1n }],
        buyFrom: w(2).from,
        buyTo: w(2).to,
      }),
    ).toThrow(/RollUnderbuys/);
    const r = c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: sale,
      buys: [{ classId: "CR-PL", milli: most }],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    expect(r.faceBought).toBe(most);
    expect(c.balance("reserve", "USDC")).toBe(0n);
  });

  it("accepts a roll with no money at all (no sales, empty buffer): nothing is bought and NAV falls by the front face", () => {
    const front = seedReserve(1_000n, 1);
    seedReserve(1_000n, 2);
    now = w(1).from + 60;
    const before = c.liveFace();
    const r = c.roll("agu-issuer", {
      rate: RATE,
      frontLots: [front],
      sales: [],
      buys: [],
      buyFrom: w(2).from,
      buyTo: w(2).to,
    });
    expect(r.faceBought).toBe(0n);
    expect(c.liveFace()).toBe(before - 1_000n);
  });

  it("closes an open probe whenever the skip flag changes, and opens one only for a skipped issuer", () => {
    expect(() => c.setProbe("C1", true)).toThrow(/NotSkipped/);
    c.setSkipped("C1", true);
    c.setProbe("C1", true);
    c.setSkipped("C1", false);
    expect(c.probeOpen.has("C1")).toBe(false);
  });
});

describe("v3a: pooled direct mint (D145, v6) -- the roll places a lot across issuers with headroom when none can take it whole", () => {
  /** a chain whose C1 and C2 CR-PL lots have the given limits (limit = hours × rate × 0.5), with or without pooled direct mint */
  function chainWith(c1Limit: bigint, c2Limit: bigint, pooledMint: boolean): MemoryChain {
    const p = new MemoryChain({ ...PARAMS, ...(pooledMint ? { pooledMint } : {}) }, "agu-issuer", () => now);
    p.mintTestUsdc("C1", 50_000_000n);
    p.mintTestUsdc("C2", 50_000_000n);
    p.mintTestUsdc(PARTICIPANT, 20_000_000n);
    p.createLot("C1", "CR-PL", 1n, c1Limit * 2n, 10_000_000n);
    p.createLot("C2", "CR-PL", 1n, c2Limit * 2n, 10_000_000n);
    p.seedBuffer("C2", 1_000_000n);
    return p;
  }
  /** the participant creates a window-1 front lot of `milli` (routed first-fit: C1) */
  function front(p: MemoryChain, milli: bigint): string {
    const id = p.mint(PARTICIPANT, "CR-PL", "commodity", milli, w(1).from, w(1).to, RATE);
    p.create(PARTICIPANT, id, milli);
    return id;
  }
  const rollOn = (p: MemoryChain, lot: string, milli: bigint) => {
    now = w(1).from + 60;
    return p.roll("agu-issuer", { rate: RATE, frontLots: [lot], sales: [], buys: [{ classId: "CR-PL", milli }], buyFrom: w(2).from, buyTo: w(2).to });
  };

  it("splits the lot across the issuers in router order when no single issuer has room for it whole", () => {
    const p = chainWith(2_000n, 1_000n, true);
    const lot = front(p, 1_500n); // C1 has 500 left, C2 1,000: neither takes 1,500 whole, together they do
    const r = rollOn(p, lot, 1_500n);
    expect(r.minted.map((m) => [m.issuer, m.milli])).toEqual([
      ["C1", 500n],
      ["C2", 1_000n],
    ]);
    expect(r.faceBought).toBe(1_500n);
    expect(p.liveFace()).toBe(1_500n);
    expect([p.headroom("C1", "CR-PL"), p.headroom("C2", "CR-PL")]).toEqual([0n, 0n]);
    // the peak of live issuance in the class: the front lot stays live until its window closes, so 1,500 + 1,500
    expect(p.peakIssued.get("CR-PL")).toBe(3_000n);
  });

  it("places the lot whole with the router's issuer when one can take it, exactly as before", () => {
    const p = chainWith(2_000n, 2_000n, true);
    const lot = front(p, 1_500n);
    expect(rollOn(p, lot, 1_500n).minted.map((m) => [m.issuer, m.milli])).toEqual([["C2", 1_500n]]);
  });

  it("refuses with nothing moved when even the issuers' total headroom is short: v6's issuance limit binds", () => {
    const p = chainWith(2_000n, 900n, true);
    const lot = front(p, 1_500n);
    expect(() => rollOn(p, lot, 1_500n)).toThrow(/NoTotalHeadroom\(CR-PL, 1500, 1400\)/);
    expect(p.liveFace()).toBe(1_500n);
    expect(p.retired.has(lot)).toBe(false);
  });

  it("is off unless asked for: without it the roll still needs one issuer with room for the whole lot, as the deployed router does", () => {
    const p = chainWith(2_000n, 1_000n, false);
    const lot = front(p, 1_500n);
    expect(() => rollOn(p, lot, 1_500n)).toThrow(/NoIssuerWithHeadroom\(CR-PL, 1500\)/);
  });
});
