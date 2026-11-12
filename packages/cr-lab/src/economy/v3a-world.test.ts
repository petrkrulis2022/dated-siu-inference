/**
 * v3a mechanics (docs/experiment-3a-design.md; decisions D142, D143), on the candidate v3a parameters and a seeded price path. A full scripted run first (every invariant is
 * checked after every turn and step), then each mechanic on its own.
 */
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import { CR_PUBLIC_DIR } from "../paths.js";
import { TASKS, type TaskId } from "../tasks/instances.js";
import { StandInWorker, type Agent } from "./agents.js";
import { ScriptedV3aAgent } from "./agents-v3a.js";
import { boardFor, renderBoard } from "./board.js";
import { EconomyLog, type LogEntry } from "./log.js";
import { PARTICIPANT } from "./memory-chain.js";
import { checkGates } from "./v3a-gates.js";
import { judgeDevWindows } from "./report.js";
import { instructionsForV3a } from "./model-agent.js";
import { loadParams, type EconomyParams, type IssuerParams } from "./params.js";
import { parseToolCall, toolDefsForRole } from "./parse.js";
import { pricePath, pricePathSeedHash } from "./price-path.js";
import { buildWorld, loadCrPrint, loadV3aPassRates, needsSchedule, passRates, runWindows, standInSha } from "./runner.js";
import type { Arm } from "./v3a-market.js";
import type { Role, TaskWorker, WorkOutcome, World } from "./world.js";

const V3A = join(CR_PUBLIC_DIR, "economy-params.v3a.json");
const T0 = 1_799_971_200;
const BRIEF_TASKS = TASKS.filter((t): t is TaskId => t !== "CR-VS");

class SetWorker implements TaskWorker {
  readonly queue: boolean[] = [];
  constructor(readonly sha: (k: number) => string) {}
  work(_i: IssuerParams, _t: TaskId, ctx: { window: number }): Promise<WorkOutcome> {
    const passed = this.queue.length > 0 ? (this.queue.shift() as boolean) : true;
    return Promise.resolve({ passed, costUsd: new D(0), dataSha: this.sha(ctx.window) });
  }
}

function v3aWorld(
  seed: string,
  opts: { arm?: Arm; vol?: "low" | "high"; worker?: "set" | "stand-in"; patch?: (p: EconomyParams) => void; start?: boolean } = {},
) {
  const params = { ...loadParams(V3A), seed };
  opts.patch?.(params);
  const v = params.v3a as NonNullable<EconomyParams["v3a"]>;
  const wp0 = loadCrPrint();
  const sha = standInSha(seed);
  const path = pricePath({
    seed: `path:${seed}`,
    volPpm: opts.vol === "high" ? v.printPath.highVolPpm : v.printPath.lowVolPpm,
    classNoisePpm: v.printPath.classNoisePpm,
    burnIn: v.printPath.burnIn,
    windows: v.windows,
    start: {
      commodity: BigInt(wp0.prints.find((p) => p.grade === "commodity")?.nanoUsdPerSiu as string),
      frontier: BigInt(wp0.prints.find((p) => p.grade === "frontier")?.nanoUsdPerSiu as string),
    },
    classes: TASKS,
  });
  const setWorker = new SetWorker(sha);
  const worker = opts.worker === "stand-in" ? new StandInWorker(seed, passRates(wp0), sha, loadV3aPassRates(params)) : setWorker;
  const w = buildWorld({
    params,
    wp0,
    log: new EconomyLog("stand-in"),
    worker,
    t0: T0,
    dataSha: sha,
    v3a: { arm: opts.arm ?? "A", volatility: opts.vol ?? "low", path, priceSeedHash: pricePathSeedHash(`path:${seed}`) },
  });
  w.genesis();
  const needsFor = needsSchedule(seed, BRIEF_TASKS);
  if (opts.start !== false) w.startWindow(1, needsFor);
  return { w, worker: setWorker, needsFor, params, path };
}

const ids = (p: EconomyParams): [string, Role][] => [
  [p.agents.provider as string, "provider"],
  ...p.agents.research.map((a): [string, Role] => [a, "research"]),
  ...p.agents.demand.map((a): [string, Role] => [a, "demand"]),
  [p.agents.hedger, "hedger"],
];

describe("v3a: a full scripted run (8 windows, arm B, stand-in issuers at the committed pass rates)", () => {
  async function run(seed: string): Promise<{ w: World; log: LogEntry[] }> {
    const { w, needsFor, params } = v3aWorld(seed, { arm: "B", worker: "stand-in", start: false });
    const agents: Agent[] = ids(params).map(([id, role]) => new ScriptedV3aAgent(id, role));
    await runWindows({
      world: w,
      agents,
      windows: [1, 2, 3, 4, 5, 6, 7, 8],
      needsFor,
      instructions: (role, siuFirst) => instructionsForV3a(role as Role, siuFirst),
    });
    return { w, log: w.log.entries };
  }

  it("runs every window with every invariant holding, and exercises every v3a path", async () => {
    // D145: the scripted agents size offers by issuer headroom, so the capacity change moved their paths; the old seed no longer paid a brief in claims, this one does
    const { log } = await run("v3a-full-3");
    const of = (k: string) => log.filter((e) => e.kind === k);
    const turns = of("turn").filter((e) => e.parsed === true);
    expect(of("turn").filter((e) => e.parsed === false)).toEqual([]); // every scripted reply parses under the v3a tools
    // the only refusals a scripted run may meet are its mandates doing their job (a demand agent's cap or minimum value); anything else is a fault
    expect(
      turns
        .filter((e) => e.ok === false && !/would leave .* below your minimum|over spend cap/.test(String(e.note)))
        .map((e) => `${e.actor} ${e.tool}: ${e.note}`),
    ).toEqual([]);
    expect(of("offer").length).toBeGreaterThan(0);
    expect(of("offer").some((e) => e.replaces !== undefined)).toBe(true);
    expect(of("offer").some((e) => e.withdrawn === true)).toBe(true);
    expect(of("offer").some((e) => e.request !== undefined)).toBe(true);
    expect(of("claim-mint").filter((e) => e.offer !== undefined).length).toBeGreaterThan(0);
    expect(of("claim-transfer").length).toBeGreaterThan(0); // a brief paid in claims
    const pays = of("payment");
    for (const c of ["usdc", "agu", "claims"]) expect(pays.some((e) => e.currency === c)).toBe(true);
    expect(pays.some((e) => e.what === "front claims" && e.currency === "agu")).toBe(true);
    expect(of("sweep").map((e) => e.window)).toHaveLength(8); // 4 demand agents x 2 sweeps
    expect(of("rule-check")).toHaveLength(8 * 5);
    expect(of("holdings")).toHaveLength(9 * 9); // window 0 and every close, every model agent
    expect(of("opportunity").length).toBeGreaterThan(0);
    expect(of("board").map((e) => e.actor).sort()).toEqual(
      ["DEMAND-1", "DEMAND-2", "DEMAND-3", "DEMAND-4", "HEDGER", "PROVIDER", "RESEARCH-1", "RESEARCH-2", "RESEARCH-3"],
    );
    expect(of("price")).toHaveLength(8);
    expect(of("gate").filter((e) => e.brief !== undefined && e.passed === true).length).toBeGreaterThan(0);
  });

  it("is deterministic: the same seed gives a byte-identical log", async () => {
    const a = await run("v3a-det");
    const b = await run("v3a-det");
    expect(a.w.log.text()).toBe(b.w.log.text());
  });
});

