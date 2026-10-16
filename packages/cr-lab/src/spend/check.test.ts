import { describe, expect, it } from "vitest";
import { checkSpend } from "./check.js";
import { parseUsd } from "./money.js";
import type { SpendEntry, SpendPolicy } from "./types.js";

const KEY = { anthropic: "CR_ANTHROPIC_API_KEY", openai: "CR_OPENAI_API_KEY" } as const;
const entry = (provider: "anthropic" | "openai", usd: string, at: string): SpendEntry => ({
  at,
  provider,
  usd,
  part: "snapshot",
  model: "m",
  key: KEY[provider],
  what: "t",
});
const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: {
    anthropic: { budgetUsd: "20", since: "2026-10-01T00:00:00Z" },
    openai: { budgetUsd: "5", since: "2026-10-01T00:00:00Z" },
  },
};
const NOW = new Date("2026-10-20T12:00:00Z");
const check = (over: Partial<Parameters<typeof checkSpend>[0]>) =>
  checkSpend({
    entries: [],
    pending: [],
    now: NOW,
    provider: "anthropic",
    projectedUsd: "1",
    policy: POLICY,
    ...over,
  });

describe("parseUsd: money is a plain decimal string", () => {
  it("accepts digits with an optional fraction", () => {
    expect(parseUsd("0.0125", "x").toFixed(4)).toBe("0.0125");
    expect(parseUsd("9", "x").toFixed(0)).toBe("9");
  });
  it("rejects a number, a negative, an exponent, a blank and a stray character", () => {
    for (const bad of [
      0.1,
      -1,
      "-1",
      "1e-3",
      "",
      " 1",
      "1 ",
      "1,5",
      "$1",
      "NaN",
      "Infinity",
      ".5",
      "5.",
      null,
      undefined,
    ]) {
      expect(() => parseUsd(bad, "x"), String(bad)).toThrow(TypeError);
    }
  });
});

describe("checkSpend", () => {
  it("allows a call inside both limits and says what is left", () => {
    const r = check({
      entries: [entry("anthropic", "2", "2026-10-20T01:00:00Z")],
      projectedUsd: "1",
    });
    expect(r).toMatchObject({
      ok: true,
      spentToday: "2.000000",
      remainingToday: "7.000000",
      providerSpent: "2.000000",
      providerRemaining: "18.000000",
    });
  });

  it("refuses a call that would take the day past $9, counting every provider", () => {
    const entries = [
      entry("anthropic", "5", "2026-10-20T01:00:00Z"),
      entry("openai", "3.5", "2026-10-20T02:00:00Z"),
    ];
    expect(check({ entries, projectedUsd: "0.5" }).ok).toBe(true); // lands exactly on the cap
    const r = check({ entries, projectedUsd: "0.500001" });
    expect(r).toMatchObject({ ok: false, code: "daily-cap" });
    if (!r.ok) expect(r.reason).toMatch(/\$8\.500000 today.*\$9\.00 daily cap/);
  });

  it("does not count yesterday against today's cap, but does count it against the provider's budget", () => {
    const entries = [entry("anthropic", "8.9", "2026-10-19T23:59:59Z")];
    expect(check({ entries, projectedUsd: "9" }).ok).toBe(true);
    const r = check({
      entries: [entry("anthropic", "19.5", "2026-10-19T10:00:00Z")],
      projectedUsd: "1",
    });
    expect(r).toMatchObject({ ok: false, code: "provider-budget" });
  });

  it("refuses at a provider's budget even when the day has room", () => {
    const r = check({
      provider: "openai",
      entries: [entry("openai", "4.5", "2026-10-18T10:00:00Z")],
      projectedUsd: "0.6",
    });
    expect(r).toMatchObject({ ok: false, code: "provider-budget", providerSpent: "4.500000" });
    if (!r.ok) expect(r.reason).toMatch(/openai.*\$5\.00 budget/);
  });

  it("counts calls in flight against both limits", () => {
    const pending = [{ provider: "anthropic" as const, usd: "8.5" }];
    expect(check({ pending, projectedUsd: "0.6" })).toMatchObject({ ok: false, code: "daily-cap" });
    expect(
      check({
        pending: [{ provider: "openai", usd: "4.9" }],
        provider: "openai",
        projectedUsd: "0.2",
      }),
    ).toMatchObject({ ok: false, code: "provider-budget" });
  });

  it("fails closed: a provider with no budget may not spend at all, however little", () => {
    const r = check({ provider: "xai", projectedUsd: "0.000001" });
    expect(r).toMatchObject({ ok: false, code: "no-budget" });
  });

  it("ignores spend before the budget's `since`, which the balance already reflects", () => {
    const policy: SpendPolicy = {
      dailyCapUsd: "20",
      providers: { anthropic: { budgetUsd: "10", since: "2026-10-18T00:00:00Z" } },
    };
    const entries = [entry("anthropic", "9", "2026-10-17T10:00:00Z")];
    expect(check({ entries, policy, projectedUsd: "10" }).ok).toBe(true); // the 9 before `since` is not counted
    const after = [...entries, entry("anthropic", "1", "2026-10-18T00:00:00Z")];
    expect(check({ entries: after, policy, projectedUsd: "9" }).ok).toBe(true); // 1 + 9 lands exactly on the budget
    expect(check({ entries: after, policy, projectedUsd: "9.000001" })).toMatchObject({
      ok: false,
      code: "provider-budget",
    });
  });

  it("rejects a projected cost that is not a plain decimal string", () => {
    expect(() => check({ projectedUsd: 0.5 as unknown as string })).toThrow(TypeError);
    expect(() => check({ projectedUsd: "1e-1" })).toThrow(TypeError);
  });

  it("sums without floating-point drift", () => {
    const entries = Array.from({ length: 3000 }, () =>
      entry("anthropic", "0.000001", "2026-10-20T01:00:00Z"),
    );
    expect(check({ entries, projectedUsd: "0" })).toMatchObject({
      ok: true,
      spentToday: "0.003000",
    });
    const tenths = Array.from({ length: 3 }, () =>
      entry("anthropic", "0.1", "2026-10-20T01:00:00Z"),
    );
    expect(check({ entries: tenths, projectedUsd: "0" })).toMatchObject({ spentToday: "0.300000" });
  });
});
