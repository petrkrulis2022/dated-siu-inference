import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { ScriptedAgent, StandInWorker, type Agent } from "./agents.js";
import { EconomyLog } from "./log.js";
import { loadParams, PARAMS_PATH, parseParams } from "./params.js";
import { judgeDevWindows, onwardSpends } from "./report.js";
import {
  buildWorld,
  loadCrPrint,
  needsSchedule,
  passRates,
  runWindows,
  standInSha,
} from "./runner.js";

const T0 = 1_800_000_000 - (1_800_000_000 % 86_400); // a UTC midnight

async function dw0(seed = "dw0-test") {
  const params = { ...loadParams(), seed };
  const wp0 = loadCrPrint();
  const sha = standInSha(seed);
  const log = new EconomyLog("stand-in");
  const world = buildWorld({
    params,
    wp0,
    log,
    worker: new StandInWorker(seed, passRates(wp0), sha),
    t0: T0,
    dataSha: sha,
  });
  world.genesis();
  world.checkInvariants();
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
    windows: [1, 2, 3],
    needsFor: needsSchedule(
      seed,
      TASKS.filter((t) => t !== "CR-VS"),
    ),
  });
  return { world, stats, log };
}

describe("development window DW0: scripted agents, memory ledger, stand-in data, no spend", () => {
  it("runs three windows with every invariant holding and meets the pass criteria", async () => {
    const { world, stats } = await dw0();
    const verdict = judgeDevWindows(world, stats);
    const failed = verdict.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(verdict.checks, null, 1)).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it("is deterministic: the same seed gives a byte-identical log", async () => {
    const a = await dw0("same-seed");
    const b = await dw0("same-seed");
    expect(a.log.text()).toBe(b.log.text());
    const c = await dw0("other-seed");
    expect(c.log.text()).not.toBe(a.log.text());
  });

  it("labels every log line with the stand-in backend, and every payment has a receipt with the snapshot hash and the verdict", async () => {
    const { log } = await dw0();
    expect(log.entries.every((e) => e.backend === "stand-in")).toBe(true);
    const receipts = log.of("receipt").filter((r) => r.escrow !== undefined);
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts) {
      expect(typeof r.snapshotSha).toBe("string");
      expect(["pass", "fail"]).toContain(r.verdict);
    }
  });

  it("keeps the log gapless, writes reasoning before the action it explains, and counts onward spends", async () => {
    const { log } = await dw0();
    log.entries.forEach((e, i) => expect(e.seq).toBe(i + 1));
    const turns = log.of("turn").filter((t) => t.parsed === true);
    for (const t of turns) {
      const before = log.entries.filter(
        (e) => e.seq < t.seq && e.actor === t.actor && e.kind === "reasoning",
      );
      expect(before.length).toBeGreaterThan(0);
    }
    expect(onwardSpends(log.entries)).toBeGreaterThanOrEqual(1);
  });

  it("ends every roll with zero reserve USDC and publishes NAV with and without the buffer", async () => {
    const { log, world } = await dw0();
    expect(world.chain.balance("reserve", "USDC")).toBe(0n);
    const navs = log.of("nav");
    expect(navs.length).toBeGreaterThan(0);
    for (const n of navs) {
      expect(n.reserveNav).not.toBeNull();
      expect(n.navWithBuffer).not.toBeNull();
    }
  });
});

describe("R12 in the engine: every claim received in kind gets its warning before the window ends", () => {
  it("warns a claim that arrives after the last round's warnings, at close, so none lapses unwarned", async () => {
    const seed = "r12-late";
    const params = { ...loadParams(), seed };
    const wp0 = loadCrPrint();
    const sha = standInSha(seed);
    const world = buildWorld({
      params,
      wp0,
      log: new EconomyLog("stand-in"),
      worker: new StandInWorker(seed, passRates(wp0), sha),
      t0: T0,
      dataSha: sha,
    });
    world.genesis();
    world.startWindow(1, needsSchedule(seed, TASKS));
    // redeemed in window 1, the claims fall due in later windows (this window's lots were retired at the roll)
    await world.act("DEMAND-1", { tool: "buy_agu", usdc: 100_000n }, "buying");
    const r = await world.act(
      "DEMAND-1",
      { tool: "redeem_agu", agu: world.chain.balance("DEMAND-1", "AGU") },
      "redeeming",
    );
    expect(r.ok).toBe(true);
    world.closeWindow(1);
    world.startWindow(2, needsSchedule(seed, TASKS));
    // the round-by-round warning never ran in window 2: the close must still warn before the claims lapse
    world.closeWindow(2);
    const closes = world.log.of("claim-close").filter((e) => e.holder === "DEMAND-1");
    expect(closes.length).toBeGreaterThan(0);
    for (const c of closes) expect(c.lapsedAfterWarning).toBe(true);
  });

  it("stops the window with an invariant failure if a claim would lapse without its warning", async () => {
    const seed = "r12-none";
    const params = { ...loadParams(), seed };
    const wp0 = loadCrPrint();
    const sha = standInSha(seed);
    const world = buildWorld({
      params,
      wp0,
      log: new EconomyLog("stand-in"),
      worker: new StandInWorker(seed, passRates(wp0), sha),
      t0: T0,
      dataSha: sha,
    });
    world.genesis();
    world.startWindow(1, needsSchedule(seed, TASKS));
    await world.act("DEMAND-1", { tool: "buy_agu", usdc: 100_000n }, "buying");
    await world.act(
      "DEMAND-1",
      { tool: "redeem_agu", agu: world.chain.balance("DEMAND-1", "AGU") },
      "redeeming",
    );
    world.closeWindow(1);
    world.startWindow(2, needsSchedule(seed, TASKS));
    world.lapseWarnings = () => undefined; // the warning removed from the path
    expect(() => world.closeWindow(2)).toThrow(/R12/);
  });
});