describe("v3a genesis: every role starts with both currencies at equal value", () => {
  it("logs each wallet with its USDC and its AGU-lab value at mid equal to under one micro-dollar; PROVIDER starts empty", () => {
    const { w, params } = v3aWorld("v3a-genesis", { start: false });
    const h = w.log.entries.filter((e) => e.kind === "holdings" && e.atClose === 0);
    expect(h).toHaveLength(9);
    for (const e of h) {
      if (e.actor === params.v3a?.provider) {
        expect(e.totalMicroSiu).toBe(0n);
        continue;
      }
      const start = e.role === "research" ? 25_000n : 50_000n;
      expect(e.usdc).toBe(start);
      const diff = (e.aguValueMicroUsd as bigint) - start;
      expect(diff >= -1n && diff <= 1n, `${e.actor}: ${e.aguValueMicroUsd} vs ${start}`).toBe(true);
    }
    w.checkInvariants();
  });
});

describe("v3a prices: the seeded path, class drift, ISSUER-X's list price", () => {
  it("opens at the path's opening print and moves to each window's print at its open, logging it", () => {
    const { w, path, needsFor } = v3aWorld("v3a-path", { vol: "high" });
    expect(w.commodityRate).toBe(path.find((p) => p.window === 1)?.rates.commodity);
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    expect(w.commodityRate).toBe(path.find((p) => p.window === 2)?.rates.commodity);
    expect(w.log.entries.filter((e) => e.kind === "price").map((e) => e.atWindow)).toEqual([1, 2]);
  });

  it("lists ISSUER-X 15% below C1/C2 (the owner's D143), and moves each class's list price with its own drift", () => {
    const { w, path } = v3aWorld("v3a-x");
    const base = w.v3a?.baseTaskPrice;
    // 15% below, to within one micro-SIU of rounding (taskPrices rounds the discounted cost once, up)
    const x = base?.["ISSUER-X"]?.["CR-PL"] as bigint;
    const c = ((base?.["ISSUER-C1"]?.["CR-PL"] as bigint) * 8_500n) / 10_000n;
    expect(x - c >= -1n && x - c <= 1n, `${x} vs ${c}`).toBe(true);
    const ppm = path.find((p) => p.window === 1)?.classPpm["CR-UO"] as bigint;
    expect(w.taskPrice["ISSUER-C1"]?.["CR-UO"]).toBe(((base?.["ISSUER-C1"]?.["CR-UO"] as bigint) * ppm) / 1_000_000n);
  });

  it("gives ISSUER-X the 80% floor and C1 haiku-5-5's measured rate, from the pass-rate table whose hash the config pins", () => {
    const rates = loadV3aPassRates(loadParams(V3A));
    expect(rates["ISSUER-X"]).toEqual({ "CR-PL": 8_000, "CR-UO": 8_000, "CR-SM": 8_000 });
    expect(rates["ISSUER-C1"]?.["CR-PL"]).toBe(9_444);
    expect(() => loadV3aPassRates({ ...loadParams(V3A), v3a: { ...(loadParams(V3A).v3a as NonNullable<EconomyParams["v3a"]>), passRates: { path: "data/lab/cr/v3a/pass-rates.json", sha256: "0".repeat(64) } } })).toThrow(/pins/);
  });
});

describe("v3a PROVIDER: standing offers, revisions, withdrawals, requests (D143)", () => {
  it("posts, revises and withdraws offers; answers a request with an offer to that buyer; the request leaves the board", async () => {
    const { w } = v3aWorld("v3a-offers");
    const r = await w.act("DEMAND-1", { tool: "request_claims", task: "CR-PL", window: 2, milli: 301n }, "r");
    expect(r.ok, r.note).toBe(true);
    const req = w.v3a?.requests[0];
    expect(boardFor(w, "PROVIDER").v3a?.requests.map((x) => x.id)).toEqual([req?.id]);
    const ans = await w.act(
      "PROVIDER",
      { tool: "post_offer", issuer: "ISSUER-C1", task: "CR-PL", window: 2, milli: 301n, discountBps: 300n, accept: "both", to: "DEMAND-1", request: req?.id },
      "r",
    );
    expect(ans.ok, ans.note).toBe(true);
    expect(req?.status).toBe("answered");
    expect(boardFor(w, "DEMAND-2").v3a?.offers).toHaveLength(0); // offered to DEMAND-1 only
    const o = w.v3a?.offers[0];
    const rev = await w.act(
      "PROVIDER",
      { tool: "post_offer", issuer: "ISSUER-C1", task: "CR-PL", window: 2, milli: 301n, discountBps: 100n, accept: "usdc", to: "DEMAND-1", replaces: o?.id },
      "r",
    );
    expect(rev.ok, rev.note).toBe(true);
    expect(o?.status).toBe("replaced");
    const live = w.v3a?.offers.find((x) => x.status === "live");
    expect((await w.act("PROVIDER", { tool: "withdraw_offer", offer: live?.id as string }, "r")).ok).toBe(true);
    expect(boardFor(w, "DEMAND-1").v3a?.offers).toHaveLength(0);
  });

  it("refuses an offer outside the rules, each refusal naming why", async () => {
    const { w } = v3aWorld("v3a-offer-rules");
    const base = { tool: "post_offer" as const, issuer: "ISSUER-C1", task: "CR-PL" as TaskId, window: 2, milli: 100n, discountBps: 0n, accept: "both" as const, to: "all" };
    expect((await w.act("PROVIDER", { ...base, window: 9 }, "r")).note).toMatch(/offer claims for windows 1 to 4/);
    expect((await w.act("PROVIDER", { ...base, discountBps: 6_000n }, "r")).note).toMatch(/discount must be from -2000 to 5000/);
    expect((await w.act("PROVIDER", { ...base, issuer: "ISSUER-F" }, "r")).note).toMatch(/bonds no CR-PL claims/);
    expect((await w.act("PROVIDER", { ...base, milli: 10n ** 12n }, "r")).note).toMatch(/headroom/);
    expect((await w.act("DEMAND-1", base, "r")).note).toBe("only PROVIDER posts claim offers");
  });

  it("an unanswered request lapses at the end of the window it was posted in", async () => {
    const { w } = v3aWorld("v3a-req-lapse");
    await w.act("DEMAND-2", { tool: "request_claims", task: "CR-SM", window: 3, milli: 86n }, "r");
    w.closeWindow(1);
    expect(w.v3a?.requests[0]?.status).toBe("lapsed");
  });
});

