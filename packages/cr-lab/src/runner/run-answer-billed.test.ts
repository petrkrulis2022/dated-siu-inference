import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterHttpError, withBilledUsage, type Adapter } from "@touchstone/harness";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances } from "../tasks/instances.js";
import { buildPrompt } from "./prompts.js";
import { runAnswer } from "./run-answer.js";
import { standInSeat } from "./stand-in-models.js";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());

const ledger = () =>
  new SpendLedger({
    store: new MemoryLedgerStore(),
    policy: {
      dailyCapUsd: "9",
      providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
    },
  });
const input = () => {
  const instance = drawInstances(f.day, "6".repeat(64), 1).find((i) => i.task === "CR-PL");
  if (instance === undefined) throw new Error("no CR-PL instance");
  const bundle = buildPrompt(instance, f.day);
  if (bundle === undefined) throw new Error("no prompt");
  return { instance, bundle };
};
const run = (adapter: Adapter, l = ledger()) => {
  const { instance, bundle } = input();
  return {
    l,
    done: runAnswer({
      ledger: l,
      seat: { ...standInSeat("solver", { id: "claude-haiku-4-5" }), adapter },
      instance,
      bundle,
      window: f.day.window,
      daySha256: "d".repeat(64),
      part: "dry-run",
    }),
  };
};

describe("a retry that fails after a billed first call (found 2026-10-20, D118; fixed D120)", () => {
  // the stand-in seat is priced at one dollar in and five out per million tokens
  const billedUsage = { input: 1_000_000, output: 200_000, cached_input: 0, reasoning: 0 };
  const failing: Adapter = async () => {
    throw withBilledUsage(
      new AdapterHttpError("Anthropic request failed: 400", 400, {}),
      billedUsage,
    );
  };

  it("books the first call's cost in the ledger, records it, and still classes the attempt as a failed call", async () => {
    const { l, done } = run(failing);
    const rec = await done;
    expect(rec.usd).toBe("2"); // $1 for a million tokens in, $1 for 200,000 out at $5 per million
    expect(rec.passed).toBe(false);
    expect(rec.failure_classes).toContain("call-failed");
    expect(rec.error).toBe("AdapterHttpError HTTP 400"); // classified from the original error, not the wrapper
    expect(rec.tokens).toEqual({
      input: 1_000_000,
      output: 200_000,
      reasoning: 0,
      cached_input: 0,
    });
    expect(rec.deviations.at(-1)).toMatch(/first call was billed/);
    expect(l.report().spentToday).toBe("2.000000");
    expect(l.report().todayByPart["dry-run"]).toBe("2.000000");
  });

  it("books nothing for a failure with no billed call before it, as before", async () => {
    const { l, done } = run(async () => {
      throw new AdapterHttpError("Anthropic request failed: 500", 500, {});
    });
    const rec = await done;
    expect(rec.usd).toBe("0");
    expect(rec.error).toBe("AdapterHttpError HTTP 500");
    expect(rec.deviations).toEqual([]);
    expect(l.report().spentToday).toBe("0.000000");
  });
});
