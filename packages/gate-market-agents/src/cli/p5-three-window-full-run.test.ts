import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  EXTERNAL_DEPLETION_MILLI_SIU,
  NON_SERVING_ISSUER,
  WINDOW_SECONDS,
  defaultReachability,
  assertProvidersReachable,
  WINDOW_COUNT,
  buildRoster,
  type RosterInput,
} from "./p5-three-window-full-run.js";
import type { AdapterResult } from "@touchstone/harness";

const noopAdapter = async (): Promise<AdapterResult> => ({
  text: "",
  usage: { input: 0, output: 0, cached_input: 0, reasoning: 0 },
  latency_ms: 0,
  raw: {},
  deviations: [],
});

const AGENTS = ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT", "ISSUER-A", "ISSUER-B"] as const;

function input(windowIndex: number, overrides: Partial<RosterInput> = {}): RosterInput {
  return {
    windowIndex,
    headroomBefore: [
      { issuer: "0x00000000000000000000000000000000000000a1", headroom: "24000" },
      { issuer: "0x00000000000000000000000000000000000000b2", headroom: "16000" },
    ],
    taskSpecHash: `0x${"11".repeat(32)}` as Hex,
    rateUsdPerSiu: "0.001433",
    printId: "2026-09-27-commodity",
    models: Object.fromEntries(AGENTS.map((a) => [a, "gpt-5.1"])),
    adapters: Object.fromEntries(AGENTS.map((a) => [a, noopAdapter])),
    addresses: Object.fromEntries(AGENTS.map((a, i) => [a, `0x${String(i).repeat(40)}` as Hex])),
    keys: Object.fromEntries(AGENTS.map((a, i) => [a, `0x${String(i + 1).repeat(64)}` as Hex])),
    rpcUrl: "http://127.0.0.1:1",
    registryEntry: () => ({ provider: "openai", host: "openai" }),
    workerCodeErc8004Id: "erc8004:0xworker",
    workerExtractErc8004Id: "erc8004:0xextract",
    capacityLots: {
      "ISSUER-A": {
        measuredRateMilliSiuPerHour: 120,
        committedCapacityHours: 400,
        bondedUsdcPerClass: 1_000_000,
      },
      "ISSUER-B": {
        measuredRateMilliSiuPerHour: 80,
        committedCapacityHours: 400,
        bondedUsdcPerClass: 1_000_000,
      },
    },
    windowFrom: 1_800_000_000n,
    windowTo: 1_800_003_600n,
    ...overrides,
  };
}

const find = (roster: ReturnType<typeof buildRoster>, id: string) => {
  const agent = roster.find((a) => a.agentId === id);
  if (!agent) throw new Error(`no ${id} in roster`);
  return agent;
};

