import { describe, expect, it } from "vitest";
import { numericFlags, screenFigures, type CellFacts } from "./numeric-check.js";

/** P0 as the battery builds it: round 2, the print up 15%, 6,639 USDC minor units and 4,400 mSIU held. */
const P0: CellFacts = { printByRound: ["1437000", "1652550"], round: 2, heldUsdcMinor: "6639", heldFsiuMilliSiu: "4400" };
const figures = screenFigures(P0);

describe("screenFigures", () => {
  it("reads the quotes, the print and the wallet off a cell, as integers", () => {
    expect(figures.minor).toEqual([1984n, 1653n, 6639n, 7271n]);
    expect(figures.msiu.slice(0, 3)).toEqual([1200n, 1000n, 4400n]);
    expect(figures.usd[0]).toBe(1_984_000_000n); // 0.001984 USD at twelve decimals
    expect(figures.usd[1]).toBe(1_653_000_000n); // 0.001653 USD
  });
});

describe("numericFlags", () => {
  it("flags the practice round's reply: a $0.001653 cost written as ~1.653 USD", () => {
    const p3 = "I have sufficient USDC (6,639 minor units) to cover the ~1.653 USD cost.";
    const flags = numericFlags(p3, figures);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: "usd_scale", stated: "1.653", power: 3 });
  });

  it("leaves a reply with the right figures alone", () => {
    for (const text of [
      "I have sufficient USDC (6,639 minor units) to cover the 0.001653 USD cost.",
      "The quote is 1,200 mSIU or 0.001984 USD; I hold 4,400 mSIU.",
      "At 0.00165255 USD/SIU the unit costs 1,653 USDC minor units.",
      "Paying with $0.001984 leaves me with 4,655 minor units.",
    ]) {
      expect(numericFlags(text, figures)).toEqual([]);
    }
  });

  it("flags USDC minor units and mSIU that are a power of ten off a figure on the screen", () => {
    expect(numericFlags("I hold 663 USDC minor units.", figures)[0]).toMatchObject({ kind: "minor_scale", stated: "663", power: -1 });
    expect(numericFlags("The quote costs 12,000 mSIU.", figures)[0]).toMatchObject({ kind: "msiu_scale", stated: "12,000", power: 1 });
    expect(numericFlags("I hold 44 mSIU.", figures)[0]).toMatchObject({ kind: "msiu_scale", power: -2 });
  });

  it("flags a dollar figure far larger than the whole wallet, even where it is no power of ten off", () => {
    const flags = numericFlags("This would cost me about 5 USD.", figures);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("usd_implausible");
  });

  it("does not read USDC as USD, and ignores prose with no figure", () => {
    expect(numericFlags("I will pay in USDC and keep my fSIU.", figures)).toEqual([]);
    expect(numericFlags("6,639 USDC is plenty", figures)).toEqual([]);
    expect(numericFlags(undefined, figures)).toEqual([]);
    expect(numericFlags("", figures)).toEqual([]);
  });

  it("works on a six-round cell's figures", () => {
    const t1 = screenFigures({ printByRound: ["1437000", "1652550", "1900432", "2185496", "2513320"], round: 5, heldUsdcMinor: "10095", heldFsiuMilliSiu: "4400" });
    expect(numericFlags("The quote is 3,016 USDC minor units.", t1)).toEqual([]);
    expect(numericFlags("The quote is 30,160 USDC minor units.", t1)[0]).toMatchObject({ kind: "minor_scale", power: 1 });
  });

  it("reads \"1,653 USD minor units\" as a count of minor units, and \"1 minor unit\" as a definition", () => {
    expect(numericFlags("to cover the 1,653 USD minor units this will cost", figures)).toEqual([]);
    expect(numericFlags("so 1 minor unit = 1e-6 USD", figures)).toEqual([]);
    expect(numericFlags("a fee of 2.5e-3 USD", figures)).toEqual([]);
    // but a real slip written the same way is still a slip
    expect(numericFlags("to cover the 16,530 USD minor units this will cost", figures)[0]).toMatchObject({ kind: "minor_scale", power: 1 });
    expect(numericFlags("that is ~$6.64 of USDC", figures)[0]).toMatchObject({ kind: "usd_scale" });
  });

  it("states a limit it has: an arithmetic slip that lands off every power of ten is not caught", () => {
    expect(numericFlags("The quote is 1,456 mSIU.", figures)).toEqual([]);
  });
});
