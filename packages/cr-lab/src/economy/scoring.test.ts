/**
 * `scoring.ts` is committed and tested before the first counted window (D87; the owner, 2026-11-07). These are the permanent regression tests, built on small constructed
 * logs — never on stored Blockworks-derived data, which must be deleted by 16 November and so can never be something the committed test suite depends on. The scoring
 * module was ALSO smoke-tested by hand against the real rehearsal and DW4 logs before this commit, as the owner asked; that one-off check is reported in
 * `docs/marketplace_plan.md`'s dated entry, not committed as a test, for the same reason.
 */
import { describe, expect, it } from "vitest";
import { TASKS } from "../tasks/instances.js";
import { ScriptedAgent, StandInWorker, type Agent } from "./agents.js";
import { EconomyLog, type LogEntry } from "./log.js";
import { loadParams } from "./params.js";
import {
  buildWorld,
  loadCrPrint,
  needsSchedule,
  passRates,
  runWindows,
  standInSha,
} from "./runner.js";
import {
  exitsToTagBlind,
  renderScoringReport,
  scoreBuyingAhead,
  scoreCirculation,
  scoreComparability,
  scoreConversionToUsdc,
  scoreHops,
  scoreIssuerExits,
  scoreKillCriteria,
  scoreQuotingInDollars,
  scoreRun,
  scoreThesis,
  windowIndexOf,
  type ExitClass,
} from "./scoring.js";

const params = loadParams();

/** a minimal fabricated log entry, filled in with the fields a test needs and the reserved fields every real entry carries */
let seq = 0;
const entry = (window: string, round: number, actor: string, rest: Partial<LogEntry>): LogEntry => ({
  seq: ++seq,
  window,
  round,
  actor,
  backend: "stand-in",
  kind: "notice",
  ...rest,
}) as LogEntry;

/** every real run's log has been through exactly this serialisation (`log.ts`'s replacer turns a bigint into a decimal string) before anything reads it back */
const roundTrip = (log: readonly LogEntry[]): LogEntry[] =>
  log.map(
    (e) => JSON.parse(JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as LogEntry,
  );

describe("windowIndexOf", () => {
  it("maps each day label to its 1-based order of first appearance", () => {
    const log = [entry("2026-10-29", 0, "A", {}), entry("2026-10-29", 1, "B", {}), entry("2026-10-30", 0, "A", {})];
    const idx = windowIndexOf(log);
    expect(idx.get("2026-10-29")).toBe(1);
    expect(idx.get("2026-10-30")).toBe(2);
  });
});

describe("scoreThesis and exitsToTagBlind", () => {
  it("classifies an exit followed by a front-claim order in the same window as 'structural dollar route', neutral in the primary share, against in the secondary", () => {
    const log: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "reasoning", text: "funding tomorrow's claims" }),
      entry("2026-10-29", 0, "DEMAND-1", { kind: "exit", agu: 1_000_000n, usdc: 10_000n }),
      entry("2026-10-29", 1, "DEMAND-1", {
        kind: "message",
        to: "AGU-ISSUER",
        text: "front-claim order: 0.250 SIU of CR-PL for the next window",
      }),
    ];
    const tags = new Map<string, ExitClass>();
    const r = scoreThesis(log, tags);
    expect(r.total).toBe(1);
    expect(r.byClass["structural dollar route"]).toBe(1);
    expect(r.untagged).toEqual([]);
    expect(r.primaryAgainst).toBe(0);
    expect(r.secondaryAgainst).toBe(1);
    expect(r.primaryShare).toBe(0);
    expect(r.secondaryShare).toBe(1);
    expect(r.primaryFails).toBe(false);
    expect(r.secondaryFails).toBe(true);
    expect(exitsToTagBlind(log)).toEqual([]);
  });

  it("leaves every other exit for a blind tag, strips its key down to the reasoning alone, and scores the thesis only once every key is tagged", () => {
    const log: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "reasoning", text: "the price is about to fall, selling now" }),
      entry("2026-10-29", 0, "DEMAND-1", { kind: "exit", agu: 1_000_000n, usdc: 10_000n }),
      entry("2026-10-30", 0, "DEMAND-2", { kind: "reasoning", text: "paying my owner's sweep" }),
      entry("2026-10-30", 0, "DEMAND-2", { kind: "exit", agu: 500_000n, usdc: 5_000n }),
    ];
    const blind = exitsToTagBlind(log);
    expect(blind).toHaveLength(2);
    expect(blind[0]?.reasoning).toContain("fall");
    expect(blind.every((b) => !b.reasoning.includes("DEMAND"))).toBe(true); // no agent id leaks into the blind text
    // scoring before every key is tagged excludes the untagged ones rather than guessing
    const partial = scoreThesis(log, new Map([[blind[0]?.key as string, "fear"]]));
    expect(partial.untagged).toEqual([blind[1]?.key]);
    const full = scoreThesis(
      log,
      new Map<string, ExitClass>([
        [blind[0]?.key as string, "fear"],
        [blind[1]?.key as string, "dollar cost"],
      ]),
    );
    expect(full.untagged).toEqual([]);
    expect(full.byClass.fear).toBe(1);
    expect(full.byClass["dollar cost"]).toBe(1);
    expect(full.primaryShare).toBe(0.5); // 1 of 2 (fear) against the thesis
    expect(full.primaryFails).toBe(true);
  });
});