describe("p5 three-window roster", () => {
  it("offers quote_forward only while a later window still exists", () => {
    for (const w of [1, 2]) {
      expect(find(buildRoster(input(w)), "ISSUER-A").availableTools).toContain("quote_forward");
    }
    // Nothing to quote forward for in the last window — offering the tool there would invite an
    // action the loop must then refuse, which reads to a model as a broken tool.
    expect(find(buildRoster(input(WINDOW_COUNT)), "ISSUER-A").availableTools).not.toContain(
      "quote_forward",
    );
    expect(find(buildRoster(input(WINDOW_COUNT)), "ISSUER-A").skillPackText).toContain(
      "There are no windows after this one",
    );
  });

  it("tells every agent the real, current pool rather than a nominal capacity", () => {
    const roster = buildRoster(input(2));
    for (const agent of roster) {
      expect(agent.skillPackText).toContain("THIS RUN HAS 3 WINDOWS. THIS IS WINDOW 2.");
      expect(agent.skillPackText).toContain("24000 mSIU");
      expect(agent.skillPackText).toContain("16000 mSIU");
      expect(agent.skillPackText).toContain("Total across all issuers: 40000 mSIU");
    }
  });

  it("discloses the instrument asymmetry to every agent, in the shared words", () => {
    for (const agent of buildRoster(input(1))) {
      // The same text as docs/gate-market-spec.md §4.4 and the run output — kept in one place so
      // the three statements cannot drift.
      expect(agent.skillPackText).toContain("CAPACITY IS ONE POOL");
      expect(agent.skillPackText).toContain("capacity for a FUTURE delivery window");
      expect(agent.skillPackText).toContain("IMMEDIATE work only");
      expect(agent.skillPackText).toContain("The issuer is not paid for a reservation");
    }
  });

  it("tells agents that a claim routes to one issuer, so a split pool is not a whole one", () => {
    expect(find(buildRoster(input(1)), "ORCHESTRATOR").skillPackText).toContain(
      "cannot between them serve one 10,000 mSIU claim",
    );
  });

  it("never names a preferred asset, price or strategy anywhere in any brief", () => {
    // F1's whole finding dies on a single such sentence (spec §7.1), so this is asserted
    // structurally rather than trusted to review.
    const forbidden = [
      /pay in fSIU/i,
      /prefer (?:fSIU|USDC|claims|dollars)/i,
      /you should (?:mint|pay|hold)/i,
      /better to (?:mint|pay|hold)/i,
      /recommend/i,
      /cheaper option/i,
    ];
    for (const w of [1, 2, 3]) {
      for (const agent of buildRoster(input(w))) {
        for (const pattern of forbidden) {
          expect(agent.skillPackText).not.toMatch(pattern);
        }
      }
    }
  });

  /**
   * The defect this asserts against was live for two whole runs and cost 8,000 mSIU.
   *
   * WORKER-EXTRACT was paid in fSIU twice — 4,000 in run 9, 4,000 in run 10 — while holding no
   * claim tool whatsoever. Both claims were unredeemable and both expired worthless. For the
   * attack-testing purchase, fSIU was therefore not one of two assets a buyer was choosing
   * between; it was strictly worse than dollars, and any F1 figure including that purchase is
   * measuring a broken option rather than a preference.
   *
   * The agent reported it itself, in the field built for exactly this:
   *   "redeem_claim is not in the list of available tools this turn"
   *
   * A roster test is the right place for this because a dry-loop scenario would not have caught
   * it: `buildRunners` grants every tool, so the mechanics always worked. What was missing was
   * the grant.
   */
  it("gives every agent that can be PAID in fSIU a way to redeem it", () => {
    for (const w of [1, 2, WINDOW_COUNT]) {
      const roster = buildRoster(input(w));
      for (const id of ["WORKER-CODE", "WORKER-EXTRACT"]) {
        const agent = find(roster, id);
        expect(
          agent.availableTools,
          `${id} can be paid in fSIU and must be able to redeem it`,
        ).toContain("redeem_claim");
        // The holder is who a default pays, and settleWindowClose is permissionless.
        expect(agent.availableTools).toContain("settle_window_close");
      }
    }
  });

  /**
   * "Claims do not circulate" was a property of the tool grant, not an observation about agent
   * behaviour: a holder's only move was redeem-then-pay-dollars, so a claim could never pass
   * from one party to another, which makes fSIU a settlement rail rather than money.
   */
  it("lets a holder pass a claim on instead of redeeming it", () => {
    const worker = find(buildRoster(input(1)), "WORKER-CODE");
    expect(worker.availableTools).toContain("transfer_claim");
    expect(worker.availableTools).toContain("pay_with_claim");
  });

  /**
   * Phase 2/3 of the freedom set. The briefs used to tell a holder to "confirm the balance with
   * get_balances, then present it with exactly: {redeem_claim ...}" — one prescribed path, with
   * exact call syntax supplied for redeeming and for nothing else. Withholding syntax for the
   * alternatives is the same shape of steer as the turn-cost asymmetry behind §4.6f, so the
   * options must be documented equally or the measurement is contaminated before it starts.
   */
  it("gives every claim option the same treatment, so none is easier to reach than another", () => {
    for (const id of ["WORKER-CODE", "WORKER-EXTRACT"]) {
      const brief = find(buildRoster(input(1)), id).skillPackText;
      // Each option, with its exact call — equal footing, no favoured path.
      for (const tool of ["redeem_claim", "transfer_claim", "pay_with_claim"]) {
        expect(brief, `${id} must be told how to ${tool}`).toContain(`"tool": "${tool}"`);
      }
      // The instrument's properties, as facts.
      expect(brief).toContain("fixed in SIU");
      expect(brief).toContain("the bond pays you instead");
      expect(brief).toContain("Nothing here says which to use");
    }
  });

  it("carries no steer toward redeeming, and no counter-steer toward holding", () => {
    for (const agent of buildRoster(input(1))) {
      const brief = agent.skillPackText;
      // The removed instruction, and anything of its shape.
      expect(brief).not.toMatch(/then present it with exactly/i);
      // Counter-bias would contaminate the finding in the other direction and is equally banned.
      expect(brief).not.toMatch(/consider holding|redemption is not the goal|you may wish to hold/i);
      // Nothing about price movement: one print and three windows, so no price can move while
      // anyone holds. Prompting toward it would describe an unavailable opportunity.
      expect(brief).not.toMatch(/in case prices|if prices rise|price may rise/i);
    }
  });

  /**
   * The general form of the Phase 2 finding, checked across EVERY brief rather than the one it
   * was found in.
   *
   * WORKER-CODE's brief used to describe several things a holder might do and supply a working
   * call for exactly one of them — `redeem_claim`. The prose was neutral; the surface was not.
   * An agent reaches for the option it has been handed a call it can paste, so demonstrating one
   * option while describing the rest in prose is a steer by the same mechanism as the turn-cost
   * confound (§4.6f): one route is cheaper to take, and the resulting choice reads as a
   * preference. See spec §4.6q.
   *
   * The rule asserted here: among the ways an agent can DISPOSE OF A CLAIM it holds, either
   * every one it has been granted is demonstrated, or none is.
   */
  it("never demonstrates one claim option while leaving its siblings in prose", () => {
    const dispositions = ["redeem_claim", "transfer_claim", "pay_with_claim", "settle_split"];
    for (const w of [1, 2, WINDOW_COUNT]) {
      for (const agent of buildRoster(input(w))) {
        const granted = dispositions.filter((t) => agent.availableTools.includes(t as never));
        if (granted.length < 2) continue;
        const demonstrated = granted.filter((t) => agent.skillPackText.includes(`"tool": "${t}"`));
        expect(
          demonstrated.length === 0 || demonstrated.length === granted.length,
          `${agent.agentId} (window ${w}) is granted [${granted.join(", ")}] but demonstrates ` +
            `only [${demonstrated.join(", ")}] — supplying a working call for some options and ` +
            `not others is a steer even when the prose is even-handed.`,
        ).toBe(true);
      }
    }
  });

  it("gives WORKER-CODE the capacity-commitment step on the dollar route", () => {
    const worker = find(buildRoster(input(1)), "WORKER-CODE");
    expect(worker.availableTools).toContain("reserve_for_work");
    expect(worker.skillPackText).toContain("reserve_for_work");
    expect(worker.skillPackText).toContain("returned automatically when you settle");
  });

  it("keeps the external-buyer schedule fixed in source, not derived at run time", () => {
    // If this ever becomes a function of anything observed during a run, the depletion stops
    // being disclosable in advance and the whole scarcity reading is contaminated.
    // Resized down on 2026-09-29: scarcity was already demonstrated on-chain (window 3 of the
    // 2026-09-28 run, four NoIssuerWithHeadroom reverts), so the schedule is now sized so the
    // ENFORCEMENT arm is the only thing that can fail — see this constant's own doc comment.
    expect(EXTERNAL_DEPLETION_MILLI_SIU).toEqual({ 1: 3_000, 2: 3_000 });
    const total = Object.values(EXTERNAL_DEPLETION_MILLI_SIU).reduce((a, b) => a + b, 0);
    expect(total).toBe(6_000);
    expect(Object.keys(EXTERNAL_DEPLETION_MILLI_SIU).map(Number)).not.toContain(WINDOW_COUNT);
  });
});

