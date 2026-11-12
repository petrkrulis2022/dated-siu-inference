/**
 * v3a's measures, gates and blind coding (`v3a-measures.ts`, `v3a-gates.ts`, `v3a-coding.ts`): small constructed logs for each rule, then a full scripted run scored end to
 * end (tests are mandatory for scoring, per the working agreement).
 */
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import { CR_PUBLIC_DIR } from "../paths.js";
import { ScriptedV3aAgent } from "./agents-v3a.js";
import { EconomyLog, type LogEntry } from "./log.js";
import { instructionsForV3a } from "./model-agent.js";
import { loadParams } from "./params.js";
import { loadCrPrint, loadV3aPassRates, runWindows } from "./runner.js";
import { blindItems, decisionKey, extractPricedDecisions, handSample, kappa, modelCoder, codeAll, type UnitLabel } from "./v3a-coding.js";
import { checkGates, gatesPass } from "./v3a-gates.js";
import {
  engineWindows,
  renderArmScore,
  scoreAccount,
  scoreArm,
  scoreComparability,
  scoreDeferredPayment,
  scoreExchange,
  scoreStoreOfValue,
  type V3aRunLog,
} from "./v3a-measures.js";
import { buildV3aWorld, v3aAgentIds } from "./v3a-run.js";
import type { Role } from "./world.js";

const params = loadParams(join(CR_PUBLIC_DIR, "economy-params.v3a.json"));
let seq = 0;
const e = (window: string, actor: string, rest: Partial<LogEntry>): LogEntry =>
  ({ seq: ++seq, window, round: 0, actor, backend: "stand-in", kind: "notice", ...rest }) as LogEntry;
const genesis = (vol: "low" | "high" = "low", arm: "A" | "B" = "A"): LogEntry =>
  e("d0", "AGU-ISSUER", { kind: "genesis", seed: "s", v3a: { arm, volatility: vol, priceSeedHash: "h" } });
const price = (day: string, k: number, rate = 13_000_000n): LogEntry => e(day, "AGU-ISSUER", { kind: "price", atWindow: k, commodity: rate });
const run = (label: string, log: LogEntry[]): V3aRunLog => ({ label, log });

describe("v3a window numbers come from the engine, never from first appearance", () => {
  it("maps genesis's own day to window 0 and each print's day to its window", () => {
    const w = engineWindows([genesis(), price("d1", 1), price("d2", 2)]);
    expect([w.get("d0"), w.get("d1"), w.get("d2")]).toEqual([0, 1, 2]);
  });
});

describe("v3a exchange: AGU-lab's share of freely chosen payments where both currencies were possible", () => {
  const pay = (currency: string, value: bigint, over: Partial<LogEntry> = {}): LogEntry =>
    e("d1", "DEMAND-1", { kind: "payment", currency, valueMicroSiu: value, couldPayBoth: true, payeeAcceptsBoth: true, forced: false, scripted: false, ...over });
  it("counts eligible payments by value, leaves out forced, code and one-sided ones, and reports claims beside", () => {
    const x = scoreExchange(
      [
        run("r", [
          pay("agu", 300n),
          pay("usdc", 600n),
          pay("claims", 100n),
          pay("agu", 9_999n, { forced: true }),
          pay("agu", 9_999n, { scripted: true }),
          pay("agu", 9_999n, { couldPayBoth: false }),
          pay("agu", 9_999n, { payeeAcceptsBoth: false }),
        ]),
      ],
      2,
    );
    // D144: a claim payment is not in the denominator (the claim's purchase was already a payment in USDC or AGU-lab); it is reported under deferred payment
    expect(x.payments).toBe(2);
    expect(x.aguShare).toBeCloseTo(1 / 3);
    expect(x.claimPaymentsLeftOut).toBe(1);
    expect(x.verdict).toBe("signal");
    expect(x.excluded).toEqual({ forced: 1, scripted: 1, payerCouldNotPayBoth: 1, payeeDidNotAcceptBoth: 1 });
  });
  it("kills below 10%, and is n/a below its minimum count", () => {
    expect(scoreExchange([run("r", [pay("agu", 5n), pay("usdc", 95n)])], 2).verdict).toBe("kill");
    expect(scoreExchange([run("r", [pay("agu", 5n)])], 20).verdict).toBe("n/a");
  });
});

