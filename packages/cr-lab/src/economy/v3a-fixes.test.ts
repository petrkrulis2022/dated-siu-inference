/**
 * Phase 2 of the v3a build (docs/experiment-3a-design.md; the code check's confirmed bugs, docs/v2-code-check.md): one describe block per fix, each written BEFORE its fix
 * and run against the unfixed engine first, so every test here is one that failed before its fix and passes after (the owner's rule for this build).
 *
 * The world here is built from the frozen v2 parameters, loaded explicitly (never `loadParams()`'s silent v1 default), with a task worker whose pass or fail the test sets,
 * so a brief's outcome is the test's own choice, never a seeded draw.
 */
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import { CR_PUBLIC_DIR } from "../paths.js";
import { TASKS, type TaskId } from "../tasks/instances.js";
import type { Agent } from "./agents.js";
import { boardFor, renderBoard } from "./board.js";
import { EconomyLog, type LogEntry } from "./log.js";
import { loadParams, type EconomyParams, type IssuerParams } from "./params.js";
import { parseToolCall } from "./parse.js";
import { judgeDevWindows } from "./report.js";
import {
  buildWorld,
  loadCrPrint,
  needsSchedule,
  runWindows,
  standInSha,
  StopRule,
  type WindowStats,
} from "./runner.js";
import type { Need, Quote, TaskWorker, WorkOutcome, World } from "./world.js";

const V2 = join(CR_PUBLIC_DIR, "economy-params.v2.json");
const T0 = 1_799_971_200;
const BRIEF_TASKS = TASKS.filter((t): t is TaskId => t !== "CR-VS");

/** passes every task unless the test queued an outcome, always on the window's own snapshot hash */
class SetWorker implements TaskWorker {
  readonly queue: boolean[] = [];
  constructor(readonly sha: (k: number) => string) {}
  work(_i: IssuerParams, _t: TaskId, ctx: { window: number }): Promise<WorkOutcome> {
    const passed = this.queue.length > 0 ? (this.queue.shift() as boolean) : true;
    return Promise.resolve({ passed, costUsd: new D(0), dataSha: this.sha(ctx.window) });
  }
}

function world(
  seed: string,
  opts: { patch?: (p: EconomyParams) => void; windowCount?: number; start?: boolean } = {},
) {
  const params = { ...loadParams(V2), seed };
  opts.patch?.(params);
  const wp0 = loadCrPrint();
  const sha = standInSha(seed);
  const worker = new SetWorker(sha);
  const w = buildWorld({
    params,
    wp0,
    log: new EconomyLog("stand-in"),
    worker,
    t0: T0,
    dataSha: sha,
    windowCount: opts.windowCount,
  });
  w.genesis();
  const needsFor = needsSchedule(seed, BRIEF_TASKS);
  if (opts.start !== false) w.startWindow(1, needsFor);
  return { w, worker, needsFor };
}

const openNeed = (w: World, agent: string): Need =>
  w.needs.find((n) => n.agent === agent && n.window === w.window && n.status === "open") as Need;

function pushOutputs(w: World, owner: string, tasks: readonly TaskId[], passed: boolean): void {
  for (const t of tasks)
    w.outputs.push({
      id: `out-${owner}-${t}-${w.outputs.length}`,
      owner,
      task: t,
      passed,
      dataSha: w.dataSha(w.window),
      issuer: "ISSUER-C1",
      window: w.window,
      used: false,
    });
}

/** RESEARCH-1 quotes DEMAND-1's open need in USDC; DEMAND-1 (funded) accepts */
async function acceptedUsdcQuote(w: World, price = 1_500n): Promise<{ q: Quote; need: Need }> {
  const need = openNeed(w, "DEMAND-1");
  w.mint("DEMAND-1", 10_000_000n);
  const posted = await w.act(
    "RESEARCH-1",
    { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: price },
    "r",
  );
  expect(posted.ok, posted.note).toBe(true);
  const q = w.quotes.at(-1) as Quote;
  const acc = await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r");
  expect(acc.ok, acc.note).toBe(true);
  return { q, need };
}