// ---------------------------------------------------------------- outcome classification

import { classifyFinalWindow, type WindowOutcome } from "./p5-three-window-full-run.js";
import type { CapacityEvent, FullRunWindowResult } from "../loop/full-run.js";

function windowResult(overrides: Partial<FullRunWindowResult> = {}): FullRunWindowResult {
  return {
    passed: false,
    totalRealizedUsd: "0",
    spendByProvider: {},
    attacks: [],
    gateVersions: [],
    forwardQuotes: [],
    forwardInvitations: [],
    capacityEvents: [],
    turnsByAgent: {},
    turnLogsByAgent: {},
    ...overrides,
  };
}

function outcome(
  windowIndex: number,
  headroom: string[],
  result: FullRunWindowResult,
): WindowOutcome {
  const rows = headroom.map((h, i) => ({ issuer: `0x${String(i)}`, headroom: h }));
  return { windowIndex, result, headroomBefore: rows, headroomAfter: rows };
}

/** An ordinary same-window payment — NOT cover for a later window. */
const mintEvent: CapacityEvent = {
  agentId: "ORCHESTRATOR",
  turn: 1,
  kind: "pay_with_claim",
  quantityMilliSiu: "10000",
  forwardDated: false,
};

/** A claim genuinely dated for a later window — the only thing that counts as securing ahead. */
const forwardDatedMint: CapacityEvent = { ...mintEvent, forwardDated: true };