describe("v3a buying claims: paid to PROVIDER in the accepted currency, minted from the named issuer, counted against the window of delivery", () => {
  async function offered(seed: string, accept: "usdc" | "agu" | "both" = "both") {
    const r = v3aWorld(seed);
    const o = await r.w.act(
      "PROVIDER",
      { tool: "post_offer", issuer: "ISSUER-X", task: "CR-UO", window: 2, milli: 1_000n, discountBps: 1_000n, accept, to: "all" },
      "r",
    );
    expect(o.ok, o.note).toBe(true);
    return { ...r, offer: r.w.v3a?.offers[0]?.id as string };
  }

  it("moves the payment to PROVIDER, mints PROVIDER's own token type from ISSUER-X for window 2, and records it", async () => {
    const { w, offer } = await offered("v3a-buy");
    const before = w.chain.balance("PROVIDER", "USDC");
    const r = await w.act("DEMAND-1", { tool: "buy_offer", offer, milli: 58n, pay: "usdc" }, "r");
    expect(r.ok, r.note).toBe(true);
    const mint = w.log.entries.find((e) => e.kind === "claim-mint" && e.offer === offer);
    expect(mint?.issuer).toBe("ISSUER-X");
    expect(w.chain.balance("PROVIDER", "USDC")).toBe(before + (mint?.usdc as bigint));
    expect(w.v3a?.providerTokens.has(mint?.tokenId as string)).toBe(true);
    expect(w.v3a?.record.get("ISSUER-X|2")?.mintedMilli).toBeGreaterThanOrEqual(58n);
    expect(w.spentFor("DEMAND-1", 2)).toBe(mint?.valueMicroSiu);
    expect(w.spentFor("DEMAND-1", 1)).toBe(0n); // the work is for window 2: that is the window it counts against
    const pay = w.log.entries.find((e) => e.kind === "payment" && e.ref === offer);
    expect(pay).toMatchObject({ currency: "usdc", payeeAcceptsBoth: true, couldPayBoth: true, forWindow: 2 });
    w.checkInvariants();
  });

  it("refuses a currency the offer does not accept", async () => {
    const { w, offer } = await offered("v3a-buy-accept", "usdc");
    expect((await w.act("DEMAND-1", { tool: "buy_offer", offer, milli: 58n, pay: "agu" }, "r")).note).toBe(`${offer}: PROVIDER accepts usdc on this offer`);
  });

  it("refuses beyond the mandate's cap for the window of delivery, and beyond its minimum value", async () => {
    const { w, offer } = await offered("v3a-cap", "both");
    const cap = w.v3aCapMicroSiu("DEMAND-3") as bigint; // cautious: 3 reference briefs
    expect(cap).toBe(3n * w.v3aReferenceBriefMicroSiu());
    const r = await w.act("DEMAND-3", { tool: "buy_offer", offer, milli: 1_000n, pay: "usdc" }, "r");
    // 1,000 mSIU at 10% off is 900 mSIU of value: under the cap, but check the refusal shape by tightening the cap
    expect(r.ok, r.note).toBe(true);
    const { w: w2, offer: o2 } = await offered("v3a-cap-2", "both");
    const tight = v3aWorld("v3a-cap-3", {
      patch: (p) => {
        const v = p.v3a as NonNullable<EconomyParams["v3a"]>;
        v.mandates = { ...v.mandates, "DEMAND-3": { ...(v.mandates["DEMAND-3"] as NonNullable<typeof v.mandates[string]>), capBriefsPerWindow: 0 } };
      },
    });
    await tight.w.act(
      "PROVIDER",
      { tool: "post_offer", issuer: "ISSUER-X", task: "CR-UO", window: 2, milli: 1_000n, discountBps: 0n, accept: "both", to: "all" },
      "r",
    );
    const t = await tight.w.act("DEMAND-3", { tool: "buy_offer", offer: tight.w.v3a?.offers[0]?.id as string, milli: 58n, pay: "usdc" }, "r");
    expect(t.note).toMatch(/over spend cap for window 2: [\d,]+ (mSIU|µ\$) \(≈ [\d,]+ (mSIU|µ\$)\) of 0 (mSIU|µ\$) \(≈ 0 (mSIU|µ\$)\)/); // D146: board units, paired
    // the buffer: a permissive agent cannot spend below 10% of its starting value
    w2.chain.transfer("USDC", "DEMAND-4", "OWNER-X", w2.chain.balance("DEMAND-4", "USDC") - 1_000n);
    w2.chain.transfer("AGU", "DEMAND-4", "OWNER-X", w2.chain.balance("DEMAND-4", "AGU"));
    w2.mint("OWNER-X", 0n);
    const b = await w2.act("DEMAND-4", { tool: "buy_offer", offer: o2, milli: 58n, pay: "usdc" }, "r");
    expect(b.note).toMatch(/would leave -?[\d,]+ (mSIU|µ\$) \(≈ -?[\d,]+ (mSIU|µ\$)\) of value, below your minimum of [\d,]+ (mSIU|µ\$) \(≈ [\d,]+ (mSIU|µ\$)\)/); // D146: board units, paired
  });
});

describe("v3a presenting: one task uses its class's fixed work; PROVIDER pays the issuer when a claim it sold is served", () => {
  it("refuses a holding smaller than one task; a pass uses exactly one task's work and PROVIDER pays the issuer its list price", async () => {
    const { w, needsFor } = v3aWorld("v3a-present");
    await w.act("PROVIDER", { tool: "post_offer", issuer: "ISSUER-C1", task: "CR-SM", window: 2, milli: 500n, discountBps: 0n, accept: "both", to: "all" }, "r");
    const offer = w.v3a?.offers[0]?.id as string;
    await w.act("HEDGER", { tool: "buy_offer", offer, milli: 50n, pay: "usdc" }, "r"); // less than one CR-SM task (86 mSIU)
    await w.act("HEDGER", { tool: "buy_offer", offer, milli: 86n, pay: "agu" }, "r");
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    const claim = w.log.entries.find((e) => e.kind === "claim-mint" && e.offer === offer)?.tokenId as string;
    expect(w.chain.claimBalance("HEDGER", claim)).toBe(136n);
    const providerUsdc = w.chain.balance("PROVIDER", "USDC");
    const p = await w.act("HEDGER", { tool: "present_claim", claim }, "r");
    expect(p.ok, p.note).toBe(true);
    expect(w.chain.claimBalance("HEDGER", claim)).toBe(50n); // 86 mSIU used
    const small = await w.act("HEDGER", { tool: "present_claim", claim }, "r");
    expect(small.note).toMatch(/one CR-SM task takes (86 mSIU \(≈ [\d,]+ µ\$\)|[\d,]+ µ\$ \(≈ 86 mSIU\)) of claim; you hold (50 mSIU \(≈ [\d,]+ µ\$\)|[\d,]+ µ\$ \(≈ 50 mSIU\))/); // D146: board units, paired
    // PROVIDER paid ISSUER-C1 its list price for the task: in USDC if it held enough, otherwise in AGU-lab (here its USDC was short of one CR-SM task)
    const paid = w.log.entries.find((e) => e.kind === "provider-profit" && e.issuer === "ISSUER-C1");
    expect(paid?.cost).toBe(w.taskPrice["ISSUER-C1"]?.["CR-SM"]);
    expect(paid?.paidIn).toBe(providerUsdc >= ((paid?.cost as bigint) * w.commodityRate + 999_999_999n) / 1_000_000_000n ? "usdc" : "agu");
    expect(w.v3a?.record.get("ISSUER-C1|2")?.served).toBe(1);
  });

  it("charges PROVIDER's profit for a default on a claim it sold (decision 6)", async () => {
    const { w, worker, needsFor } = v3aWorld("v3a-default");
    await w.act("PROVIDER", { tool: "post_offer", issuer: "ISSUER-X", task: "CR-UO", window: 2, milli: 58n, discountBps: 0n, accept: "both", to: "all" }, "r");
    await w.act("HEDGER", { tool: "buy_offer", offer: w.v3a?.offers[0]?.id as string, milli: 58n, pay: "usdc" }, "r");
    const sold = w.v3a?.providerProfitMicroSiu as bigint;
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    const claim = w.log.entries.find((e) => e.kind === "claim-mint" && e.issuer === "ISSUER-X")?.tokenId as string;
    worker.queue.push(false);
    await w.act("HEDGER", { tool: "present_claim", claim }, "r");
    w.closeWindow(2);
    const close = w.log.entries.find((e) => e.kind === "claim-close" && e.tokenId === claim);
    expect(close?.outcome).toBe("defaulted");
    expect(w.v3a?.record.get("ISSUER-X|2")?.defaultedMilli).toBe(58n);
    expect(w.v3a?.providerProfitMicroSiu).toBeLessThan(sold);
  });
});

