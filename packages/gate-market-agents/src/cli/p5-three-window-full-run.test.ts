import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  EXTERNAL_DEPLETION_MILLI_SIU,
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
      "ISSUER-A": { measuredRateMilliSiuPerHour: 120, committedCapacityHours: 400, bondedUsdcPerClass: 1_000_000 },
      "ISSUER-B": { measuredRateMilliSiuPerHour: 80, committedCapacityHours: 400, bondedUsdcPerClass: 1_000_000 },
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
      /pay in fSIU/i, /prefer (?:fSIU|USDC|claims|dollars)/i, /you should (?:mint|pay|hold)/i,
      /better to (?:mint|pay|hold)/i, /recommend/i, /cheaper option/i,
    ];
    for (const w of [1, 2, 3]) {
      for (const agent of buildRoster(input(w))) {
        for (const pattern of forbidden) {
          expect(agent.skillPackText).not.toMatch(pattern);
        }
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
    expect(EXTERNAL_DEPLETION_MILLI_SIU).toEqual({ 1: 16_000, 2: 14_000 });
    // Sized so the reserve-ahead decision is consequential rather than free. Never reserving:
    // 16,000 takes ISSUER-A 24,000 -> 8,000; the next 14,000 cannot fit there so it takes
    // ISSUER-B 16,000 -> 2,000; window 3 opens with no issuer able to serve a 10,000 mSIU job.
    const total = Object.values(EXTERNAL_DEPLETION_MILLI_SIU).reduce((a, b) => a + b, 0);
    expect(total).toBe(30_000);
    // And the decision is not foreclosed either: ISSUER-A's 24,000 in window 1 covers both that
    // window's own job and a 10,000 mSIU claim dated for window 3.
    expect(24_000 - 10_000).toBeGreaterThanOrEqual(10_000);
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

const mintEvent: CapacityEvent = {
  agentId: "ORCHESTRATOR",
  turn: 1,
  kind: "pay_with_claim",
  quantityMilliSiu: "10000",
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
      outcome(1, ["24000", "16000"], windowResult({ passed: true, capacityEvents: [mintEvent] })),
      outcome(2, ["14000", "6000"], windowResult({ passed: true })),
      outcome(3, ["4000", "2000"], windowResult({ passed: false })),
    ]);
    expect(verdict.verdict).toBe("failed_with_capacity");
    expect(verdict.detail).toContain("not as the scarcity result");
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
      outcome(1, ["24000", "16000"], windowResult({ passed: true, capacityEvents: [mintEvent] })),
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

/** Plays the run out under one buyer policy and reports whether window 3 got its job done. */
function simulate(reserveAhead: boolean): { window3Delivered: boolean; finalPool: Record<string, number> } {
  const pool: Record<string, number> = { A: 24_000, B: 16_000 }; // the live lots
  const job = 10_000; // the size the briefs quote
  let heldForWindow3: string | null = null;

  for (const w of [1, 2, 3]) {
    if (w === 1 && reserveAhead) {
      const issuer = route(pool, job);
      if (issuer) {
        pool[issuer] -= job;
        heldForWindow3 = issuer;
      }
    }
    if (w === 3 && heldForWindow3) {
      pool[heldForWindow3] += job; // presented and delivered against the claim already held
      return { window3Delivered: true, finalPool: pool };
    }
    const issuer = route(pool, job);
    if (!issuer) return { window3Delivered: false, finalPool: pool };
    pool[issuer] -= job;
    pool[issuer] += job; // minted, delivered inside its own window, capacity returned
    const depletion = EXTERNAL_DEPLETION_MILLI_SIU[w];
    if (depletion !== undefined) {
      const taker = route(pool, depletion);
      if (taker) pool[taker] -= depletion;
    }
  }
  return { window3Delivered: true, finalPool: pool };
}

describe("external depletion schedule", () => {
  it("makes the reserve-ahead decision consequential: declining it loses window 3", () => {
    // Outcome (a). If this ever passes, the schedule has stopped producing the scarcity finding
    // and the run measures nothing about the instrument.
    const { window3Delivered, finalPool } = simulate(false);
    expect(window3Delivered).toBe(false);
    expect(Math.max(...Object.values(finalPool))).toBeLessThan(10_000);
  });

  it("does not force it either: reserving ahead in window 1 still leaves that window its own job", () => {
    // Outcome (c). Both branches have to be reachable, or the "choice" is not one.
    const { window3Delivered } = simulate(true);
    expect(window3Delivered).toBe(true);
  });
});