/** One failed purchase attempt, as the turn log records it. */
const failedPurchaseTurn = {
  turn: 1,
  promptChars: 0,
  projectedUsd: "0",
  realizedUsd: "0",
  latencyMs: 0,
  parsed:
    '{"tool":"pay_with_claim","args":{"quantity":"10000"}} -> tool call error: mint reverted NoIssuerWithHeadroom',
};

describe("window-3 outcome classification", () => {
  it("calls it scarcity only when capacity was genuinely gone AND nothing was secured ahead", () => {
    const verdict = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true })),
      outcome(2, ["14000", "6000"], windowResult({ passed: true })),
      outcome(3, ["4000", "2000"], windowResult({ passed: false })),
    ]);
    expect(verdict.verdict).toBe("scarcity");
    expect(verdict.detail).toContain("scarcity finding");
  });

  it("refuses to call it scarcity when the orchestrator had secured capacity ahead", () => {
    // Same empty pool, opposite cause: this is a defect to investigate, not the finding.
    const verdict = classifyFinalWindow([
      outcome(
        1,
        ["24000", "16000"],
        windowResult({ passed: true, capacityEvents: [forwardDatedMint] }),
      ),
      outcome(2, ["14000", "6000"], windowResult({ passed: true })),
      outcome(3, ["4000", "2000"], windowResult({ passed: false })),
    ]);
    expect(verdict.verdict).toBe("failed_with_capacity");
    expect(verdict.detail).toContain("not as the scarcity result");
  });

  it("does NOT treat an ordinary same-window payment as capacity secured ahead — the real misreading from the first three-window run", () => {
    // Two same-window payments in windows 1 and 2, then a shut-out buyer in window 3. The first
    // run's own classifier counted those two as "secured ahead" and reported the scarcity outcome
    // as "the instrument working as intended", which inverted the result entirely.
    const verdict = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true, capacityEvents: [mintEvent] })),
      outcome(2, ["14000", "0"], windowResult({ passed: true, capacityEvents: [mintEvent] })),
      outcome(
        3,
        ["4000", "0"],
        windowResult({
          passed: true,
          passedBy: "WORKER-CODE",
          turnLogsByAgent: { ORCHESTRATOR: [failedPurchaseTurn] },
        }),
      ),
    ]);
    expect(verdict.verdict).toBe("scarcity");
  });

  it("calls it scarcity when the buyer was shut out, even if an unpaid worker delivered anyway", () => {
    // passed=true says a gate exists, not that the work was bought. Conflating the two is exactly
    // how a scarcity result gets reported as the instrument succeeding.
    const verdict = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true })),
      outcome(2, ["14000", "0"], windowResult({ passed: true })),
      outcome(
        3,
        ["4000", "0"],
        windowResult({
          passed: true,
          passedBy: "WORKER-CODE",
          turnLogsByAgent: { ORCHESTRATOR: [failedPurchaseTurn] },
        }),
      ),
    ]);
    expect(verdict.verdict).toBe("scarcity");
    expect(verdict.detail).toContain("could not buy");
    expect(verdict.detail).toContain("must not be read as it working");
  });

  it("refuses to call it scarcity when an issuer still had enough for the job", () => {
    const verdict = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true })),
      outcome(2, ["24000", "16000"], windowResult({ passed: true })),
      outcome(3, ["12000", "2000"], windowResult({ passed: false })),
    ]);
    expect(verdict.verdict).toBe("failed_with_capacity");
  });

  it("judges capacity per issuer, never by the total, because a claim routes to one issuer", () => {
    // 6,000 + 6,000 = 12,000 in total but nothing that can serve a 10,000 mSIU claim.
    const verdict = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true })),
      outcome(2, ["12000", "8000"], windowResult({ passed: true })),
      outcome(3, ["6000", "6000"], windowResult({ passed: false })),
    ]);
    expect(verdict.verdict).toBe("scarcity");
  });

  it("separates a completed window that used pre-secured capacity from one that got lucky", () => {
    const secured = classifyFinalWindow([
      outcome(
        1,
        ["24000", "16000"],
        windowResult({ passed: true, capacityEvents: [forwardDatedMint] }),
      ),
      outcome(2, ["14000", "6000"], windowResult({ passed: true })),
      outcome(3, ["4000", "2000"], windowResult({ passed: true })),
    ]);
    expect(secured.verdict).toBe("completed");
    expect(secured.detail).toContain("the instrument working as intended");

    const lucky = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true })),
      outcome(2, ["24000", "16000"], windowResult({ passed: true })),
      outcome(3, ["24000", "16000"], windowResult({ passed: true })),
    ]);
    expect(lucky.verdict).toBe("completed");
    expect(lucky.detail).toContain("not evidence about the instrument");
  });
});