describe("v3a quotes: the research agent states what it accepts; the payer chooses; no default currency anywhere", () => {
  it("refuses a quote without its accepted currencies, and an acceptance without a choice of how to pay", async () => {
    const { w } = v3aWorld("v3a-quote");
    const need = w.needs.find((n) => n.agent === "DEMAND-1") as NonNullable<World["needs"][number]>;
    expect((await w.act("RESEARCH-1", { tool: "post_quote", need: need.id, tasks: need.tasks, priceMicroSiu: 500_000n }, "r")).note).toBe(
      `${need.id}: say which currencies you accept: usdc, agu or both`,
    );
    await w.act("RESEARCH-1", { tool: "post_quote", need: need.id, tasks: need.tasks, priceMicroSiu: 500_000n, accepts: "usdc" }, "r");
    const q = w.quotes.at(-1)?.id as string;
    expect((await w.act("DEMAND-1", { tool: "accept_quote", quote: q }, "r")).note).toBe(`${q}: say how you pay: usdc, agu or claims`);
    expect((await w.act("DEMAND-1", { tool: "accept_quote", quote: q, pay: "agu" }, "r")).note).toBe(`${q}: RESEARCH-1 accepts usdc on this quote (or work claims)`);
    const ok = await w.act("DEMAND-1", { tool: "accept_quote", quote: q, pay: "usdc" }, "r");
    expect(ok.ok, ok.note).toBe(true);
    expect(w.log.entries.find((e) => e.kind === "payment" && e.ref === q)).toMatchObject({ currency: "usdc", payeeAcceptsBoth: false });
  });

  it("an SIU-priced quote paid in USDC converts at the print when it was posted", async () => {
    const { w } = v3aWorld("v3a-quote-usdc");
    const need = w.needs.find((n) => n.agent === "DEMAND-2") as NonNullable<World["needs"][number]>;
    await w.act("RESEARCH-2", { tool: "post_quote", need: need.id, tasks: need.tasks, priceMicroSiu: 400_000n, accepts: "both" }, "r");
    const q = w.quotes.at(-1);
    const usdc = w.chain.balance("DEMAND-2", "USDC");
    await w.act("DEMAND-2", { tool: "accept_quote", quote: q?.id as string, pay: "usdc" }, "r");
    expect(usdc - w.chain.balance("DEMAND-2", "USDC")).toBe((400_000n * (q?.rateAtPost as bigint) + 999_999_999n) / 1_000_000_000n);
  });
});

describe("v3a commissions and data: currency always named; the refund rule is the owner's switch", () => {
  it("refuses a commission or a dataset with no currency named", async () => {
    const { w } = v3aWorld("v3a-pay-named");
    expect((await w.act("RESEARCH-1", { tool: "commission_task", tasks: ["CR-UO"], issuer: "ISSUER-C1" }, "r")).note).toBe("say which currency pays: usdc or agu");
    expect((await w.act("RESEARCH-1", { tool: "buy_data", dataset: "tokens" }, "r")).note).toBe("say which currency pays: usdc or agu");
  });

  it("prices a dataset at about one task's value in mSIU, and buys a commission's first dataset in the commission's own currency", async () => {
    const { w } = v3aWorld("v3a-data");
    const agu = w.chain.balance("RESEARCH-1", "AGU");
    await w.act("RESEARCH-1", { tool: "commission_task", tasks: ["CR-UO"], issuer: "ISSUER-C1", pay: "agu" }, "r");
    const data = w.log.entries.find((e) => e.kind === "data-purchase");
    expect(data?.payUnit).toBe("agu");
    expect(w.chain.balance("RESEARCH-1", "AGU")).toBeLessThan(agu);
    expect(w.log.entries.find((e) => e.kind === "payment" && e.what === "data")?.valueMicroSiu).toBe(148_000n);
  });

  it("refunds a failed task by default; with failedWorkPays the issuer is paid for it", async () => {
    for (const pays of [false, true]) {
      const { w, worker } = v3aWorld(`v3a-fail-${pays}`, {
        patch: (p) => {
          (p.v3a as NonNullable<EconomyParams["v3a"]>).failedWorkPays = pays;
        },
      });
      await w.act("RESEARCH-1", { tool: "buy_data", dataset: "tokens", pay: "usdc" }, "r");
      worker.queue.push(false);
      const usdc = w.chain.balance("RESEARCH-1", "USDC");
      await w.act("RESEARCH-1", { tool: "commission_task", tasks: ["CR-UO"], issuer: "ISSUER-C1", pay: "usdc" }, "r");
      expect(w.chain.balance("RESEARCH-1", "USDC") < usdc).toBe(pays);
    }
  });
});

describe("v3a AGU-lab: the roll in either currency, creation and redemption in kind with minimum sizes", () => {
  it("fills a front-claim order paid in AGU-lab at mid: no spread, no buy-back cap, never an exit", async () => {
    const { w, needsFor } = v3aWorld("v3a-roll-agu");
    const o = await w.act("DEMAND-1", { tool: "order_front_claim", task: "CR-PL", milli: 301n, pay: "agu" }, "r");
    expect(o.ok, o.note).toBe(true);
    const agu = w.chain.balance("DEMAND-1", "AGU");
    const usdc = w.chain.balance("DEMAND-1", "USDC");
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    expect(w.log.entries.some((e) => e.kind === "roll-sale" && e.to === "DEMAND-1")).toBe(true);
    expect(w.chain.balance("DEMAND-1", "AGU")).toBeLessThan(agu);
    expect(w.chain.balance("DEMAND-1", "USDC")).toBe(usdc); // the AGU-lab paid; the USDC the roll settles in passed straight through
    expect(w.log.entries.filter((e) => e.kind === "exit")).toEqual([]);
    expect(w.log.entries.find((e) => e.kind === "participant-buyback" && e.from === "DEMAND-1")?.atMid).toBe(true);
    expect(w.log.entries.find((e) => e.kind === "payment" && e.what === "front claims")).toMatchObject({ currency: "agu", payeeAcceptsBoth: true });
  });

  it("redeems only above the minimum size, and creates AGU-lab in kind from a Commodity claim at NAV", async () => {
    const { w } = v3aWorld("v3a-create");
    expect((await w.act("DEMAND-2", { tool: "redeem_agu", valueMilli: 100n }, "r")).note).toMatch(/redeem at least 250 mSIU/);
    const red = await w.act("DEMAND-2", { tool: "redeem_agu", valueMilli: 1_000n }, "r");
    expect(red.ok, red.note).toBe(true);
    // create with one of the far-window claims just redeemed (enough tenor left)
    const held = boardFor(w, "DEMAND-2").v3a?.claims.filter((c) => c.window === 3).sort((a, b) => (a.milli > b.milli ? -1 : 1))[0];
    expect(held).toBeDefined();
    const agu = w.chain.balance("DEMAND-2", "AGU");
    const small = await w.act("DEMAND-2", { tool: "create_agu", claim: held?.claim as string, milli: 100n }, "r");
    expect(small.note).toMatch(/create with at least 250 mSIU/);
    w.mint(PARTICIPANT, 0n);
    if ((held?.milli ?? 0n) >= 250n) {
      const c = await w.act("DEMAND-2", { tool: "create_agu", claim: held?.claim as string, milli: 250n }, "r");
      expect(c.ok, c.note).toBe(true);
      expect(w.chain.balance("DEMAND-2", "AGU")).toBeGreaterThan(agu);
    }
    w.checkInvariants();
  });
});