describe("single grade in practice (R3): routing picks issuers by task type, not by grade", () => {
  it("refuses parameters in which an issuer of another grade holds a lot of a class the reserve's grade serves", () => {
    const raw = JSON.parse(readFileSync(PARAMS_PATH, "utf-8")) as {
      issuers: { id: string; classes: string[] }[];
    };
    const f = raw.issuers.find((i) => i.id === "ISSUER-F");
    if (f === undefined) throw new Error("no ISSUER-F in the parameters");
    f.classes = ["CR-VS", "CR-PL"];
    expect(() => parseParams(raw as never)).toThrow(/ISSUER-F \(frontier\) has a CR-PL lot/);
  });

  it("stops the run if a reserve lot was issued by an issuer of another grade", async () => {
    const { world } = await dw0("r3-grade");
    const lot = world.chain.reserveLots[0] as string;
    const ct = world.chain.claimTypes.get(lot);
    if (ct === undefined) throw new Error("no lot");
    ct.issuer = "ISSUER-F";
    expect(() => world.checkInvariants()).toThrow(/R3: reserve lot/);
  });
});

describe("R11 in the engine: routing skips issuers below the delivery floor, with a way back", () => {
  async function failingFirst(seed: string) {
    const base = loadParams();
    // ISSUER-X registered FIRST among the Commodity issuers (first-fit would send it everything) and failing every presentation
    const x = base.issuers.find((i) => i.id === "ISSUER-X");
    if (x === undefined) throw new Error("no ISSUER-X");
    const others = base.issuers.filter((i) => i.id !== "ISSUER-X" && i.id !== "ISSUER-F");
    const f = base.issuers.find((i) => i.id === "ISSUER-F");
    const params = {
      ...base,
      seed,
      issuers: [{ ...x, failShareBps: 10_000n }, ...others, ...(f ? [f] : [])],
    };
    const wp0 = loadCrPrint();
    const sha = standInSha(seed);
    const world = buildWorld({
      params,
      wp0,
      log: new EconomyLog("stand-in"),
      worker: new StandInWorker(seed, passRates(wp0), sha),
      t0: T0,
      dataSha: sha,
    });
    world.genesis();
    const agents: Agent[] = [
      new ScriptedAgent("RESEARCH-1", "research", "ISSUER-X"),
      new ScriptedAgent("RESEARCH-2", "research", "ISSUER-X"),
      new ScriptedAgent("DEMAND-1", "demand"),
      new ScriptedAgent("DEMAND-2", "demand"),
      new ScriptedAgent("DEMAND-3", "demand"),
      new ScriptedAgent("HEDGER", "hedger", "ISSUER-C1"),
    ];
    await runWindows({
      world,
      agents,
      windows: [1, 2, 3],
      needsFor: needsSchedule(
        seed,
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    });
    return world;
  }

  it("skips a failing issuer from the window after it falls below 0.8, never rolls into it again, and offers it only probe lots", async () => {
    const world = await failingFirst("r11-skip");
    const skippedAt = world.log
      .of("routing")
      .find((e) => e.issuer === "ISSUER-X" && e.skipped === true);
    expect(skippedAt).toBeDefined();
    const after = world.log.entries.filter((e) => e.seq > (skippedAt?.seq ?? 0));
    const rollBuysFromX = after.filter((e) => e.kind === "roll-buy" && e.issuer === "ISSUER-X");
    expect(rollBuysFromX).toEqual([]);
    const creates = after.filter((e) => e.kind === "create");
    const nonProbeToX = creates.filter(
      (e) =>
        e.probeFor === undefined &&
        world.chain.claimTypes.get(e.tokenId as string)?.issuer === "ISSUER-X",
    );
    expect(nonProbeToX).toEqual([]);
    expect(creates.filter((e) => e.probeFor === "ISSUER-X").length).toBeGreaterThan(0);
    expect(world.chain.skipped.has("ISSUER-X")).toBe(true); // it never served a probe, so it never cleared
  });

  it("clears a skipped issuer only once its trailing ratio is back at the floor AND three probes were served", async () => {
    for (const [probes, cleared] of [
      [2, false],
      [3, true],
    ] as const) {
      const seed = `r11-clear-${probes}`;
      const params = { ...loadParams(), seed };
      const wp0 = loadCrPrint();
      const sha = standInSha(seed);
      const world = buildWorld({
        params,
        wp0,
        log: new EconomyLog("stand-in"),
        worker: new StandInWorker(seed, passRates(wp0), sha),
        t0: T0,
        dataSha: sha,
      });
      world.genesis();
      world.startWindow(1, needsSchedule(seed, TASKS));
      world.chain.skipped.add("ISSUER-X");
      world.delivery.set("ISSUER-X", [
        { presented: 0, served: 0 },
        { presented: 5, served: 4 }, // exactly 0.8 is at the floor, so not below it
      ]);
      world.probesServed.set("ISSUER-X", probes);
      world.closeWindow(1);
      expect(world.chain.skipped.has("ISSUER-X")).toBe(!cleared);
    }
  });

  it("must fail on first-fit: without the skip rule the same routing sends the work back to the failing issuer", async () => {
    const world = await failingFirst("r11-firstfit");
    expect(world.chain.route("CR-PL", 1n)).not.toBe("ISSUER-X");
    world.chain.skipped.clear(); // the unchanged first-fit router
    expect(world.chain.route("CR-PL", 1n)).toBe("ISSUER-X");
  });
});