const stats = (over: Partial<WindowStats> = {}): WindowStats => ({
  window: 1,
  turns: 48,
  parseFailures: 0,
  serviceFailures: 0,
  flagged: [],
  mirrors: [],
  agentCostUsd: new D(0),
  workCostUsd: new D(0),
  ...over,
});

// ---- item 1 -------------------------------------------------------------------------------------------------------------------------------------------
describe("Phase 2 item 1: settled quotes leave the board, escrow fields clear, every refusal names the quote and the reason", () => {
  it("a paid quote leaves both parties' boards, and its escrow fields are cleared on settlement", async () => {
    const { w } = world("p2-board-paid");
    const { q, need } = await acceptedUsdcQuote(w);
    expect(boardFor(w, "DEMAND-1").quotes.map((x) => x.id)).toContain(q.id); // live while accepted
    pushOutputs(w, "RESEARCH-1", need.tasks, true);
    const d = await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r");
    expect(d.ok, d.note).toBe(true);
    expect(q.status).toBe("delivered");
    expect(q.usdcEscrowed).toBeUndefined();
    expect(q.agu).toBeUndefined();
    expect(q.escrow).toBeUndefined();
    for (const a of ["DEMAND-1", "RESEARCH-1"]) {
      const b = boardFor(w, a);
      expect(b.quotes.map((x) => x.id)).not.toContain(q.id);
      // the quote list itself: no line names it any more (the agent's own "Your last action" line still reports what its last action did, at the time it did it)
      const quoteLines = renderBoard(b)
        .split("\n")
        .filter((l) => l.startsWith("  - quote-"));
      expect(quoteLines.filter((l) => l.includes(q.id) || l.includes("in escrow"))).toEqual([]);
    }
    w.checkInvariants();
  });

  it("a failed, refunded brief's quote leaves the board too, its escrow fields cleared", async () => {
    const { w } = world("p2-board-failed");
    const { q, need } = await acceptedUsdcQuote(w);
    pushOutputs(w, "RESEARCH-1", need.tasks, false);
    await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r");
    expect(q.status).toBe("failed");
    expect(q.usdcEscrowed).toBeUndefined();
    expect(boardFor(w, "DEMAND-1").quotes.map((x) => x.id)).not.toContain(q.id);
  });

  it("accepting a quote already paid names the quote and the window it was paid in", async () => {
    const { w } = world("p2-refuse-paid");
    const { q, need } = await acceptedUsdcQuote(w);
    pushOutputs(w, "RESEARCH-1", need.tasks, true);
    await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r");
    const again = await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r");
    expect(again.ok).toBe(false);
    expect(again.note).toBe(`${q.id}: already paid in window 1`);
  });

  it("refusals for a refunded, lapsed, already-accepted, someone else's or unknown quote each name it and say why", async () => {
    const { w, needsFor } = world("p2-refuse-reasons");
    const { q } = await acceptedUsdcQuote(w);
    expect((await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r")).note).toMatch(
      new RegExp(`^${q.id}: already accepted, 0\\.001500 USDC in escrow$`),
    );
    expect((await w.act("DEMAND-2", { tool: "accept_quote", quote: q.id }, "r")).note).toBe(
      `${q.id}: offered to DEMAND-1, not to you`,
    );
    expect((await w.act("DEMAND-1", { tool: "accept_quote", quote: "quote-999" }, "r")).note).toBe(
      "quote-999: no such quote",
    );
    // a second quote for another need, never accepted: lapses at the window's end
    const need2 = openNeed(w, "DEMAND-2");
    await w.act(
      "RESEARCH-2",
      { tool: "post_quote", need: need2.id, tasks: need2.tasks, priceUsdcMicro: 1_500n },
      "r",
    );
    const unaccepted = w.quotes.at(-1) as Quote;
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    expect(
      (await w.act("DEMAND-2", { tool: "accept_quote", quote: unaccepted.id }, "r")).note,
    ).toBe(`${unaccepted.id}: lapsed at the end of window 1`);
    expect((await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r")).note).toBe(
      `${q.id}: lapsed at the end of window 1; its escrow was refunded to you`,
    );
  });

  it("a refused brief names the quote: not accepted yet, and already paid", async () => {
    const { w } = world("p2-refuse-deliver");
    const need = openNeed(w, "DEMAND-1");
    await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: 1_500n },
      "r",
    );
    const q = w.quotes.at(-1) as Quote;
    expect((await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r")).note).toBe(
      `${q.id}: not accepted yet by DEMAND-1`,
    );
    w.mint("DEMAND-1", 10_000_000n);
    await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r");
    expect((await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r")).note).toMatch(
      new RegExp(`^${q.id}: you have no CR-.. output from today`),
    );
    pushOutputs(w, "RESEARCH-1", need.tasks, true);
    await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r");
    expect((await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r")).note).toBe(
      `${q.id}: already paid in window 1`,
    );
  });

  it("the spend-cap refusal names the quote and states the total against the cap", async () => {
    const { w } = world("p2-refuse-cap", {
      patch: (p) => {
        p.mandates = {
          ...p.mandates,
          "DEMAND-1": {
            ...(p.mandates["DEMAND-1"] as EconomyParams["mandates"][string]),
            spendLimitAguPerWindow: 1n,
          },
        };
      },
    });
    const need = openNeed(w, "DEMAND-1");
    await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: 1_500n },
      "r",
    );
    const q = w.quotes.at(-1) as Quote;
    const r = await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(
      new RegExp(
        `^${q.id}: over spend cap: \\d+\\.\\d{6} of 0\\.000001 AGU-lab-equivalent this window`,
      ),
    );
  });

  it("a chain refusal on accept (the buyer's balance is short) names the quote too", async () => {
    const { w } = world("p2-refuse-chain", {
      patch: (p) => {
        p.mandates = {
          ...p.mandates,
          "DEMAND-1": {
            ...(p.mandates["DEMAND-1"] as EconomyParams["mandates"][string]),
            spendLimitAguPerWindow: 10n ** 15n,
          },
        };
      },
    });
    const need = openNeed(w, "DEMAND-1");
    const tooMuch = w.chain.balance("DEMAND-1", "USDC") + 1n;
    await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceUsdcMicro: tooMuch },
      "r",
    );
    const q = w.quotes.at(-1) as Quote;
    const r = await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(new RegExp(`^${q.id}: refused: `));
  });
});

