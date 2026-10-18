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

/** The print's measured 30 days of spend per provider (D72). */
const MEASURED_30_DAY = {
  anthropic: "15.09",
  openai: "7.02",
  google: "18.78",
  xai: "8.25",
  openrouter: "2.76",
};
/** Reserves the owner chose to hold below the measured need, each with its date: 2026-10-18, to test GPT on the OpenAI balance as it is (the print then has about 15 days there). */
const OWNER_LOWERED = { openai: "3.51" };

describe("the committed budgets file", () => {
  it("is valid, sets the $9 daily cap (D73) and the print's reserves, and gives the trial no budget where no balance is recorded", () => {
    const f = loadBudgets(BUDGETS_PATH);
    expect(f.dailyCapUsd).toBe("9");
    expect(f.printReserveUsd).toEqual({ ...MEASURED_30_DAY, ...OWNER_LOWERED });
    // Until a balance is recorded the trial may not spend anywhere: the guard fails closed. Record balances with the time they were read, after each top-up.
    expect(Object.keys(policyFromBudgets(f).providers)).toEqual(Object.keys(f.balances));
  });

  it("never holds a reserve above the measured need, and a lowered one is a recorded owner decision", () => {
    const f = loadBudgets(BUDGETS_PATH);
    for (const [p, usd] of Object.entries(f.printReserveUsd))
      expect(Number(usd), p).toBeLessThanOrEqual(
        Number(MEASURED_30_DAY[p as keyof typeof MEASURED_30_DAY]),
      );
    for (const p of Object.keys(OWNER_LOWERED))
      expect(
        f.balances[p as "openai"]?.source ?? "",
        `${p}'s balance record says why its reserve is lowered`,
      ).toMatch(/owner chose|lowered/);
  });
});