describe("v3a account: blind coding, kappa, binding quotes", () => {
  const log = [
    genesis(),
    e("d1", "DEMAND-1", { kind: "reasoning", text: "DEMAND-1 here: 431 mSIU is fair" }),
    e("d1", "DEMAND-1", { kind: "turn", parsed: true, tool: "accept_quote", ok: true }),
    e("d1", "RESEARCH-1", { kind: "reasoning", text: "price it at $0.006" }),
    e("d1", "RESEARCH-1", { kind: "quote", quote: "quote-9", priceUnit: "usdc" }),
    e("d1", "RESEARCH-1", { kind: "turn", parsed: true, tool: "post_quote", ok: true }),
    e("d1", "DEMAND-2", { kind: "reasoning", text: "counter at 400 mSIU" }),
    e("d1", "DEMAND-2", { kind: "message", text: "I'd pay 400 mSIU" }),
    e("d1", "DEMAND-2", { kind: "turn", parsed: true, tool: "message", ok: true }),
    e("d1", "DEMAND-3", { kind: "reasoning", text: "nothing to do" }),
    e("d1", "DEMAND-3", { kind: "turn", parsed: true, tool: "pass", ok: true }),
  ];
  it("extracts every priced decision (a counter-offer is a message naming an amount) and masks every agent id", () => {
    const d = extractPricedDecisions("run-1", log);
    expect(d.map((x) => x.kind)).toEqual(["accept", "quote", "counter"]);
    expect(blindItems(d)[0]?.text).toBe("[agent] here: 431 mSIU is fair");
    expect(d[0]?.key).toBe(decisionKey("run-1", d[0]?.seq as number));
  });
  it("scores SIU's share over decisions both coders agree on, n/a when kappa is below 0.7 or there is no coding", () => {
    const keys = extractPricedDecisions("r", log).map((d) => d.key);
    const labels: UnitLabel[] = ["SIU", "dollars", "SIU"];
    const a = new Map(keys.map((k, i) => [k, labels[i] as UnitLabel]));
    const ok = scoreAccount([run("r", log)], { a, b: a }, 2);
    expect(ok.kappa).toBe(1);
    expect(ok.siuShare).toBeCloseTo(2 / 3);
    expect(ok.bindingQuotes).toEqual({ msiu: 0, usd: 1, msiuShare: 0 });
    expect(ok.verdict).toBe("signal");
    const b = new Map(keys.map((k, i) => [k, (["dollars", "SIU", "none"] as UnitLabel[])[i] as UnitLabel]));
    expect(scoreAccount([run("r", log)], { a, b }, 1).verdict).toBe("n/a");
    expect(scoreAccount([run("r", log)], undefined, 1).reason).toBe("not coded yet");
  });
  it("computes Cohen's kappa, draws a seeded 10% hand sample, and codes through a forced tool call", async () => {
    const a = new Map<string, UnitLabel>([["1", "SIU"], ["2", "SIU"], ["3", "dollars"], ["4", "none"]]);
    const b = new Map<string, UnitLabel>([["1", "SIU"], ["2", "dollars"], ["3", "dollars"], ["4", "none"]]);
    // po 0.75; pe = (2/4)(1/4) + (1/4)(2/4) + (1/4)(1/4) = 0.3125; kappa = 0.4375 / 0.6875
    expect(kappa(a, b).kappa).toBeCloseTo(0.6364, 3);
    const items = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, kind: "quote", text: "t" }));
    expect(handSample(items, "seed")).toHaveLength(5);
    expect(handSample(items, "seed")).toEqual(handSample(items, "seed"));
    const chat = {
      provider: "openai" as const,
      init: (p: string) => [{ role: "user", content: p }],
      toolSpecs: (d: unknown) => d,
      send: () => Promise.resolve({ status: 200, attempts: 1, reply: { toolUses: [{ name: "code_unit", args: { unit: "both" } }] } }),
    };
    const coded = await codeAll(items.slice(0, 2), modelCoder(chat as never));
    expect([...coded.values()]).toEqual(["both", "both"]);
  });
});