// ---- item 2 -------------------------------------------------------------------------------------------------------------------------------------------
describe("Phase 2 item 2: the hedger's on time / late count is cumulative, and early deliveries bank", () => {
  async function deliverForward(w: World, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      pushOutputs(w, "HEDGER", ["CR-PL", "CR-UO"], true);
      const r = await w.act("HEDGER", { tool: "deliver_forward" }, "r");
      expect(r.ok, r.note).toBe(true);
    }
  }

  it("three briefs delivered in window 1 of 4 cover windows 1 to 3; only window 4's brief is late", async () => {
    const { w, needsFor } = world("p2-hedger-bank", {
      windowCount: 4,
      patch: (p) => {
        p.hedger = {
          ...p.hedger,
          briefsSold: 4,
          priceUsdcPerBrief: 1_000n,
          latePenaltyUsdcPerBrief: 500n,
        };
      },
    });
    await deliverForward(w, 3);
    w.closeWindow(1);
    for (const k of [2, 3, 4]) {
      w.startWindow(k, needsFor);
      w.closeWindow(k);
    }
    const o = w.objective.get("HEDGER");
    expect(o?.onTime).toBe(3);
    expect(o?.late).toBe(1);
    expect(o?.usdcNet).toBe(3n * 1_000n - 500n);
    expect(w.log.of("objective").map((e) => [e.onTimeThisWindow, e.lateThisWindow])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
  });
});

