import { describe, expect, it } from "vitest";
import type { Adapter } from "@touchstone/harness";
import { fixtureDay } from "../tasks/fixture-day.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { buildPrompt } from "./prompts.js";
import { CHAT_LOOP_USAGE, runRecordUsageConvention } from "@touchstone/sdk";
import { usageCostUsd } from "./prices.js";
import { runAnswer } from "./run-answer.js";
import { standInSeat } from "./stand-in-models.js";
import { drawInstances } from "../tasks/instances.js";

const price = { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" };
// the shape of the live Sonnet call that exposed the double count (2026-10-17): thinking tokens are part of the output tokens
const live = { input: 12_534, output: 29_067, reasoning: 28_323, cached_input: 0 };

describe("reasoning tokens are billed once", () => {
  it("for Anthropic, output already holds the thinking tokens, so reasoning is not added again", () => {
    // 12,534 x $2/M + 29,067 x $10/M
    expect(usageCostUsd(live, price, runRecordUsageConvention("anthropic")).toFixed()).toBe("0.315738");
  });

  it("for a provider that reports reasoning apart from the output (Google), it is added at the output rate", () => {
    // 12,534 x $2/M + (29,067 + 28,323) x $10/M
    expect(usageCostUsd(live, price, runRecordUsageConvention("google")).toFixed()).toBe("0.598968");
  });

  it("cr-lab's own chat loops leave reasoning inside the output for OpenAI as for Anthropic", () => {
    expect(usageCostUsd(live, price, CHAT_LOOP_USAGE).toFixed()).toBe("0.315738");
  });
});

// The one shared cost function (@touchstone/sdk's callCostUsd), 2026-11-21: the trial's dry run priced OpenRouter and OpenAI calls through the
// harness adapters, whose prompt count includes the cached tokens, and added the cached tokens again at the cached rate.
describe("cached tokens are billed once", () => {
  const deepseek = { priceInUsdPer1M: "0.26", priceOutUsdPer1M: "0.38", priceCachedInUsdPer1M: "0.13" };

  it("a harness-adapter call whose prompt includes its cached tokens prices them once, at the cached rate", () => {
    // (1,000 - 256) x $0.26 + 65 x $0.38 + 256 x $0.13, per 1M
    const usage = { input: 1_000, output: 65, cached_input: 256, reasoning: 0 };
    expect(usageCostUsd(usage, deepseek, runRecordUsageConvention("openrouter")).toFixed()).toBe("0.00025142");
  });

  it("cr-lab's own chat loops record the prompt without the cached tokens, so they are added", () => {
    const usage = { input: 744, output: 65, cached_input: 256, reasoning: 0 };
    expect(usageCostUsd(usage, deepseek, CHAT_LOOP_USAGE).toFixed()).toBe("0.00025142");
  });
});

describe("a recorded answer", () => {
  it("a recorded answer from an Anthropic seat is priced on output alone, and the ledger agrees", async () => {
    const f = await fixtureDay();
    try {
      const instance = drawInstances(f.day, "d".repeat(64)).find((i) => i.task === "CR-UO");
      const bundle = buildPrompt(instance!, f.day)!;
      const base = standInSeat("solver", { price, provider: "anthropic" });
      const adapter: Adapter = async (m, p, params) => {
        const r = await base.adapter(m, p, params);
        return { ...r, usage: { input: 1000, output: 3000, cached_input: 0, reasoning: 2500 } };
      };
      const NOW = new Date("2026-10-17T12:00:00Z");
      const ledger = new SpendLedger({
        store: new MemoryLedgerStore(),
        policy: {
          dailyCapUsd: "9",
          providers: { anthropic: { budgetUsd: "50", since: "2026-10-01T00:00:00Z" } },
        },
        now: () => NOW,
      });
      const rec = await runAnswer({
        ledger,
        seat: { ...base, adapter },
        instance: instance!,
        bundle,
        window: f.day.window,
        daySha256: "s".repeat(64),
        now: () => NOW,
      });
      // 1,000 x $2/M + 3,000 x $10/M = 0.032, not 0.057
      expect(rec.usd).toBe("0.032");
      expect(ledger.report().spentToday).toBe("0.032000");
    } finally {
      f.cleanup();
    }
  });
});
