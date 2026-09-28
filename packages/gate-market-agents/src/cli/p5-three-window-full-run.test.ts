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
    expect(EXTERNAL_DEPLETION_MILLI_SIU).toEqual({ 1: 14_000, 2: 14_000 });
    // Sized against the live pool: 40,000 - 28,000 leaves 12,000 mSIU across two issuers.
    const total = Object.values(EXTERNAL_DEPLETION_MILLI_SIU).reduce((a, b) => a + b, 0);
    expect(total).toBe(28_000);
    expect(Object.keys(EXTERNAL_DEPLETION_MILLI_SIU).map(Number)).not.toContain(WINDOW_COUNT);
  });
});
