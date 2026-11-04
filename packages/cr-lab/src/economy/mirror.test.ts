import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { ScriptedAgent, StandInWorker, type Agent, type AgentReply } from "./agents.js";
import type { Board } from "./board.js";
import { EconomyLog } from "./log.js";
import { overview } from "./overview.js";
import { loadParams } from "./params.js";
import { judgeDevWindows } from "./report.js";
import {
  buildWorld,
  loadCrPrint,
  needsSchedule,
  passRates,
  runWindows,
  standInSha,
} from "./runner.js";

/** a "model" that answers like the scripted policy but is not scripted, so the runner mirrors it */
class Mirrorable implements Agent {
  readonly seat = "fake-model";
  readonly inner: ScriptedAgent;
  readonly seen: boolean[] = [];
  constructor(
    readonly id: string,
    readonly role: "research" | "demand" | "hedger",
    issuer = "ISSUER-C1",
  ) {
    this.inner = new ScriptedAgent(id, role, issuer);
  }
  async reply(b: Board): Promise<AgentReply> {
    this.seen.push(b.siuFirst);
    const r = await this.inner.reply(b);
    return { ...r, costUsd: new D("0.001") };
  }
}

describe("the mirrored sample (D82)", () => {
  it("asks a seeded share of model turns again with the other display, never executes the mirror, and reports both renderings", async () => {
    const seed = "mirror-1";
    const params = { ...loadParams(), seed, mirroredShareBps: 5_000n };
    const wp0 = loadCrPrint();
    const sha = standInSha(seed);
    const world = buildWorld({
      params,
      wp0,
      log: new EconomyLog("stand-in"),
      worker: new StandInWorker(seed, passRates(wp0), sha),
      t0: 1_799_971_200,
      dataSha: sha,
    });
    world.genesis();
    const agents = [
      new Mirrorable("RESEARCH-1", "research"),
      new Mirrorable("RESEARCH-2", "research", "ISSUER-X"),
      new Mirrorable("DEMAND-1", "demand"),
      new Mirrorable("DEMAND-2", "demand"),
      new Mirrorable("DEMAND-3", "demand"),
      new Mirrorable("HEDGER", "hedger"),
    ];
    const stats = await runWindows({
      world,
      agents,
      windows: [1],
      needsFor: needsSchedule(
        seed,
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    });
    const mirrors = stats[0]?.mirrors ?? [];
    expect(mirrors.length).toBeGreaterThan(0);
    for (const m of mirrors) expect(m.mirror.siuFirst).toBe(!m.original.siuFirst);
    const logged = world.log.of("turn").filter((t) => t.mirror === true);
    expect(logged.length).toBe(mirrors.length);
    expect(logged.every((t) => t.executed === false)).toBe(true);
    // the turns executed are exactly the non-mirror turns: one per agent per round
    expect(world.log.of("turn").filter((t) => t.mirror !== true).length).toBe(stats[0]?.turns);
    const report = overview(world, stats, judgeDevWindows(world, stats), "mirror test");
    expect(report).toMatch(/SIU first: \d+ answers/);
    expect(report).toMatch(/dollars first: \d+ answers/);
  });
});