// ---------------------------------------------------------------- depletion sizing

/**
 * `ClaimRouter.route` in miniature: the first issuer in registration order holding enough by
 * itself. Duplicated here rather than imported because the point is to check the *schedule*
 * against the router's real rule, and a test that imported the thing it is checking would only
 * confirm it agrees with itself.
 */
function route(pool: Record<string, number>, quantity: number): string | null {
  for (const issuer of ["A", "B"]) {
    if (pool[issuer] >= quantity) return issuer;
  }
  return null;
}

/** The run as it actually is now: ISSUER-A never serves, so its claims stay consumed unless the
 * holder settles them. Mirrors ClaimRouter's real rule (first issuer with enough by itself). */
function simulateNonServing(holderSettles: boolean, extraPurchase = false) {
  const pool: Record<string, number> = { A: 24_000, B: 16_000 };
  const job = 10_000;
  const outstanding: Array<[string, number]> = [];
  for (const w of [1, 2, 3]) {
    if (holderSettles && outstanding.length > 0) {
      const [iss, q] = outstanding.shift()!;
      pool[iss] += q; // settleWindowClose restores headroom on BOTH branches
    }
    const purchases = extraPurchase && w === 1 ? 2 : 1;
    for (let k = 0; k < purchases; k++) {
      const issuer = route(pool, job);
      if (!issuer) return { window3Purchasable: w !== 3, finalPool: pool };
      pool[issuer] -= job;
      if (issuer === "A") outstanding.push([issuer, job]);
      else pool[issuer] += job; // ISSUER-B serves, capacity returns
    }
    const d = EXTERNAL_DEPLETION_MILLI_SIU[w];
    if (d !== undefined) {
      const taker = route(pool, d);
      if (taker) pool[taker] -= d;
    }
  }
  return { window3Purchasable: true, finalPool: pool };
}