describe("v3a sweeps: the owner's fixed dollar demand at the end of windows 4 and 8 (D143)", () => {
  it("takes the stated amount in USDC; if USDC is short, AGU-lab is sold at the bid, logged as forced", async () => {
    const { w, needsFor } = v3aWorld("v3a-sweep");
    const demand = w.v3aSweepMicroUsd("DEMAND-1") as bigint;
    expect(demand).toBe(((w.v3a?.startValueMicroUsd.get("DEMAND-1") as bigint) * 1_500n) / 10_000n);
    expect(renderBoard(boardFor(w, "DEMAND-1"))).toMatch(new RegExp(`Your owner takes ${demand.toLocaleString("en-US")} µ\\$ in USDC at the end of windows 4 and 8`));
    w.chain.transfer("USDC", "DEMAND-1", "OWNER-X", w.chain.balance("DEMAND-1", "USDC") - 1_000n); // leave too little USDC
    for (let k = 1; k <= 4; k++) {
      if (k > 1) w.startWindow(k, needsFor);
      w.closeWindow(k);
    }
    const s = w.log.entries.find((e) => e.kind === "sweep" && e.actor === "DEMAND-1");
    expect(s?.demanded).toBe(demand);
    expect(s?.usdc).toBe(demand);
    expect((s?.forcedAgu as bigint) > 0n).toBe(true);
    const forced = w.log.entries.filter((e) => e.kind === "payment" && e.actor === "DEMAND-1" && e.forced === true);
    expect(forced.map((e) => e.what).sort()).toEqual(["sweep", "sweep conversion"]);
    w.checkInvariants();
  });
});