describe("v3a store of value: the median work share at window 8; the kill only in low volatility", () => {
  const h = (actor: string, close: number, bps: bigint): LogEntry => e(`d${close}`, actor, { kind: "holdings", atClose: close, workShareBps: bps });
  it("D144: reports the median against the shadow NAV (no buffer support) beside the verdict's NAV", () => {
    const hs = (actor: string, bps: bigint, shadow: bigint): LogEntry =>
      e("d8", actor, { kind: "holdings", atClose: 8, workShareBps: bps, workShareBpsShadow: shadow });
    const s = scoreStoreOfValue([run("a", [genesis("low"), hs("A", 4_000n, 3_000n), hs("B", 4_400n, 3_400n), hs("C", 5_000n, 4_000n)])], 8, 3);
    expect(s.finalMedian).toBe(0.44);
    expect(s.shadow.finalMedian).toBe(0.34);
    expect(s).not.toHaveProperty("withBuffer");
  });

  it("takes the median across every agent of every run at the last close", () => {
    const s = scoreStoreOfValue([run("a", [genesis("low"), h("A", 8, 1_000n), h("B", 8, 1_200n), h("C", 8, 9_000n)])], 8, 3);
    expect(s.finalMedian).toBe(0.12);
    expect(s.verdict).toBe("kill");
    const high = scoreStoreOfValue([run("a", [genesis("high"), h("A", 8, 1_000n), h("B", 8, 1_200n), h("C", 8, 9_000n)])], 8, 3);
    expect(high.verdict).toBe("neither"); // the kill is judged in low-volatility runs only
  });
});

describe("v3a deferred payment: missed worthwhile purchases", () => {
  it("counts a worthwhile opportunity as missed unless the agent bought that work ahead before its window", () => {
    const log = [
      genesis(),
      price("d1", 1),
      e("d1", "DEMAND-1", { kind: "opportunity", forWindow: 2, task: "CR-PL", worthwhile: true }),
      e("d1", "DEMAND-1", { kind: "opportunity", forWindow: 2, task: "CR-UO", worthwhile: true }),
      e("d1", "DEMAND-1", { kind: "opportunity", forWindow: 3, task: "CR-SM", worthwhile: false }),
      e("d1", "DEMAND-1", { kind: "claim-mint", forWindow: 2, task: "CR-PL" }),
      e("d1", "DEMAND-1", { kind: "payment", what: "claims", currency: "agu", forWindow: 2, valueMicroSiu: 301_000n }),
      e("d1", "DEMAND-2", { kind: "payment", what: "brief", currency: "claims", forWindow: 1, valueMicroSiu: 431_000n }),
    ];
    const d = scoreDeferredPayment([run("r", log)], 2);
    expect(d.worthwhile).toBe(2);
    expect(d.missed).toBe(1);
    expect(d.missedShare).toBe(0.5);
    expect(d.verdict).toBe("signal");
    expect(d.forwardShares.agu).toBe(1);
    // D144: claims paid for briefs are reported here, never in the exchange measure
    expect(d.claimTransfers).toEqual({ count: 1, valueMicroSiu: 431_000n });
    expect(scoreDeferredPayment([run("r", log)], 20).verdict).toBe("n/a");
  });
});