describe("scoreIssuerExits", () => {
  it("traces an issuer's income sale back to the agent(s) who paid it, and flags whether each payer had itself received AGU-lab first", () => {
    const log: LogEntry[] = [
      // DEMAND-1 buys AGU-lab fresh from the participant (no prior receipt), then pays ISSUER-C1 for a task
      entry("2026-10-29", 0, "DEMAND-1", { kind: "escrow-open", escrow: "e1", to: "ISSUER-C1", agu: 1_000n }),
      entry("2026-10-29", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e1", paid: 1_000n, refunded: 0n }),
      // the issuer sells its income for USDC at window close
      entry("2026-10-29", 9, "PARTICIPANT", {
        kind: "participant-buyback",
        from: "ISSUER-C1",
        agu: 1_000n,
        usdc: 13n,
        issuerCode: true,
      }),
    ];
    const r = scoreIssuerExits(log);
    expect(r).toHaveLength(1);
    expect(r[0]?.issuer).toBe("ISSUER-C1");
    expect(r[0]?.window).toBe(1);
    expect(r[0]?.payers).toEqual([{ agent: "DEMAND-1", agu: 1_000n, hops: 1 }]);
    expect(scoreIssuerExits(roundTrip(log))).toEqual(r); // identical once read back from a stored log file
  });

  it("reports hops 2 when the payer had itself received AGU-lab through an earlier escrow before paying the issuer", () => {
    const log: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "escrow-open", escrow: "e0", to: "RESEARCH-1", agu: 2_000n }),
      entry("2026-10-29", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e0", paid: 2_000n, refunded: 0n }),
      entry("2026-10-29", 2, "RESEARCH-1", { kind: "escrow-open", escrow: "e1", to: "ISSUER-C1", agu: 1_000n }),
      entry("2026-10-29", 3, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e1", paid: 1_000n, refunded: 0n }),
      entry("2026-10-29", 9, "PARTICIPANT", {
        kind: "participant-buyback",
        from: "ISSUER-C1",
        agu: 1_000n,
        usdc: 13n,
        issuerCode: true,
      }),
    ];
    const r = scoreIssuerExits(log);
    expect(r[0]?.payers).toEqual([{ agent: "RESEARCH-1", agu: 1_000n, hops: 2 }]);
  });
});

