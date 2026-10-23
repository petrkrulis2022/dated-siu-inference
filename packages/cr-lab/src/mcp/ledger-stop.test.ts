import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapter } from "@touchstone/harness";
import { buildPrompt } from "../runner/prompts.js";
import { runAnswer } from "../runner/run-answer.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { LedgerUnreadable, type LedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { toMcpInstance } from "./variants.js";
import { FakeMcp, LIVE_LAG } from "./fake-mcp.js";
import { runMcpAnswer } from "./session.js";
import { standInMessagesApi } from "./stand-in-agent.js";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay(undefined, {}, LIVE_LAG);
});
afterAll(() => f.cleanup());

/** a ledger whose file cannot be read, as after a crash that left a bad line in the middle */
const unreadable = (): SpendLedger => {
  const store: LedgerStore = {
    load: () => {
      throw new LedgerUnreadable("ledger.jsonl", 790, new Error("NUL bytes"));
    },
    append: () => undefined,
  };
  return new SpendLedger({
    store,
    policy: {
      dailyCapUsd: "9",
      providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
    },
  });
};

describe("a ledger that cannot be read is a stop, never a result (2026-10-23: two sessions were recorded as the models' failures)", () => {
  it("an MCP-mode session throws and records nothing", async () => {
    const instance = drawInstances(f.day, "3".repeat(64), 1)
      .map((i) => toMcpInstance(i, f.day)?.instance)
      .find((i): i is Instance => i?.task === "CR-PL") as Instance;
    await expect(
      runMcpAnswer({
        api: standInMessagesApi("researcher", instance, f.day),
        mcp: new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG }),
        ledger: unreadable(),
        seat: standInSeat("solver", { id: "claude-haiku-4-5" }),
        instance,
        window: f.day.window,
        daySha256: "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(LedgerUnreadable);
  });

  it("a snapshot-mode answer throws too, instead of becoming a call-failed record", async () => {
    const instance = drawInstances(f.day, "3".repeat(64), 1).find(
      (i) => i.task === "CR-PL",
    ) as Instance;
    const bundle = buildPrompt(instance, f.day);
    if (bundle === undefined) throw new Error("no prompt");
    const adapter: Adapter = async () => {
      throw new Error("never reached: the guard stops first");
    };
    await expect(
      runAnswer({
        ledger: unreadable(),
        seat: { ...standInSeat("solver", { id: "claude-haiku-4-5" }), adapter },
        instance,
        bundle,
        window: f.day.window,
        daySha256: "d".repeat(64),
        part: "dry-run",
      }),
    ).rejects.toBeInstanceOf(LedgerUnreadable);
  });
});