describe("external depletion schedule — sized so the enforcement arm is the only thing that can fail", () => {
  it("leaves window 3 purchasable in the worst case, where nobody ever settles", () => {
    // Nobody settling is precisely the behaviour under test, so it is the case the sizing must
    // survive. If this ever fails, scarcity and enforcement can fail in the same run and the
    // result has two causes tangled in it.
    const { window3Purchasable, finalPool } = simulateNonServing(false);
    expect(window3Purchasable).toBe(true);
    expect(Math.max(...Object.values(finalPool))).toBeGreaterThanOrEqual(10_000);
  });

  it("leaves it purchasable when the holder does settle, too — settling returns capacity", () => {
    expect(simulateNonServing(true).window3Purchasable).toBe(true);
  });

  it("survives a spurious extra purchase rather than sitting on the exact boundary", () => {
    expect(simulateNonServing(false, true).window3Purchasable).toBe(true);
  });

  it("keeps a real margin, not a knife edge", () => {
    // 4,000/6,000 also "works" but lands on exactly 10,000 with zero margin; rejected for that.
    const { finalPool } = simulateNonServing(false);
    expect(Math.max(...Object.values(finalPool)) - 10_000).toBeGreaterThanOrEqual(2_000);
  });

  it("is still a visible constraint — the pool really does shrink", () => {
    const { finalPool } = simulateNonServing(false);
    const total = Object.values(finalPool).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(40_000);
  });

  it("is fixed in source, not derived at run time", () => {
    expect(EXTERNAL_DEPLETION_MILLI_SIU).toEqual({ 1: 3_000, 2: 3_000 });
  });
});

// ---------------------------------------------------------------- default reachability

const DAY = 86_400n;
const MIDNIGHT = 1_790_640_000n; // a real UTC midnight
const bounds = (startOffsetSeconds: bigint) =>
  Object.fromEntries(
    [1, 2, 3].map((i) => [
      i,
      {
        from: MIDNIGHT + startOffsetSeconds + BigInt(i - 1) * WINDOW_SECONDS,
        to: MIDNIGHT + startOffsetSeconds + BigInt(i) * WINDOW_SECONDS,
      },
    ]),
  );

describe("defaultReachability — a run that cannot settle defaults must say so before it starts", () => {
  it("is reachable when every window closes on the day the print is dated", () => {
    // 12:42 UTC against that same day's print — the 2026-09-28 run's own shape, which worked
    // only because of that timing.
    const r = defaultReachability(bounds(12n * 3600n + 42n * 60n), MIDNIGHT);
    expect(r.every((w) => w.reachable)).toBe(true);
  });

  it("is UNREACHABLE when the run starts before the day's 00:17 UTC print has published", () => {
    // Latest print is still yesterday's; every window closes today. Without the check this is
    // silent — settle_window_close just reverts like any other failed call.
    const r = defaultReachability(bounds(5n * 60n), MIDNIGHT - DAY);
    expect(r.every((w) => !w.reachable)).toBe(true);
  });

  it("is UNREACHABLE for windows that fall the other side of midnight UTC", () => {
    // Starting 23:40 with 20-minute windows pushes every close past midnight, onto a day no
    // print exists for yet.
    const r = defaultReachability(bounds(23n * 3600n + 40n * 60n), MIDNIGHT);
    expect(r.every((w) => !w.reachable)).toBe(true);
  });

  it("reports per window rather than as one verdict, since a run can straddle the boundary", () => {
    // 23:50 start: window 1 closes 00:10 next day, so all three are past midnight — but the
    // shape of the answer is per-window, which is what a straddling run needs.
    const r = defaultReachability(bounds(23n * 3600n + 50n * 60n), MIDNIGHT);
    expect(r).toHaveLength(3);
    expect(r.map((w) => w.windowIndex)).toEqual([1, 2, 3]);
    for (const w of r) expect(typeof w.reachable).toBe("boolean");
  });
});