describe("v3a comparability: the cheapest offer per accepted mSIU, by display order", () => {
  // D146 (owner, 2026-11-12) replaces D143's scoring of a C1-versus-X choice: issuers with different pass rates are not comparable offers, so such a choice is left out,
  // whether failed work is refunded or paid for
  it("leaves out a choice between C1 and ISSUER-X (different pass rates), whether failed work is refunded or paid for", () => {
    const pass = loadV3aPassRates(params);
    const commission = (day: string, to: string): LogEntry =>
      e(day, "RESEARCH-1", { kind: "escrow-open", to, task: "CR-PL", alternatives: { "ISSUER-C1": 300_848n, "ISSUER-X": 255_721n } });
    const log = [genesis(), price("d1", 1), price("d3", 3), commission("d1", "ISSUER-X"), commission("d3", "ISSUER-C1")];
    for (const failedWorkPays of [false, true]) {
      const c = scoreComparability([run("r", log)], pass, failedWorkPays, 1, 1);
      expect(c.siuFirst.decisions + c.dollarsFirst.decisions).toBe(0);
      expect(c.excluded.commission).toBe(2);
      expect(c.verdict).toBe("n/a");
    }
  });

  it("with failed work paid for, the cost per accepted task still decides among issuers of the same pass rate", () => {
    const pass = { "ISSUER-C1": { "CR-PL": 9_444 }, "ISSUER-C2": { "CR-PL": 9_444 } };
    const log = [
      genesis(),
      price("d1", 1),
      e("d1", "RESEARCH-1", { kind: "escrow-open", to: "ISSUER-C2", task: "CR-PL", alternatives: { "ISSUER-C1": 300_848n, "ISSUER-C2": 290_000n } }),
    ];
    for (const failedWorkPays of [false, true]) expect(scoreComparability([run("r", log)], pass, failedWorkPays, 1, 1).siuFirst).toEqual({ decisions: 1, cheapest: 1, share: 1 });
  });
});