describe("circulation, conversion and hops (model agents only)", () => {
  const log: LogEntry[] = [
    // a receipt the holder spends onward (hop 2, circulated)
    entry("2026-10-29", 0, "DEMAND-1", { kind: "escrow-open", escrow: "e1", to: "RESEARCH-1", agu: 1_000n }),
    entry("2026-10-29", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e1", paid: 1_000n, refunded: 0n }),
    entry("2026-10-29", 2, "RESEARCH-1", { kind: "escrow-open", escrow: "e2", to: "ISSUER-C1", agu: 500n }),
    // a receipt the holder instead converts straight to USDC (hop 1, not circulated, converted)
    entry("2026-10-30", 0, "DEMAND-1", { kind: "escrow-open", escrow: "e3", to: "RESEARCH-2", agu: 2_000n }),
    entry("2026-10-30", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e3", paid: 2_000n, refunded: 0n }),
    entry("2026-10-30", 2, "RESEARCH-2", { kind: "exit", agu: 2_000n, usdc: 20n }),
    // a payment INTO an issuer is never counted as a model-agent receipt
    entry("2026-10-30", 3, "HEDGER", { kind: "escrow-open", escrow: "e4", to: "ISSUER-C1", agu: 300n }),
    entry("2026-10-30", 4, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e4", paid: 300n, refunded: 0n }),
  ];

  it("counts circulation only over receipts to a model agent (research/demand/hedger), not an issuer", () => {
    const c = scoreCirculation(log, params, "agu");
    expect(c.opportunities).toBe(2);
    expect(c.onwardSpends).toBe(1);
    expect(c.share).toBe(0.5);
    expect(c.holds).toBe(true);
  });

  it("scores the conversion-to-USDC kill criterion against the same receipt population", () => {
    const k = scoreConversionToUsdc(log, params, new Map(), "agu");
    expect(k.opportunities).toBe(2);
    expect(k.converted).toBe(1);
    expect(k.fails).toBe(false); // 50% < the 90% pre-registered threshold
  });

  it("D132: a receipt whose nearest exit is forced (structural or blind-tagged 'dollar cost') does not count as converted; an unclassified or voluntary one still does", () => {
    const forced: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "escrow-open", escrow: "f1", to: "RESEARCH-1", agu: 1_000n }),
      entry("2026-10-29", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "f1", paid: 1_000n, refunded: 0n }),
      entry("2026-10-29", 2, "RESEARCH-1", { kind: "reasoning", text: "need USDC for the dataset fee" }),
      entry("2026-10-29", 2, "RESEARCH-1", { kind: "exit", agu: 1_000n, usdc: 10n }),
    ];
    const blindForced = exitsToTagBlind(forced);
    const kForced = scoreConversionToUsdc(forced, params, new Map([[blindForced[0]?.key as string, "dollar cost"]]), "agu");
    expect(kForced.converted).toBe(0); // the forced exit does not count as revealed preference

    const voluntary: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "escrow-open", escrow: "f2", to: "RESEARCH-2", agu: 1_000n }),
      entry("2026-10-29", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "f2", paid: 1_000n, refunded: 0n }),
      entry("2026-10-29", 2, "RESEARCH-2", { kind: "reasoning", text: "the price is about to fall" }),
      entry("2026-10-29", 2, "RESEARCH-2", { kind: "exit", agu: 1_000n, usdc: 10n }),
    ];
    const blindVoluntary = exitsToTagBlind(voluntary);
    const kVoluntary = scoreConversionToUsdc(
      voluntary,
      params,
      new Map([[blindVoluntary[0]?.key as string, "fear"]]),
      "agu",
    );
    expect(kVoluntary.converted).toBe(1);

    // an exit with no tag at all yet still counts (unclassified, not proven forced) -- per the design note's own stated rule
    const kUntagged = scoreConversionToUsdc(voluntary, params, new Map(), "agu");
    expect(kUntagged.converted).toBe(1);
  });

  it("reports hops 2 for a circulated receipt and 1 for one converted straight to USDC, median over both", () => {
    const h = scoreHops(log, params, "agu");
    expect(h.values.sort()).toEqual([1, 2]);
    expect(h.median).toBe(1.5);
    expect(h.fails).toBe(false); // median > 1
  });

  /**
   * `economy-score.ts` (and every real run it is meant to score) reads a STORED log, never the in-memory one a run just produced: `log.ts`'s own replacer turns every
   * bigint field (agu, usdc, paid, priceMicroSiu, ...) into a plain decimal string, so `JSON.parse` on a real file hands these functions STRINGS, not bigints, for every
   * amount. This round-trips the same fixture through exactly that serialisation and checks every result is unchanged (found 2026-11-07, scoring the real rehearsal log
   * read "0 of 0 receipts" everywhere until `asBigInt` was added — a live, never-serialised fixture could not have caught it).
   */
  it("gives the identical result once the same log has been written to JSONL and read back, as every real run's log is", () => {
    const roundTripped = roundTrip(log);
    expect(scoreCirculation(roundTripped, params, "agu")).toEqual(scoreCirculation(log, params, "agu"));
    expect(scoreConversionToUsdc(roundTripped, params, new Map(), "agu")).toEqual(
      scoreConversionToUsdc(log, params, new Map(), "agu"),
    );
    expect(scoreHops(roundTripped, params, "agu")).toEqual(scoreHops(log, params, "agu"));
  });
});