// ---- item 4 -------------------------------------------------------------------------------------------------------------------------------------------
describe("Phase 2 item 4: a lapsed escrow logs paid and refunded in either currency, and the refund check counts it", () => {
  it("a USDC-priced quote accepted and never delivered logs paid 0 and its USDC refund, and the dev-window check counts that refund", async () => {
    const { w } = world("p2-lapse-usdc");
    const { q } = await acceptedUsdcQuote(w);
    const escrow = q.escrow;
    w.closeWindow(1);
    const e = w.log.of("escrow-settle").find((x) => x.escrow === escrow);
    expect(e?.expired).toBe(true);
    expect(e?.paid).toBe(0n);
    expect(e?.refunded).toBe(1_500n);
    const check = judgeDevWindows(w, [stats()]).checks.find((c) =>
      c.name.startsWith("a brief or task failed"),
    );
    expect(check?.detail).toBe("0 briefs failed, 1 refunds");
    expect(check?.ok).toBe(true);
  });

  it("an SIU-priced quote paid in AGU-lab that lapses logs paid 0 beside its AGU-lab refund", async () => {
    const { w } = world("p2-lapse-agu");
    const need = openNeed(w, "DEMAND-1");
    await w.act("DEMAND-1", { tool: "buy_agu", agu: 1_000_000n }, "r");
    await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceMicroSiu: 300_000n },
      "r",
    );
    const q = w.quotes.at(-1) as Quote;
    const acc = await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id }, "r");
    expect(acc.ok, acc.note).toBe(true);
    const escrowed = q.agu;
    const escrow = q.escrow;
    w.closeWindow(1);
    const e = w.log.of("escrow-settle").find((x) => x.escrow === escrow);
    expect(e?.paid).toBe(0n);
    expect(e?.refunded).toBe(escrowed);
  });

  it("the refund check reads a stored log (amounts as decimal strings) exactly as it reads a live one", async () => {
    const { w } = world("p2-lapse-stored");
    await acceptedUsdcQuote(w);
    w.closeWindow(1);
    const stored = JSON.parse(`[${w.log.text().split("\n").join(",")}]`) as LogEntry[];
    const fromDisk = { log: { entries: stored } } as unknown as World;
    const check = judgeDevWindows(fromDisk, [stats()]).checks.find((c) =>
      c.name.startsWith("a brief or task failed"),
    );
    expect(check?.detail).toBe("0 briefs failed, 1 refunds");
  });
});

// ---- item 5 -------------------------------------------------------------------------------------------------------------------------------------------
describe("Phase 2 item 5: service failures count as lost turns in the stop rule and in the turns check", () => {
  it("a window where every model call fails is stopped by the stop rule", async () => {
    const { w, needsFor } = world("p2-stop-service", { start: false });
    const ids = [...w.params.agents.research, ...w.params.agents.demand, w.params.agents.hedger];
    const agents: Agent[] = ids.map((id) => ({
      id,
      role: w.roles.get(id) as Agent["role"],
      seat: "claude-haiku-5-5",
      reply: () =>
        Promise.resolve({ costUsd: new D(0), serviceFailure: "model call failed (status 400)" }),
    }));
    await expect(runWindows({ world: w, agents, windows: [1], needsFor })).rejects.toThrow(
      StopRule,
    );
    await expect(
      runWindows({
        world: world("p2-stop-service-2", { start: false }).w,
        agents,
        windows: [1],
        needsFor,
      }),
    ).rejects.toThrow(/20 turns were lost \(0 parse failures, 20 service failures\)/);
  });

  it("the dev-window turns check counts service failures as lost (v2's window 7: 14 of 48)", () => {
    const { w } = world("p2-turns-check");
    const check = judgeDevWindows(w, [stats({ turns: 48, serviceFailures: 14 })]).checks[0];
    expect(check?.ok).toBe(false);
    expect(check?.detail).toBe("34 of 48 (0 parse failures, 14 service failures)");
  });
});

