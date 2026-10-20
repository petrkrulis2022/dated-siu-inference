/** The runner holds every model to the frozen allowance of its task and records it (D113). Stand-in adapters only; nothing calls a provider. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { SpendPolicy } from "../spend/types.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, TASKS, type Instance } from "../tasks/instances.js";
import { loadAllowances } from "./allowance.js";
import { buildPrompt } from "./prompts.js";
import { runAnswer } from "./run-answer.js";
import { standInAdapter, standInSeat } from "./stand-in-models.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
};

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());

describe("the frozen allowance in the runner", () => {
  it("sends each task's allowance as max_tokens to every model, and records it", async () => {
    const frozen = loadAllowances();
    const all = drawInstances(f.day, "7".repeat(64));
    for (const task of TASKS) {
      const instance = all.find((i) => i.task === task) as Instance;
      const sent: number[] = [];
      const inner = standInAdapter("solver");
      const seat = {
        ...standInSeat("solver", { price: { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" } }),
        adapter: async (...args: Parameters<typeof inner>) => {
          sent.push(args[2].max_tokens);
          return inner(...args);
        },
      };
      const rec = await runAnswer({
        ledger: new SpendLedger({ store: new MemoryLedgerStore(), policy: POLICY, now: () => NOW }),
        seat,
        instance,
        bundle: buildPrompt(instance, f.day) as NonNullable<ReturnType<typeof buildPrompt>>,
        window: f.day.window,
        daySha256: "d".repeat(64),
        now: () => NOW,
      });
      expect(sent, task).toEqual([frozen[task]]);
      expect(rec.allowance_tokens, task).toBe(frozen[task]);
    }
  });

  it("takes an allowance table given to it, for a test or a later dated revision", async () => {
    const instance = drawInstances(f.day, "7".repeat(64)).find(
      (i) => i.task === "CR-UO",
    ) as Instance;
    const rec = await runAnswer({
      ledger: new SpendLedger({ store: new MemoryLedgerStore(), policy: POLICY, now: () => NOW }),
      seat: standInSeat("solver", { price: { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" } }),
      instance,
      bundle: buildPrompt(instance, f.day) as NonNullable<ReturnType<typeof buildPrompt>>,
      window: f.day.window,
      daySha256: "d".repeat(64),
      allowances: { "CR-VS": 8000, "CR-PL": 4000, "CR-UO": 6000, "CR-SM": 4000 },
      now: () => NOW,
    });
    expect(rec.allowance_tokens).toBe(6000);
  });
});