describe("v3a needs, arm B and the deferred-payment opportunities", () => {
  it("shows a demand agent its needs three windows ahead, each with its work in mSIU and its value at today's print", () => {
    const { w } = v3aWorld("v3a-needs");
    const b = boardFor(w, "DEMAND-1").v3a;
    expect(b?.needsAhead.map((n) => n.window)).toEqual([1, 2, 3, 4]);
    for (const n of b?.needsAhead ?? []) expect(n.workMicroSiu).toBe(w.workMicroSiu(n.tasks));
  });

  it("under arm B, checks and logs the owner's rule at each close without forcing any trade", () => {
    const { w } = v3aWorld("v3a-armb", { arm: "B" });
    const agu = w.chain.balance("DEMAND-1", "AGU");
    w.closeWindow(1);
    const checks = w.log.entries.filter((e) => e.kind === "rule-check");
    expect(checks.map((e) => e.actor).sort()).toEqual(["DEMAND-1", "DEMAND-2", "DEMAND-3", "DEMAND-4", "HEDGER"]);
    const d1 = checks.find((e) => e.actor === "DEMAND-1");
    expect(d1?.requiredMicroSiu).toBe((w.knownNeedsMicroSiu("DEMAND-1", 1, 3) * 5_000n) / 10_000n);
    expect(w.chain.balance("DEMAND-1", "AGU")).toBe(agu);
    expect(renderBoard(boardFor(w, "DEMAND-1"))).toMatch(/Your owner's rule: at each window close/);
    const a = v3aWorld("v3a-arma", { arm: "A" });
    a.w.closeWindow(1);
    expect(a.w.log.entries.filter((e) => e.kind === "rule-check")).toEqual([]);
    expect(renderBoard(boardFor(a.w, "DEMAND-1"))).not.toMatch(/owner's rule/);
  });

  it("logs a worthwhile opportunity when a posted forward price beats today's print less the claims record's loss rate", async () => {
    const { w } = v3aWorld("v3a-opps");
    // window 3: two windows out, beyond the roll (which sells only the next window), so the offer is the only forward price
    const next = [...new Set(w.needsForFn?.("DEMAND-1", 3) ?? [])][0] as TaskId;
    const posted = await w.act("PROVIDER", { tool: "post_offer", issuer: "ISSUER-X", task: next, window: 3, milli: 400n, discountBps: 500n, accept: "both", to: "all" }, "r");
    expect(posted.ok, posted.note).toBe(true);
    w.setTime(1, 1);
    w.logOpportunities();
    const o = w.log.entries.find((e) => e.kind === "opportunity" && e.actor === "DEMAND-1" && e.forWindow === 3 && e.task === next);
    expect(o?.worthwhile).toBe(true);
    expect(o?.forwardNanoPerSiu).toBe((w.commodityRate * 9_500n) / 10_000n);
  });
});

describe("v3a tools and instructions", () => {
  it("gives PROVIDER its offer tools and buyers request_claims/buy_offer, never buy_claims; amounts are whole numbers", () => {
    expect(toolDefsForRole("provider", "v3a").map((d) => d.name)).toEqual(
      expect.arrayContaining(["post_offer", "withdraw_offer", "decline_request"]),
    );
    for (const role of ["research", "demand", "hedger"] as const) {
      const names = toolDefsForRole(role, "v3a").map((d) => d.name);
      expect(names).toEqual(expect.arrayContaining(["request_claims", "buy_offer", "create_agu"]));
      expect(names).not.toContain("buy_claims");
    }
    const ok = parseToolCall({ tool: "buy_agu", args: { reasoning: "r", msiu: "250" } }, "demand", undefined, "v3a");
    expect(ok.ok && ok.action.tool === "buy_agu" && ok.action.valueMilli).toBe(250n);
    expect(parseToolCall({ tool: "buy_agu", args: { reasoning: "r", msiu: "0.25" } }, "demand", undefined, "v3a").ok).toBe(false);
    expect(parseToolCall({ tool: "commission_task", args: { reasoning: "r", tasks: ["CR-UO"], issuer: "ISSUER-C1" } }, "research", undefined, "v3a").ok).toBe(false);
    const neg = parseToolCall(
      { tool: "post_offer", args: { reasoning: "r", issuer: "ISSUER-C1", task: "CR-PL", window: 2, msiu: "301", discount_bps: -500, accept: "both", to: "all" } },
      "provider",
      undefined,
      "v3a",
    );
    expect(neg.ok && neg.action.tool === "post_offer" && neg.action.discountBps).toBe(-500n);
  });

  it("never tells an agent which way to pay, names both currencies in one sentence, and follows the display order", () => {
    for (const role of ["demand", "research", "hedger", "provider"] as const) {
      const text = instructionsForV3a(role);
      expect(text).not.toMatch(/\b(should|must|prefer|better|best)\b.*\b(AGU-lab|USDC)\b/i);
      expect(text).toMatch(/reasoning first/);
    }
    expect(instructionsForV3a("demand", true)).toMatch(/You hold two currencies, AGU-lab/);
    expect(instructionsForV3a("demand", false)).toMatch(/You hold two currencies, USDC and AGU-lab/);
    expect(instructionsForV3a("demand", true, true)).toMatch(/paid for whether it passes or fails/);
  });
});

describe("publishNav, v3a (D144, owner 2026-11-12): the NAV log carries the shadow NAV and the buffer's draw, never a NAV that includes the buffer", () => {
  it("logs the shadow NAV as the reserve NAV times the shadow ratio, and this window's draw", () => {
    const { w } = v3aWorld("v3a-nav-shadow");
    const e = w.log.entries.filter((x) => x.kind === "nav").at(-1) as LogEntry;
    const roll = w.log.entries.find((x) => x.kind === "roll-buy" && x.summary === true && x.refused === undefined) as LogEntry;
    expect(e.navWithBuffer).toBeUndefined();
    expect(e.subsidyThisWindowUsdc).toBe(roll.cover);
    expect(Number(e.shadowNav)).toBeCloseTo((Number(e.reserveNav) * Number(roll.shadowRatioPpm as bigint)) / 1e6, 6);
    expect(Number(e.shadowNav)).toBeLessThan(Number(e.reserveNav));
  });
});

describe("D144: PROVIDER's discount history in the claims record; holdings valued at NAV and at the shadow NAV", () => {
  it("shows every discount PROVIDER posted for an issuer and window, revised and withdrawn ones included", async () => {
    const { w } = v3aWorld("v3a-discounts");
    const post = (discountBps: bigint, replaces?: string) =>
      w.act("PROVIDER", { tool: "post_offer", issuer: "ISSUER-X", task: "CR-UO", window: 2, milli: 200n, discountBps, accept: "both", to: "all", ...(replaces !== undefined ? { replaces } : {}) }, "r");
    await post(1_500n);
    await post(1_200n, w.v3a?.offers[0]?.id);
    await w.act("PROVIDER", { tool: "withdraw_offer", offer: w.v3a?.offers[1]?.id as string }, "r");
    const row = boardFor(w, "DEMAND-1").v3a?.record.find((r) => r.issuer === "ISSUER-X" && r.window === 2);
    expect(row?.discounts.map((d) => [d.task, d.discountBps, d.status])).toEqual([
      ["CR-UO", 1_500n, "replaced"],
      ["CR-UO", 1_200n, "withdrawn"],
    ]);
    expect(renderBoard(boardFor(w, "DEMAND-1"))).toMatch(/ISSUER-X window 2: .*PROVIDER posted CR-UO 15% off \(replaced\), CR-UO 12% off \(withdrawn\)/);
  });

  it("logs each agent's AGU-lab at NAV and at the shadow NAV (no buffer support), and both work shares -- never a NAV that includes the buffer", () => {
    const { w } = v3aWorld("v3a-hold-shadow");
    w.closeWindow(1);
    const h = w.log.entries.find((e) => e.kind === "holdings" && e.atClose === 1 && e.actor === "DEMAND-1") as LogEntry;
    expect((h.aguMicroSiuShadow as bigint) <= (h.aguMicroSiu as bigint)).toBe(true);
    expect(h.workShareBpsShadow).toBeDefined();
    expect(h.aguMicroSiuWithBuffer).toBeUndefined();
    expect(h.workShareBpsWithBuffer).toBeUndefined();
  });
});

describe("D144 (owner, 2026-11-12): the board shows the buffer's draw and a shadow NAV, never a NAV that includes the buffer", () => {
  it("a roll the buffer covers lowers the shadow NAV by the share of the reserve the buffer bought back; the board shows it, the buffer left and this window's draw", () => {
    const { w } = v3aWorld("v3a-shadow");
    const roll = w.log.entries.find((e) => e.kind === "roll-buy" && e.summary === true && e.refused === undefined) as LogEntry;
    const cover = roll.cover as bigint;
    expect(cover > 0n).toBe(true); // window 1's front lots go unsold: the buffer pays
    const coverMilli = (cover * 1_000_000n) / w.commodityRate;
    // without the buffer the roll would have bought coverMilli less face: the shadow face is the face after the roll less that, as a share of it
    const after = roll.faceAfterMilli as bigint;
    expect(roll.shadowRatioPpm).toBe((1_000_000n * (after - coverMilli)) / after);
    const b = boardFor(w, "DEMAND-1").v3a?.nav;
    expect(b?.subsidyThisWindowUsdc).toBe(cover); // D146: the lab subsidy pays what the buffer did
    expect((b?.shadowNavMicroSiuPerAgu as bigint) < (b?.navMicroSiuPerAgu as bigint)).toBe(true);
    expect(b).not.toHaveProperty("navWithBufferMicroSiuPerAgu");
    const text = renderBoard(boardFor(w, "DEMAND-1"));
    expect(text).toMatch(/shadow NAV/);
    expect(text).toMatch(/\(-?[\d,]+ (µ\$|mSIU) \(≈ [\d,]+ (µ\$|mSIU)\) at this window's roll\)/);
    expect(text).not.toMatch(/with the buffer/i);
  });
});

describe("v3a sweeps convert claims too when USDC and AGU-lab fall short (the design, as updated with D144)", () => {
  it("sells the agent's soonest-expiring claims to the participant at its bid on the grade print, logged as forced", async () => {
    const { w, needsFor } = v3aWorld("v3a-sweep-claims");
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    // a window-5 claim (three windows ahead, PROVIDER's limit): still live at window 4's close, when the sweep runs; window-4 claims have settled or lapsed by then
    const posted = await w.act("PROVIDER", { tool: "post_offer", issuer: "ISSUER-C1", task: "CR-PL", window: 5, milli: 800n, discountBps: 0n, accept: "both", to: "all" }, "r");
    expect(posted.ok).toBe(true);
    const bought = await w.act("DEMAND-2", { tool: "buy_offer", offer: w.v3a?.offers.at(-1)?.id as string, milli: 600n, pay: "usdc" }, "r");
    expect(bought.ok).toBe(true);
    const claim = w.log.entries.find((e) => e.kind === "claim-mint" && e.actor === "DEMAND-2")?.tokenId as string;
    w.closeWindow(2);
    w.startWindow(3, needsFor);
    w.closeWindow(3);
    w.startWindow(4, needsFor);
    // leave DEMAND-2 nothing but that claim and a little USDC
    w.chain.transfer("USDC", "DEMAND-2", "OWNER-X", w.chain.balance("DEMAND-2", "USDC") - 1_000n);
    w.chain.transfer("AGU", "DEMAND-2", "OWNER-X", w.chain.balance("DEMAND-2", "AGU"));
    w.closeWindow(4);
    const s = w.log.entries.find((e) => e.kind === "sweep" && e.actor === "DEMAND-2");
    expect((s?.forcedClaimsMilli as bigint) > 0n).toBe(true);
    expect(w.chain.claimBalance(PARTICIPANT, claim) > 0n).toBe(true);
    expect(w.log.entries.some((e) => e.kind === "payment" && e.actor === "DEMAND-2" && e.what === "sweep conversion" && e.currency === "claims" && e.forced === true)).toBe(true);
    // the rule is on the agent's board
    expect(renderBoard(boardFor(w, "DEMAND-2"))).toMatch(/your work claims too, soonest-expiring first, at the same bid/);
    w.checkInvariants();
  });
});

describe("D145 (owner, 2026-11-12): pooled direct mint, capacity sized for the largest reserve, and v6's issuance limit as a validity gate", () => {
  const RESERVE_ISSUERS = ["ISSUER-C1", "ISSUER-C2", "ISSUER-X"];
  /** the CR-PL face the window-k roll retires and must place again */
  const frontPl = (w: World, k: number): bigint =>
    w.chain.reserveLots
      .filter((id) => w.chain.claimTypes.get(id)?.classId === "CR-PL" && w.chain.claimTypes.get(id)?.windowFrom === w.windowFrom(k))
      .reduce((n, id) => n + w.chain.claimBalance("reserve", id), 0n);
  /** consume each reserve issuer's CR-PL headroom down to `left`, with a live claim held outside the reserve (after a close: expiries at a close free headroom) */
  function leaveHeadroom(w: World, left: bigint): void {
    for (const id of RESERVE_ISSUERS) {
      const h = w.chain.headroom(id, "CR-PL");
      if (h > left)
        w.chain.mint("OWNER-X", "CR-PL", "commodity", h - left, w.windowFrom(6), w.windowTo(6), w.commodityRate, { issuer: id, prepaid: true, tag: "fill" });
    }
  }

  it("bonds each reserve-grade issuer's lots at the configured committed capacity hours (v6: capacity = hours × measured rate); the Frontier issuer's stay at one", () => {
    const { w } = v3aWorld("v3a-capacity");
    const hours = w.params.v3a?.capacityHours as bigint;
    expect(hours > 1n).toBe(true);
    for (const id of RESERVE_ISSUERS) for (const c of ["CR-PL", "CR-UO", "CR-SM"]) expect(w.chain.bondLots.get(`${id}|${c}`)?.committedCapacityHours).toBe(hours);
    expect(w.chain.bondLots.get("ISSUER-F|CR-VS")?.committedCapacityHours).toBe(1n);
    // the NAV log carries each reserve class's live issuance, its peak so far, and the issuers' total limit
    const nav = w.log.entries.filter((e) => e.kind === "nav").at(-1) as LogEntry;
    const pl = (nav.issuance as Record<string, { issued: bigint; peak: bigint; limit: bigint }>)["CR-PL"];
    expect(pl?.limit).toBe(RESERVE_ISSUERS.reduce((n, id) => n + w.chain.headroom(id, "CR-PL"), 0n) + (pl?.issued ?? 0n));
    expect((pl?.peak as bigint) >= (pl?.issued as bigint)).toBe(true);
  });

  it("splits the roll's lot across issuers when none can take it whole; the ladder creation after it finds too little left and logs the limit binding", () => {
    const { w, needsFor } = v3aWorld("v3a-pooled");
    w.closeWindow(1);
    const lot = frontPl(w, 2);
    const left = (lot * 2n) / 5n + 1n; // C1 and C2 each hold a little over two fifths of the lot, X the rest: none can take it whole, together they can
    leaveHeadroom(w, left);
    w.startWindow(2, needsFor);
    const lots = w.log.entries.filter((e) => e.kind === "roll-buy" && e.summary !== true && e.task === "CR-PL" && e.window === w.log.entries.at(-1)?.window);
    expect(lots.map((e) => [e.issuer, e.milli])).toEqual([
      ["ISSUER-C1", left],
      ["ISSUER-C2", left],
      ["ISSUER-X", lot - 2n * left],
    ]);
    // the ladder creation after the roll wants a window's 1,000 mSIU of CR-PL and finds only X's remainder
    const bound = w.log.entries.filter((e) => e.kind === "issuance-limit");
    expect(bound.map((e) => [e.what, e.task, e.wanted, e.placed])).toEqual([["ladder creation", "CR-PL", 1_000n, 3n * left - lot]]);
    expect(checkGates(w.log.entries, w.params).find((g) => g.name.startsWith("v6's issuance limit"))?.ok).toBe(false);
    w.checkInvariants();
  });

  it("logs the limit binding when even the issuers' total headroom cannot take the roll's lot, and the run fails the gate", () => {
    const { w, needsFor } = v3aWorld("v3a-bound");
    w.closeWindow(1);
    const lot = frontPl(w, 2);
    const left = (lot * 3n) / 10n; // three issuers with three tenths each: nine tenths of the lot in all
    leaveHeadroom(w, left);
    w.startWindow(2, needsFor);
    const roll = w.log.entries.find((e) => e.kind === "issuance-limit" && e.what === "roll") as LogEntry;
    expect(String(roll.refused)).toBe(`NoTotalHeadroom(CR-PL, ${lot}, ${3n * left})`);
    expect(checkGates(w.log.entries, w.params).find((g) => g.name.startsWith("v6's issuance limit"))?.ok).toBe(false);
    w.checkInvariants();
  });
});

describe("D145 amended (owner, 2026-11-12): pooled direct mint ranks issuers by delivery ratio", () => {
  it("ranks issuers by trailing delivery ratio, highest first; issuers with no deliveries yet come after, in registration order", () => {
    const { w } = v3aWorld("v3a-rank");
    expect(w.deliveryRank()).toEqual(["ISSUER-C1", "ISSUER-C2", "ISSUER-X", "ISSUER-F"]); // nothing delivered yet: registration order
    w.delivery.set("ISSUER-C1", [{ presented: 10, served: 9 }]);
    w.delivery.set("ISSUER-C2", [{ presented: 10, served: 10 }]);
    w.delivery.set("ISSUER-X", [{ presented: 10, served: 8 }]);
    expect(w.deliveryRank()).toEqual(["ISSUER-C2", "ISSUER-C1", "ISSUER-X", "ISSUER-F"]);
  });

  it("the roll splits a lot in rank order, so X takes part of a lot only when the others cannot carry it", () => {
    const { w, needsFor } = v3aWorld("v3a-rank-split");
    w.closeWindow(1);
    w.delivery.set("ISSUER-C1", [{ presented: 10, served: 9 }]);
    w.delivery.set("ISSUER-C2", [{ presented: 10, served: 10 }]);
    w.delivery.set("ISSUER-X", [{ presented: 10, served: 8 }]);
    const lot = w.chain.reserveLots
      .filter((id) => w.chain.claimTypes.get(id)?.classId === "CR-PL" && w.chain.claimTypes.get(id)?.windowFrom === w.windowFrom(2))
      .reduce((n, id) => n + w.chain.claimBalance("reserve", id), 0n);
    const left = (lot * 2n) / 5n + 1n;
    for (const id of ["ISSUER-C1", "ISSUER-C2", "ISSUER-X"]) {
      const h = w.chain.headroom(id, "CR-PL");
      if (h > left) w.chain.mint("OWNER-X", "CR-PL", "commodity", h - left, w.windowFrom(6), w.windowTo(6), w.commodityRate, { issuer: id, prepaid: true, tag: "fill" });
    }
    w.startWindow(2, needsFor);
    const lots = w.log.entries.filter((e) => e.kind === "roll-buy" && e.summary !== true && e.task === "CR-PL" && e.window === w.log.entries.at(-1)?.window);
    expect(lots.map((e) => [e.issuer, e.milli])).toEqual([
      ["ISSUER-C2", left],
      ["ISSUER-C1", left],
      ["ISSUER-X", lot - 2n * left],
    ]);
  });
});

describe("D146 (owner, 2026-11-12): the SIU's definition, the unmet-need penalty, units everywhere, and the lab subsidy", () => {
  it("defines the SIU as a fixed unit of AI work in every role's instructions, never as one correct answer per task type", () => {
    for (const siuFirst of [true, false])
      for (const role of ["demand", "research", "hedger", "provider"] as Role[]) {
        const t = instructionsForV3a(role, siuFirst);
        expect(t).not.toMatch(/correct answer/);
        expect(t).toContain("An SIU is a fixed unit of AI work; each task type's work in mSIU is shown on your board.");
      }
  });

  it("charges a need that lapses unmet three times its work, and shows that beside each need with its work content", () => {
    const { w } = v3aWorld("v3a-unmet");
    const need = w.needs.find((n) => n.agent === "DEMAND-1" && n.window === 1) as (typeof w.needs)[number];
    const work = w.workMicroSiu([...new Set(need.tasks)]);
    const text = renderBoard(boardFor(w, "DEMAND-1"));
    const line = text.split("\n").find((l) => l.includes("window 1 (now)")) as string;
    // the window decides which unit comes first; both are there either way
    expect(line).toMatch(new RegExp(`work content [^;]*\\b${(work / 1_000n).toLocaleString("en-US")} mSIU[^;]*, before research costs such as data`));
    expect(line).toMatch(new RegExp(`if unmet at the window's end, [^;]*\\b${((3n * work) / 1_000n).toLocaleString("en-US")} mSIU`));
    w.closeWindow(1);
    const lapsed = w.log.entries.find((e) => e.kind === "need-lapsed" && e.need === need.id) as LogEntry;
    expect(lapsed.costMicroSiu).toBe(3n * work);
    expect(w.objective.get("DEMAND-1")?.unmetMicroSiu).toBe(3n * work);
  });

  it("no board, tool result, notice or running result of a full scripted run shows a decimal or USDC-denominated amount; every amount in a result or notice has the other unit beside it", async () => {
    const { w, needsFor, params } = v3aWorld("v3a-units", { arm: "B", worker: "stand-in", start: false });
    const boards: string[] = [];
    const agents: Agent[] = ids(params).map(([id, role]) => {
      const inner = new ScriptedV3aAgent(id, role);
      return { id, role, seat: "scripted", reply: (b: Parameters<Agent["reply"]>[0]) => (boards.push(renderBoard(b)), inner.reply(b)) } as unknown as Agent;
    });
    await runWindows({ world: w, agents, windows: [1, 2, 3, 4, 5, 6, 7, 8], needsFor, instructions: (role, siuFirst) => instructionsForV3a(role as Role, siuFirst) });
    const notes = w.log.entries.filter((e) => e.kind === "turn" && typeof e.note === "string").map((e) => String(e.note));
    // the messages the engine writes ("Since your last turn"), the last tool result, the running result, and the board's lists of offers, requests and claims
    const notices = boards.flatMap((b) => {
      const lines = b.split("\n");
      const since = lines.indexOf("Since your last turn:");
      const msgs = since < 0 ? [] : lines.slice(since + 1).filter((l, i, all) => l.startsWith("  - ") && all.slice(0, i).every((x) => x.startsWith("  - ")));
      return [...msgs, ...lines.filter((l) => /^(Your last action:|Your running result:| {2}- (offer-|request-|[0-9a-f]{16}: ))/.test(l))];
    });
    const decimal = /\d+\.\d+\s*(USDC|AGU-lab|SIU)\b|\d\s*USDC\b|\$\s?\d/;
    const badBoards = boards.flatMap((b) => b.split("\n")).filter((l) => decimal.test(l));
    expect([...new Set(badBoards)].slice(0, 5)).toEqual([]);
    expect([...new Set(notes.filter((n) => decimal.test(n)))].slice(0, 5)).toEqual([]);
    // every amount in a tool result, notice or running result is a pair: one board unit, then the other unit's value beside it
    const pair = /-?[\d,]+ (mSIU|µ\$)[^(]{0,40}\(≈ -?[\d,]+ (mSIU|µ\$)\)/g;
    // a price rate ("N µ$ per SIU") is not an amount
    const unpaired = [...notes, ...notices].map((t) => t.replace(pair, "")).filter((t) => /\d[\d,]* (mSIU|µ\$)(?! per SIU)/.test(t));
    expect([...new Set(unpaired)].slice(0, 8)).toEqual([]);
  }, 60_000);

  it("replaces the buffer with an open-ended lab subsidy: every roll restores its face, the board shows what the lab has paid, and NAV never shows the buffer", () => {
    const { w, needsFor } = v3aWorld("v3a-subsidy");
    for (let k = 2; k <= 8; k++) {
      w.closeWindow(k - 1);
      w.startWindow(k, needsFor);
    }
    const rolls = w.log.entries.filter((e) => e.kind === "roll-buy" && e.summary === true);
    expect(rolls.length).toBe(8);
    expect(rolls.every((e) => e.refused === undefined && e.faceBought === (e.faceSold as bigint) + (e.faceUnsold as bigint))).toBe(true);
    const paid = rolls.reduce((n, e) => n + (e.cover as bigint), 0n);
    expect(paid > 0n).toBe(true);
    // the lab funds exactly what the rolls draw, and no buffer is ever held between rolls
    expect(w.log.entries.filter((e) => e.kind === "lab-subsidy").reduce((n, e) => n + (e.usdc as bigint), 0n)).toBe(paid);
    expect(w.chain.balance("buffer", "USDC")).toBe(0n);
    expect(w.subsidyPaid).toBe(paid);
    const nav = w.log.entries.filter((e) => e.kind === "nav").at(-1) as LogEntry;
    expect(nav.subsidyPaidUsdc).toBe(paid);
    const text = renderBoard(boardFor(w, "DEMAND-1"));
    expect(text).toMatch(/lab subsidy[^.]*has paid ([\d,]+ µ\$ \(≈ [\d,]+ mSIU\)|[\d,]+ mSIU \(≈ [\d,]+ µ\$\)) so far/);
    expect(text).toMatch(/shadow NAV/);
    expect(text).not.toMatch(/buffer/i);
    expect(checkGates(w.log.entries, w.params).some((g) => g.name.startsWith("the buffer"))).toBe(false);
    w.checkInvariants();
  });
});

describe("D146 minor: the dev verdict's NAV check names what a v3a run publishes", () => {
  it("passes a v3a run on NAV published with the shadow NAV, under a label that no longer speaks of the buffer", () => {
    const { w } = v3aWorld("v3a-dev-label");
    const check = judgeDevWindows(w, []).checks.find((c) => c.name.startsWith("NAV published"));
    expect(check?.name).toBe("NAV published every window (v3a: with the shadow NAV; v2: with and without the buffer)");
    expect(check?.ok).toBe(true);
  });
});