describe("the deliberately non-serving issuer", () => {
  it("is fixed in source before the run, like the depletion schedule", () => {
    // If this ever becomes a function of anything observed during a run, the enforcement test
    // stops being disclosable in advance.
    expect(NON_SERVING_ISSUER).toBe("ISSUER-A");
  });

  it("has no way to serve a redemption, while the other issuer does", () => {
    const roster = buildRoster(input(1));
    expect(find(roster, "ISSUER-A").availableTools).not.toContain("serve_redemption");
    expect(find(roster, "ISSUER-B").availableTools).toContain("serve_redemption");
  });

  it("still takes payment and still holds capacity — a defaulter, not an absentee", () => {
    // It keeps mint_claim and check_headroom: a claim must still be mintable against it for the
    // default to be reachable at all.
    const issuerA = find(buildRoster(input(1)), "ISSUER-A");
    expect(issuerA.availableTools).toContain("mint_claim");
    expect(issuerA.availableTools).toContain("check_headroom");
  });

  it("gives the holder the means to settle, since a default pays the holder", () => {
    expect(find(buildRoster(input(1)), "WORKER-CODE").availableTools).toContain(
      "settle_window_close",
    );
  });

  it("tells no other agent that this issuer will not serve — noticing is what is being tested", () => {
    for (const agent of buildRoster(input(1))) {
      expect(agent.skillPackText).not.toMatch(
        /will not serve|non-serving|deliberately.*not deliver/i,
      );
    }
  });
});

describe("assertProvidersReachable", () => {
  const models = {
    ORCHESTRATOR: "gpt-5.1",
    "WORKER-CODE": "claude-sonnet-5",
    "ISSUER-A": "grok-4.6",
    "ISSUER-B": "grok-4.6",
  };
  const providerOf = (m: string) =>
    m.startsWith("gpt") ? "openai" : m.startsWith("claude") ? "anthropic" : "xai";

  it(
    "checks each distinct provider exactly once, not each agent — two agents on one provider " +
      "prove nothing extra about that endpoint",
    async () => {
      const calls: string[] = [];
      const ok = Object.fromEntries(
        Object.keys(models).map((a) => [
          a,
          async (model: string) => {
            calls.push(`${a}:${model}`);
            return {};
          },
        ]),
      );
      const checked = await assertProvidersReachable(ok, models, providerOf);
      expect(calls).toHaveLength(3); // openai, anthropic, xai — not four agents
      expect(checked.map((c) => c.provider).sort()).toEqual(["anthropic", "openai", "xai"]);
    },
  );

  it(
    "refuses to start the run when a provider cannot answer, naming it and its real error — " +
      "the exact xAI 403 that killed both issuers mid-window on 2026-09-29",
    async () => {
      const adapters = Object.fromEntries(
        Object.keys(models).map((a) => [
          a,
          async (model: string) => {
            if (model === "grok-4.6") {
              throw new Error("OpenAI-compatible request failed: 403 permission-denied");
            }
            return {};
          },
        ]),
      );
      await expect(assertProvidersReachable(adapters, models, providerOf)).rejects.toThrow(
        /PRE-FLIGHT FAILED[\s\S]*xai \(grok-4\.6\)[\s\S]*403/,
      );
    },
  );

  it(
    "reports every failing provider, not merely the first — an outage rarely arrives alone and " +
      "fixing one at a time costs a run each",
    async () => {
      const adapters = Object.fromEntries(
        Object.keys(models).map((a) => [
          a,
          async () => {
            throw new Error("no credits");
          },
        ]),
      );
      await expect(assertProvidersReachable(adapters, models, providerOf)).rejects.toThrow(
        /3 of 3 provider\(s\)/,
      );
    },
  );
});
