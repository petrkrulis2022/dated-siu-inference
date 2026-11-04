import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daySha256 } from "../runner/run-day.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { TASKS } from "../tasks/instances.js";
import { ScriptedAgent, type Agent } from "./agents.js";
import { EconomyLog } from "./log.js";
import { loadParams, type IssuerParams } from "./params.js";
import { judgeDevWindows } from "./report.js";
import { buildWorld, loadCrPrint, needsSchedule, runWindows } from "./runner.js";
import { SnapshotModelWorker } from "./snapshot-worker.js";

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
      providers: { anthropic: { budgetUsd: "50", since: "2026-01-01T00:00:00Z" } },
    } as never,
  });
const issuer = (o: Partial<IssuerParams> = {}): IssuerParams => ({
  id: "ISSUER-C1",
  model: "claude-haiku-5-5",
  grade: "commodity",
  classes: ["CR-PL", "CR-UO", "CR-SM"],
  budgetUsdPerWindow: undefined as never,
  bondUsdc: 1n,
  failShareBps: 0n,
  ...o,
});

describe("issuer work on a stored day", () => {
  it("has the issuer's model answer a freshly drawn instance on that day, graded by the same gate, booked as part economy", async () => {
    const w = new SnapshotModelWorker(
      new Map([[1, { window: f.day.window, day: f.day, sha: daySha256(f.store, f.day.window) }]]),
      new Map([["claude-haiku-5-5", standInSeat("solver")]]),
      ledger(),
      "seed-a",
    );
    const out = await w.work(issuer(), "CR-PL", { window: 1, round: 0, key: "k1" });
    expect(out.passed).toBe(true);
    expect(out.dataSha).toBe(daySha256(f.store, f.day.window));
    expect(out.costUsd.gt(0)).toBe(true);
    expect(w.answers).toHaveLength(1);
    expect(w.answers[0]?.part).toBe("economy");
    expect(w.answers[0]?.task).toBe("CR-PL");
  });

  it("fails ISSUER-X's published share without calling a model or spending", async () => {
    const w = new SnapshotModelWorker(
      new Map([[1, { window: f.day.window, day: f.day, sha: "x" }]]),
      new Map([["claude-haiku-5-5", standInSeat("solver")]]),
      ledger(),
      "seed-b",
    );
    const out = await w.work(issuer({ id: "ISSUER-X", failShareBps: 10_000n }), "CR-PL", {
      window: 1,
      round: 0,
      key: "k1",
    });
    expect(out.passed).toBe(false);
    expect(out.costUsd.isZero()).toBe(true);
    expect(w.answers).toHaveLength(0);
    expect(w.skippedByShare).toHaveLength(1);
  });

  it("runs a scripted economy window on a stored (here: fixture) day with real grading and passes the development criteria", async () => {
    const base = loadParams();
    // ISSUER-X fails every presentation here, so this one window is sure to see a failed piece of work and its refund
    const params = {
      ...base,
      seed: "dw4-fixture",
      issuers: base.issuers.map((i) => (i.id === "ISSUER-X" ? { ...i, failShareBps: 10_000n } : i)),
    };
    const days = new Map([
      [1, { window: f.day.window, day: f.day, sha: daySha256(f.store, f.day.window) }],
    ]);
    const worker = new SnapshotModelWorker(
      days,
      new Map([
        ["claude-haiku-5-5", standInSeat("solver")],
        ["claude-sonnet-5", standInSeat("solver")],
      ]),
      ledger(),
      params.seed,
    );
    const world = buildWorld({
      params,
      wp0: loadCrPrint(),
      log: new EconomyLog("snapshot"),
      worker,
      t0: 1_799_971_200,
      dataSha: (k) => worker.dataSha(k),
    });
    world.genesis();
    const agents: Agent[] = [
      new ScriptedAgent("RESEARCH-1", "research", "ISSUER-C1"),
      new ScriptedAgent("RESEARCH-2", "research", "ISSUER-X"),
      new ScriptedAgent("DEMAND-1", "demand"),
      new ScriptedAgent("DEMAND-2", "demand"),
      new ScriptedAgent("DEMAND-3", "demand"),
      new ScriptedAgent("HEDGER", "hedger", "ISSUER-C1"),
    ];
    const stats = await runWindows({
      world,
      agents,
      windows: [1],
      needsFor: needsSchedule(
        params.seed,
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    });
    const v = judgeDevWindows(world, stats);
    // one window cannot show an onward spend after a brief is paid (the research agent pays issuers before it is paid); everything else must hold
    expect(
      v.checks.filter((c) => !c.ok && c.name !== "AGU-lab circulated at least two hops"),
    ).toEqual([]);
    expect(worker.answers.length).toBeGreaterThan(0);
    expect(world.log.entries.every((e) => e.backend === "snapshot")).toBe(true);
  });
});