describe("scoreQuotingInDollars", () => {
  it("counts a dollar amount in a model agent's own message, never the synthetic front-claim-order notice", () => {
    const log: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "message", to: "RESEARCH-1", text: "I'll pay $12 for that" }),
      entry("2026-10-29", 1, "DEMAND-1", { kind: "message", to: "RESEARCH-1", text: "quoting at 250 mSIU instead" }),
      entry("2026-10-29", 2, "DEMAND-1", {
        kind: "message",
        to: "AGU-ISSUER",
        text: "front-claim order: 0.250 SIU of CR-PL for the next window",
      }),
    ];
    const q = scoreQuotingInDollars(log, params);
    expect(q.messages).toBe(2); // the synthetic notice is excluded
    expect(q.count).toBe(1);
    expect(q.share).toBe(0.5);
    expect(q.fails).toBe(true); // any dollar-quoting message fires this kill criterion
  });
});

describe("scoreComparability", () => {
  it("counts a cheapest pick only where a real alternative existed and the brief went on to pass, split by the window's own display order", () => {
    const log: LogEntry[] = [
      // window 1 (SIU first, siuFirstForWindow(1) === true): two quotes for the same need, the cheaper one accepted and it passes
      entry("2026-10-29", 0, "RESEARCH-1", { kind: "quote", quote: "q1", need: "n1", priceMicroSiu: 100_000n }),
      entry("2026-10-29", 1, "RESEARCH-2", { kind: "quote", quote: "q2", need: "n1", priceMicroSiu: 200_000n }),
      entry("2026-10-29", 2, "DEMAND-1", { kind: "escrow-open", escrow: "e1", quote: "q1", to: "RESEARCH-1" }),
      entry("2026-10-29", 3, "GATE-RUNNER", { kind: "gate", brief: "q1", passed: true, components: [] }),
      // window 3 (dollars first, siuFirstForWindow(3) === false): only one quote ever posted — excluded, no real choice
      entry("2026-10-31", 0, "RESEARCH-1", { kind: "quote", quote: "q3", need: "n2", priceMicroSiu: 50_000n }),
      entry("2026-10-31", 1, "DEMAND-1", { kind: "escrow-open", escrow: "e2", quote: "q3", to: "RESEARCH-1" }),
      entry("2026-10-31", 2, "GATE-RUNNER", { kind: "gate", brief: "q3", passed: true, components: [] }),
    ];
    const c = scoreComparability(log);
    expect(c.siuFirstSample).toBe(1);
    expect(c.siuFirstCheapestShare).toBe(1);
    expect(c.dollarsFirstSample).toBe(0); // the single-quote window never entered the sample
    expect(c.holds).toBeNull(); // no dollars-first sample to compare against
    expect(scoreComparability(roundTrip(log))).toEqual(c); // identical once read back from a stored log file
  });
});

describe("scoreBuyingAhead", () => {
  it("counts each demand agent's next-window need covered by a front-claim order or a claim bought ahead, plus the hedger's own obligation slot", () => {
    const needsFor = needsSchedule(
      params.seed,
      TASKS.filter((t) => t !== "CR-VS"),
    );
    const a = params.agents.demand[0] as string;
    const nextTasks = [...new Set(needsFor(a, 2))];
    const log: LogEntry[] = [
      entry("2026-10-29", 0, a, {
        kind: "message",
        to: "AGU-ISSUER",
        text: `front-claim order: 0.250 SIU of ${nextTasks[0]} for the next window`,
      }),
      entry("2026-10-30", 0, "x", { kind: "notice" }),
    ];
    const r = scoreBuyingAhead(log, params);
    expect(r.windowsConsidered).toBe(1);
    expect(r.perWindow[0]?.covered).toBe(1); // this one task covered; the hedger's slot and any other demand agent's needs are not
    expect(r.perWindow[0]?.total).toBeGreaterThanOrEqual(2);
  });

  it("flags kill criterion 4 when nothing is ever covered ahead", () => {
    const log: LogEntry[] = [entry("2026-10-29", 0, "x", { kind: "notice" }), entry("2026-10-30", 0, "x", { kind: "notice" })];
    const r = scoreBuyingAhead(log, params);
    expect(r.neverCovered).toBe(true);
  });

  it("D133: reads the run's REAL seed from its own genesis log entry, never the committed params file's seed", () => {
    const realSeed = "counted-2026-11-06"; // deliberately different from params.seed ("dev-0")
    expect(realSeed).not.toBe(params.seed);
    const a = params.agents.demand[0] as string;
    const needsFor = needsSchedule(
      realSeed,
      TASKS.filter((t) => t !== "CR-VS"),
    );
    const realNextTask = [...new Set(needsFor(a, 2))][0];
    const log: LogEntry[] = [
      // genesis on its own day, before window 1, as every engine run writes it (D144: that day is window 0)
      entry("2026-10-28", 0, "AGU-ISSUER", { kind: "genesis", seed: realSeed, backend: "stand-in", t0: 0 }),
      entry("2026-10-29", 1, a, {
        kind: "message",
        to: "AGU-ISSUER",
        text: `front-claim order: 0.250 SIU of ${realNextTask} for the next window`,
      }),
      entry("2026-10-30", 0, "x", { kind: "notice" }),
    ];
    const r = scoreBuyingAhead(log, params);
    expect(r.perWindow[0]?.covered).toBe(1); // only matches if the REAL seed's need was used, not params.seed's
  });
});

