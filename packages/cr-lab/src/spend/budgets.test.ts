import { describe, expect, it } from "vitest";
import { BUDGETS_PATH, loadBudgets, parseBudgets, policyFromBudgets } from "./budgets.js";

const FILE = {
  dailyCapUsd: "9",
  printReserveUsd: {
    anthropic: "15.09",
    openai: "7.02",
    google: "18.78",
    xai: "8.25",
    openrouter: "2.76",
  },
  balances: {
    anthropic: { usd: "40", asOf: "2026-10-18T00:00:00Z" },
    openai: { usd: "30.5", asOf: "2026-10-16T14:00:00Z" },
    xai: { usd: "5", asOf: "2026-10-16T14:00:00Z" },
  },
};

describe("policyFromBudgets", () => {
  it("sets each provider's budget to its balance minus the print's reserve there, from the time the balance was read", () => {
    const p = policyFromBudgets(parseBudgets(FILE));
    expect(p.dailyCapUsd).toBe("9");
    expect(p.providers.anthropic).toEqual({
      budgetUsd: "24.910000",
      since: "2026-10-18T00:00:00Z",
    });
    expect(p.providers.openai).toEqual({ budgetUsd: "23.480000", since: "2026-10-16T14:00:00Z" });
  });

  it("gives a provider below its reserve a budget of zero, not a negative one, so the trial cannot dip into the print's money", () => {
    expect(policyFromBudgets(parseBudgets(FILE)).providers.xai).toEqual({
      budgetUsd: "0.000000",
      since: "2026-10-16T14:00:00Z",
    });
  });

  it("gives no budget at all to a provider with no recorded balance, so the guard fails closed", () => {
    const p = policyFromBudgets(parseBudgets(FILE));
    expect(p.providers.google).toBeUndefined();
    expect(p.providers.openrouter).toBeUndefined();
  });

  it("rejects a malformed file: a number for money, an unknown provider, a bad date", () => {
    expect(() => parseBudgets({ ...FILE, dailyCapUsd: 9 })).toThrow(TypeError);
    expect(() => parseBudgets({ ...FILE, printReserveUsd: { nobody: "1" } })).toThrow(
      /unknown provider/,
    );
    expect(() => parseBudgets({ ...FILE, balances: { xai: { usd: "5", asOf: "soon" } } })).toThrow(
      /asOf/,
    );
    expect(() =>
      parseBudgets({ ...FILE, balances: { xai: { usd: 5, asOf: "2026-10-16" } } }),
    ).toThrow(TypeError);
  });
});

describe("the committed budgets file", () => {
  it("is valid, sets the $9 daily cap (D73) and the print's reserves, and records no balance until one is read", () => {
    const f = loadBudgets(BUDGETS_PATH);
    expect(f.dailyCapUsd).toBe("9");
    expect(f.printReserveUsd).toEqual({
      anthropic: "15.09",
      openai: "7.02",
      google: "18.78",
      xai: "8.25",
      openrouter: "2.76",
    });
    // Until a balance is recorded the trial may not spend anywhere: the guard fails closed. Record balances with the time they were read, after each top-up.
    expect(Object.keys(policyFromBudgets(f).providers)).toEqual(Object.keys(f.balances));
  });
});