// ---- item 7 -------------------------------------------------------------------------------------------------------------------------------------------
describe("Phase 2 item 7: work claims transfer as payment, and a brief built on them meets the payer's need (the design's fSIU lifecycle)", () => {
  /** window 1: DEMAND-1 orders front claims for both tasks of its window-2 need; window 2 opens and the roll fills them */
  async function demandHoldsClaimsForItsNeed(seed: string) {
    const { w, worker, needsFor } = world(seed);
    const tasks = [...new Set(needsFor("DEMAND-1", 2))];
    for (const t of tasks) {
      const r = await w.act(
        "DEMAND-1",
        { tool: "order_front_claim", task: t, milli: 250n },
        "buying ahead",
      );
      expect(r.ok, r.note).toBe(true);
    }
    w.closeWindow(1);
    w.startWindow(2, needsFor);
    const claims = tasks.map((t) => {
      const held = boardFor(w, "DEMAND-1").claims.find((c) => c.task === t && c.windowIndex === 2);
      expect(held, `DEMAND-1 holds a window-2 ${t} claim`).toBeDefined();
      return held?.claim as string;
    });
    const need = openNeed(w, "DEMAND-1");
    expect([...need.tasks].sort()).toEqual([...tasks].sort());
    const posted = await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceMicroSiu: 500_000n },
      "r",
    );
    expect(posted.ok, posted.note).toBe(true);
    return { w, worker, need, claims, q: w.quotes.at(-1) as Quote };
  }

  it("mint, transfer, present, deliver: the demand agent pays with its claims, the research agent presents them, and the brief meets the demand agent's need", async () => {
    const { w, need, claims, q } = await demandHoldsClaimsForItsNeed("p2-claims-life");
    const usdc = w.chain.balance("DEMAND-1", "USDC");
    const agu = w.chain.balance("DEMAND-1", "AGU");
    const acc = await w.act(
      "DEMAND-1",
      { tool: "accept_quote", quote: q.id, claims },
      "paying with the claims I bought ahead",
    );
    expect(acc.ok, acc.note).toBe(true);
    expect(q.status).toBe("accepted");
    // transfer: free, at once, to the research agent; no currency moved and no escrow opened
    for (const c of claims) {
      expect(w.chain.claimBalance("DEMAND-1", c)).toBe(0n);
      expect(w.chain.claimBalance("RESEARCH-1", c)).toBe(250n);
    }
    expect(w.chain.balance("DEMAND-1", "USDC")).toBe(usdc);
    expect(w.chain.balance("DEMAND-1", "AGU")).toBe(agu);
    expect(q.escrow).toBeUndefined();
    expect(
      w.log.of("claim-transfer").filter((e) => e.quote === q.id && e.to === "RESEARCH-1"),
    ).toHaveLength(2);
    // present: the new holder presents; a pass retires the claim
    for (const c of claims) {
      const p = await w.act("RESEARCH-1", { tool: "present_claim", claim: c }, "r");
      expect(p.ok, p.note).toBe(true);
      expect(w.chain.claimBalance("RESEARCH-1", c)).toBe(0n);
    }
    // deliver: the outputs from those claims meet DEMAND-1's need
    const d = await w.act("RESEARCH-1", { tool: "deliver_brief", quote: q.id }, "r");
    expect(d.ok, d.note).toBe(true);
    expect(q.status).toBe("delivered");
    expect(need.status).toBe("met");
    const gate = w.log.of("gate").find((e) => e.brief === q.id);
    expect((gate?.components as { fromClaim?: string }[]).map((c) => c.fromClaim).sort()).toEqual(
      [...claims].sort(),
    );
    expect(boardFor(w, "DEMAND-1").quotes.map((x) => x.id)).not.toContain(q.id);
    w.checkInvariants();
  });

  it("present: a fail leaves the transferred claim alive to present again; the next pass retires it", async () => {
    const { w, worker, claims, q } = await demandHoldsClaimsForItsNeed("p2-claims-refail");
    await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id, claims }, "r");
    const c = claims[0] as string;
    worker.queue.push(false, true);
    await w.act("RESEARCH-1", { tool: "present_claim", claim: c }, "r");
    expect(w.chain.claimBalance("RESEARCH-1", c)).toBe(250n);
    await w.act("RESEARCH-1", { tool: "present_claim", claim: c }, "r");
    expect(w.chain.claimBalance("RESEARCH-1", c)).toBe(0n);
  });

  it("close: a transferred claim presented but never served defaults to its new holder at the print; one never presented expires, after its warning", async () => {
    const { w, worker, claims, q } = await demandHoldsClaimsForItsNeed("p2-claims-close");
    await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id, claims }, "r");
    const [presented, idle] = claims as [string, string];
    worker.queue.push(false);
    await w.act("RESEARCH-1", { tool: "present_claim", claim: presented }, "r");
    const usdc = w.chain.balance("RESEARCH-1", "USDC");
    w.closeWindow(2);
    const closes = w.log.of("claim-close");
    const d = closes.find((e) => e.tokenId === presented && e.holder === "RESEARCH-1");
    expect(d?.outcome).toBe("defaulted");
    expect(w.chain.balance("RESEARCH-1", "USDC")).toBe(usdc + (d?.usdc as bigint));
    const x = closes.find((e) => e.tokenId === idle && e.holder === "RESEARCH-1");
    expect(x?.outcome).toBe("expired");
    expect(x?.lapsedAfterWarning).toBe(true);
    // the quote was paid but its brief never delivered: it lapses and leaves the board; the claims were the payment and are not returned
    expect(q.status).toBe("lapsed");
    expect(boardFor(w, "DEMAND-1").quotes.map((y) => y.id)).not.toContain(q.id);
  });

  it("refuses, naming the quote, claims that do not cover the price, a claim for another window, or a claim not held -- and moves nothing", async () => {
    const { w } = world("p2-claims-refuse");
    const need = openNeed(w, "DEMAND-1");
    const [a] = need.tasks as [TaskId, TaskId];
    const nowClaim = w.chain.mint(
      "DEMAND-1",
      a,
      "commodity",
      250n,
      w.windowFrom(1),
      w.windowTo(1),
      w.commodityRate,
    );
    const laterClaim = w.chain.mint(
      "DEMAND-1",
      a,
      "commodity",
      250n,
      w.windowFrom(2),
      w.windowTo(2),
      w.commodityRate,
    );
    await w.act(
      "RESEARCH-1",
      { tool: "post_quote", need: need.id, tasks: need.tasks, priceMicroSiu: 500_000n },
      "r",
    );
    const q = w.quotes.at(-1) as Quote;
    const short = await w.act(
      "DEMAND-1",
      { tool: "accept_quote", quote: q.id, claims: [nowClaim] },
      "r",
    );
    expect(short.note).toBe(`${q.id}: your claims cover 250 of 500 mSIU`);
    const later = await w.act(
      "DEMAND-1",
      { tool: "accept_quote", quote: q.id, claims: [laterClaim] },
      "r",
    );
    expect(later.note).toBe(
      `${q.id}: claim ${laterClaim} is presentable in window 2, not window 1, when this brief is due`,
    );
    const none = await w.act(
      "DEMAND-1",
      { tool: "accept_quote", quote: q.id, claims: ["nope"] },
      "r",
    );
    expect(none.note).toBe(`${q.id}: you hold no claim nope`);
    expect(q.status).toBe("posted");
    expect(w.chain.claimBalance("DEMAND-1", nowClaim)).toBe(250n);
    expect(w.log.of("claim-transfer")).toHaveLength(0);
  });

  it("the board shows a quote paid in claims as paid, never as in escrow", async () => {
    const { w, claims, q } = await demandHoldsClaimsForItsNeed("p2-claims-board");
    await w.act("DEMAND-1", { tool: "accept_quote", quote: q.id, claims }, "r");
    const line = renderBoard(boardFor(w, "DEMAND-1"))
      .split("\n")
      .find((l) => l.includes(q.id));
    expect(line).toMatch(/accepted, paid in work claims \(0\.500 SIU, now held by RESEARCH-1\)/);
    expect(line).not.toMatch(/in escrow/);
  });

  it("parses accept_quote's optional list of claims, and rejects one that is not a list of claim ids", () => {
    const ok = parseToolCall(
      { tool: "accept_quote", args: { reasoning: "r", quote: "quote-1", claims: ["a1", "b2"] } },
      "demand",
    );
    expect(ok.ok && ok.action.tool === "accept_quote" && ok.action.claims).toEqual(["a1", "b2"]);
    const bad = parseToolCall(
      { tool: "accept_quote", args: { reasoning: "r", quote: "quote-1", claims: "a1" } },
      "demand",
    );
    expect(bad.ok).toBe(false);
  });
});