describe("scoreKillCriteria and renderScoringReport", () => {
  it("fires when two or more criteria fire, and renders a readable report", () => {
    const log: LogEntry[] = [
      entry("2026-10-29", 0, "DEMAND-1", { kind: "escrow-open", escrow: "e1", to: "RESEARCH-1", agu: 1_000n }),
      entry("2026-10-29", 1, "GATE-RUNNER", { kind: "escrow-settle", escrow: "e1", paid: 1_000n, refunded: 0n }),
      entry("2026-10-29", 2, "RESEARCH-1", { kind: "exit", agu: 1_000n, usdc: 10n }), // converted, hop 1: both kill criteria 1 and 2 fire
      entry("2026-10-30", 0, "x", { kind: "notice" }),
    ];
    const ahead = scoreBuyingAhead(log, params);
    const k = scoreKillCriteria(log, params, ahead, new Map());
    expect(k.conversionOnReceipt.agu.fails).toBe(true); // 100% conversion ≥ 90%
    expect(k.medianHops.agu.fails).toBe(true); // median hops 1
    expect(k.noBuyingAheadForVisibleNeeds).toBe(true);
    expect(k.failCount).toBeGreaterThanOrEqual(2);
    expect(k.fails).toBe(true);
    const report = scoreRun(log, params, new Map());
    const rendered = renderScoringReport(report);
    expect(rendered).toContain("KILL CRITERION MET");
    expect(rendered).toContain("Thesis: agents exit only for sweeps and dollar costs");
  });
});

/**
 * A free, scripted run exercises `ScriptedAgent`'s own real "sell to fund a front-claim order" behaviour (DEMAND-2, `agents.ts`), so this checks the log-only
 * reconstruction `exitFacts` uses against the SAME classification the live run's own `World.exits[].label` assigned, confirming the two never disagree.
 */
describe("the log-only classification matches the live run's own labels", () => {
  it("agrees with World.exits[].label for every exit a real scripted run produces", async () => {
    const seed = "scoring-consistency";
    const runParams = { ...params, seed };
    const wp0 = loadCrPrint();
    const sha = standInSha(seed);
    const log = new EconomyLog("stand-in");
    const world = buildWorld({
      params: runParams,
      wp0,
      log,
      worker: new StandInWorker(seed, passRates(wp0), sha),
      t0: 1_800_000_000 - (1_800_000_000 % 86_400),
      dataSha: sha,
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
    await runWindows({
      world,
      agents,
      windows: [1, 2, 3],
      needsFor: needsSchedule(
        seed,
        TASKS.filter((t) => t !== "CR-VS"),
      ),
    });
    expect(world.exits.length).toBeGreaterThan(0); // the scenario actually exercises an exit
    const expectedStructural = world.exits.filter((e) => e.label === "structural dollar route").length;
    const blind = exitsToTagBlind(world.log.entries);
    const tags = new Map(blind.map((b) => [b.key, "other" as ExitClass]));
    const r = scoreThesis(world.log.entries, tags);
    expect(r.total).toBe(world.exits.length);
    expect(r.untagged).toEqual([]);
    expect(r.byClass["structural dollar route"]).toBe(expectedStructural);
  });
});