describe("v3a validity gates and a full scripted run, scored end to end", () => {
  async function scripted(seed: string, arm: "A" | "B"): Promise<LogEntry[]> {
    const p = { ...params, seed };
    const log = new EconomyLog("stand-in");
    const { world, needsFor } = buildV3aWorld({ params: p, wp0: loadCrPrint(), log, t0: 1_799_971_200, arm, volatility: "low", priceSeed: `price:${seed}` });
    await runWindows({
      world,
      agents: v3aAgentIds(p).map(([id, role]) => new ScriptedV3aAgent(id, role)),
      windows: [1, 2, 3, 4, 5, 6, 7, 8],
      needsFor,
      instructions: (role, siuFirst) => instructionsForV3a(role as Role, siuFirst),
    });
    return log.entries;
  }

  it("passes every gate on a clean scripted run, and fails each gate on a log that breaks it", async () => {
    const log = await scripted("v3a-gates", "B");
    const gates = checkGates(log, params);
    expect(gates.map((g) => [g.name, g.ok, g.detail])).toEqual(gates.map((g) => [g.name, true, g.detail]));
    expect(gatesPass(gates)).toBe(true);
    // lost turns: one service failure in 576 turns is over 1%? no -- 6 of them is
    const lost = [...log];
    let n = 0;
    for (let i = 0; i < lost.length && n < 6; i++)
      if (lost[i]?.kind === "turn" && lost[i]?.parsed === true) {
        lost[i] = { ...(lost[i] as LogEntry), parsed: false, serviceFailure: "model call failed (status 400)" };
        n++;
      }
    expect(checkGates(lost, params)[0]?.ok).toBe(false);
    // starting balances
    const uneven = log.map((x) => (x.kind === "holdings" && x.atClose === 0 && x.actor === "DEMAND-1" ? { ...x, aguValueMicroUsd: 40_000n } : x));
    expect(checkGates(uneven, params)[1]?.ok).toBe(false);
    // board integrity: a quote shown after it was paid
    const paid = log.find((x) => x.kind === "receipt" && typeof x.brief === "string");
    const later = log.findIndex((x) => x.kind === "turn" && (x.boardSeq as number) > (paid?.seq ?? 0) && x.window === paid?.window);
    expect(later).toBeGreaterThan(-1);
    const stale = log.map((x, i) => (i === later ? { ...x, boardQuotes: [paid?.brief] } : x));
    expect(checkGates(stale, params)[2]?.ok).toBe(false);
    // the seed: a counted cell whose hash is not the frozen one
    expect(checkGates(log, params, { cell: "A-low-1" }).find((g) => g.name.startsWith("the run's seed"))?.ok).toBe(false);
    // D146 (amends D144): the buffer is replaced by an open-ended lab subsidy, so there is no buffer gate; what the subsidy paid is reported instead
    expect(gates.some((x) => x.name.startsWith("the buffer"))).toBe(false);
    // D145: v6's issuance limit must never bind -- a creation or a roll refused for lack of total headroom makes the run invalid
    const issuance = (g: ReturnType<typeof checkGates>) => g.find((x) => x.name.startsWith("v6's issuance limit"));
    expect(issuance(gates)?.ok).toBe(true);
    const last = log.at(-1) as LogEntry;
    const bound: LogEntry[] = [
      ...log,
      { ...last, seq: last.seq + 1, actor: "PARTICIPANT", kind: "issuance-limit", what: "ladder creation", task: "CR-PL", wanted: 1_000n, placed: 200n } as LogEntry,
    ];
    expect(issuance(checkGates(bound, params))?.ok).toBe(false);
    const refusedRoll = log.map((x) =>
      x.kind === "roll-buy" && x.summary === true && x.refused === undefined ? { ...x, refused: "NoTotalHeadroom(CR-PL, 4514, 3000)" } : x,
    );
    expect(issuance(checkGates(refusedRoll, params))?.ok).toBe(false);
  }, 60_000);

  it("scores both arms of scripted runs end to end and renders the report", async () => {
    const a = await scripted("v3a-score-a", "A");
    const b = await scripted("v3a-score-b", "B");
    const pass = loadV3aPassRates(params);
    const sa = scoreArm("A", [run("a", a)], params, pass);
    const sb = scoreArm("B", [run("b", b)], params, pass);
    expect(sa.exchange.payments).toBeGreaterThan(0);
    // every model agent with any wealth left at the last close (a share of nothing is not a share)
    expect(sa.storeOfValue.finalN).toBe(a.filter((x) => x.kind === "holdings" && x.atClose === 8 && x.workShareBps !== null).length);
    expect(sa.storeOfValue.finalN).toBeGreaterThan(0);
    expect(sa.account.verdict).toBe("n/a"); // not coded: never a kill signal
    expect(sa.killSignals).not.toContain("account");
    expect(sb.armB?.checks).toBe(40);
    expect(sa.armB).toBeUndefined();
    const text = renderArmScore(sa) + renderArmScore(sb);
    expect(text).toMatch(/## Arm A/);
    expect(text).toMatch(/Kill signals:/);
    expect(text).toMatch(/Arm B rule/);
  }, 60_000);
});

// keep D and the fixture helpers referenced for the type checker
void D;

describe("D146 (owner, 2026-11-12): comparability counts only decisions among offers with the same pass rate", () => {
  const pass = { "ISSUER-C1": { "CR-PL": 10_000 }, "ISSUER-C2": { "CR-PL": 10_000 }, "ISSUER-X": { "CR-PL": 8_000 } };
  const commission = (seq: number, to: string, alternatives: Record<string, bigint>): LogEntry =>
    ({ ...e("d1", "RESEARCH-1", { kind: "escrow-open", task: "CR-PL", to, alternatives }), seq }) as LogEntry;
  const claims = (seq: number, offer: string, alternatives: { offer: string; issuer: string; discountBps: bigint }[]): LogEntry =>
    ({ ...e("d1", "DEMAND-1", { kind: "claim-mint", task: "CR-PL", offer, alternatives }), seq }) as LogEntry;

  it("commissions: ISSUER-X leaves the alternatives, a commission given to X is not counted, and a choice left with one alternative is not a decision", () => {
    const log = [
      genesis(),
      price("d1", 1),
      commission(10, "ISSUER-C1", { "ISSUER-C1": 100n, "ISSUER-C2": 90n, "ISSUER-X": 80n }), // C1 vs C2: counted, not the cheapest
      commission(11, "ISSUER-X", { "ISSUER-C1": 100n, "ISSUER-C2": 90n, "ISSUER-X": 80n }), // a choice involving X: excluded
      commission(12, "ISSUER-C2", { "ISSUER-C2": 90n, "ISSUER-X": 80n }), // only C2 left at its pass rate: no decision
    ];
    const c = scoreComparability([run("a", log)], pass, false, 1, 1);
    expect(c.byKind.commission).toBe(1);
    expect(c.siuFirst.decisions + c.dollarsFirst.decisions).toBe(1);
    expect(c.siuFirst.cheapest + c.dollarsFirst.cheapest).toBe(0);
    expect(c.excluded.commission).toBe(2);
  });

  it("claim purchases: offers from an issuer with another pass rate leave the alternatives; buying X's offer is not counted", () => {
    const alts = [
      { offer: "offer-1", issuer: "ISSUER-C1", discountBps: 200n },
      { offer: "offer-2", issuer: "ISSUER-C2", discountBps: 100n },
      { offer: "offer-3", issuer: "ISSUER-X", discountBps: 1_500n },
    ];
    const log = [genesis(), price("d1", 1), claims(10, "offer-1", alts), claims(11, "offer-3", alts)];
    const c = scoreComparability([run("a", log)], pass, false, 1, 1);
    // offer-1 is the deepest discount among C1 and C2 (X's deeper one is not comparable): counted, cheapest
    expect(c.byKind.claims).toBe(1);
    expect(c.siuFirst.cheapest + c.dollarsFirst.cheapest).toBe(1);
    expect(c.excluded.claims).toBe(1);
  });

  it("reports how many decisions each source contributes, and how many were left out for a different pass rate", () => {
    const log = [genesis(), price("d1", 1), commission(10, "ISSUER-X", { "ISSUER-C1": 100n, "ISSUER-C2": 90n, "ISSUER-X": 80n })];
    const text = renderArmScore(scoreArm("A", [run("a", log)], params, pass));
    expect(text).toMatch(/decisions: 0 briefs \(research quotes\), 0 commissions \(C1 vs C2\), 0 claim purchases \(PROVIDER's offers\); left out for a different pass rate: 1 commission, 0 claim purchases/);
  });
});

describe("D146 (owner, 2026-11-12): the scorer reports the lab subsidy each run drew", () => {
  it("totals what each run's rolls drew from the lab subsidy for unsold front work", () => {
    const pass = loadV3aPassRates(params);
    const roll = (day: string, cover: bigint): LogEntry => e(day, "AGU-ISSUER", { kind: "roll-buy", summary: true, cover });
    const a = run("a", [genesis(), price("d1", 1), roll("d1", 100_000n), price("d2", 2), roll("d2", 250_000n)]);
    const b = run("b", [genesis(), price("d1", 1), roll("d1", 0n)]);
    const s = scoreArm("A", [a, b], params, pass);
    expect(s.subsidy).toEqual([
      { label: "a", paidUsdc: 350_000n },
      { label: "b", paidUsdc: 0n },
    ]);
    expect(renderArmScore(s)).toMatch(/Lab subsidy for unsold front work, per run: a 350,000 µ\$, b 0 µ\$/);
  });
});
