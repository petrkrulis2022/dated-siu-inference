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
  scheduleFacts,
  RUN_PURCHASES,
  requiredQuoteSizes,
  reservedQuoteHashes,
  type RosterInput,
} from "./p5-three-window-full-run.js";
import type { AdapterResult } from "@touchstone/harness";
import { taskSpecHashIn, windowOf } from "./scripted-policy.js";

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

describe("claims whose holder was never offered a settlement (spec §4.6ae)", () => {
  const claim = (mintedInWindow: number, tokenId: string) => ({
    tokenId,
    holder: "0xholder",
    holderAgentId: "WORKER-CODE" as const,
    issuerAgentId: "ISSUER-A" as const,
    quantityMilliSiu: "10000",
    mintedInWindow,
  });

  it("names only last-window claims — an earlier one WAS shown to its holder", () => {
    // settleableText lists claims carried from an earlier window, so a window-1 claim really is
    // offered in window 2. Only a last-window claim has no turn left in which to offer it.
    const out = claimsHolderWasNeverOfferedSettlement([
      claim(1, "0xaa"),
      claim(2, "0xbb"),
      claim(WINDOW_COUNT, "0xcc"),
    ]);
    expect(out.map((c) => c.tokenId)).toEqual(["0xcc"]);
  });

  it("is empty when nothing is outstanding, so a clean run stays quiet", () => {
    expect(claimsHolderWasNeverOfferedSettlement([])).toEqual([]);
  });

  it("does not silently drop several last-window claims", () => {
    const out = claimsHolderWasNeverOfferedSettlement([
      claim(WINDOW_COUNT, "0xcc"),
      claim(WINDOW_COUNT, "0xdd"),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("§4.6ac invariant, on the real roster", () => {
  // The guarantee: an agent is never woken by a section it cannot act on. Checked against the
  // roster that actually runs, through the real composition, for every section one at a time —
  // a grant that drifts away from the wake table would otherwise reintroduce §4.6ac silently,
  // and silently is how it arrived the first time.
  const SECTIONS = Object.keys(WAKE_SECTION_TOOLS) as (keyof typeof WAKE_SECTION_TOOLS)[];
  const blank = Object.fromEntries(SECTIONS.map((k) => [k, ""])) as Record<string, string>;

  it("never puts a section in an agent's wake key unless that agent holds one of its tools", () => {
    for (const w of [1, 2, WINDOW_COUNT]) {
      for (const agent of buildRoster(input(w))) {
        const tools = agent.availableTools as readonly string[];
        for (const section of SECTIONS) {
          const { shown, wakeKey } = composeBoard(
            {
              ...blank,
              [section]: `TEXT-${section}`,
              // Exercise the harder branch: a served FAIL is the only served state that wakes.
              servedWasFailure: true,
            } as unknown as Parameters<typeof composeBoard>[0],
            agent.availableTools,
          );
          // Shown regardless — knowing is never gated on being able to act.
          expect(shown).toBe(`TEXT-${section}`);
          if (wakeKey !== "") {
            const usable = WAKE_SECTION_TOOLS[section].filter((t) => tools.includes(t));
            expect(
              usable.length,
              `w${w} ${agent.agentId} is woken by ${section} holding none of its tools`,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("WORKER-EXTRACT is shown a served FAIL and is NOT woken by it — it holds no way to buy again", () => {
    // The case the invariant caught on its first run, pinned so a later grant change cannot
    // quietly make it wrong in either direction. WORKER-EXTRACT can hold and redeem a claim
    // (added 2026-09-30 after it was paid in fSIU it could not redeem, §4.6p) but has no
    // purchase tool at all.
    const agent = find(buildRoster(input(1)), "WORKER-EXTRACT");
    expect(agent.availableTools).toContain("redeem_claim");
    const { shown, wakeKey } = composeBoard(
      { ...blank, servedText: "SERVED-FAIL", servedWasFailure: true } as unknown as Parameters<
        typeof composeBoard
      >[0],
      agent.availableTools,
    );
    expect(shown).toBe("SERVED-FAIL");
    expect(wakeKey).toBe("");
  });

  it("WORKER-CODE, which can buy, IS woken by a served FAIL", () => {
    const agent = find(buildRoster(input(1)), "WORKER-CODE");
    const { wakeKey } = composeBoard(
      { ...blank, servedText: "SERVED-FAIL", servedWasFailure: true } as unknown as Parameters<
        typeof composeBoard
      >[0],
      agent.availableTools,
    );
    expect(wakeKey).toBe("SERVED-FAIL");
  });

  it("both holders are woken by an overdue claim — each has something it can do about one", () => {
    for (const who of ["WORKER-CODE", "WORKER-EXTRACT"] as const) {
      const agent = find(buildRoster(input(1)), who);
      const { wakeKey } = composeBoard(
        { ...blank, unservedText: "OVERDUE", servedWasFailure: false } as unknown as Parameters<
          typeof composeBoard
        >[0],
        agent.availableTools,
      );
      expect(wakeKey, `${who} cannot act on an overdue claim`).toBe("OVERDUE");
    }
  });
});

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

  /**
   * Phase 5: the adversarial testing is bought by WORKER-CODE, not ORCHESTRATOR, so a claim can
   * reach a second pair of hands and be spent onward instead of redeemed.
   */
  it("moves the adversarial-testing purchase to WORKER-CODE, and stops telling ORCHESTRATOR about it", () => {
    const roster = buildRoster(input(1));
    const orchestrator = find(roster, "ORCHESTRATOR").skillPackText;
    const workerCode = find(roster, "WORKER-CODE").skillPackText;

    // A brief that still described a purchase the agent no longer makes would describe a world
    // the agent is not in — the same defect as the "wait" instruction for a protocol that
    // offered no way to wait.
    expect(orchestrator).not.toContain("A SECOND PIECE OF WORK");
    expect(orchestrator).not.toContain("erc8004:0xextract");

    expect(workerCode).toContain("THE ADVERSARIAL TESTING");
    expect(workerCode).toContain("erc8004:0xextract");
  });

  it("states the rule that makes the testing purchase matter, to everyone, as a fact", () => {
    // `passed` now includes the testing purchase settling (single-issuer plan D4). An agent that
    // is not told would be penalised by a rule it could not know, and one told only in the
    // buyer's brief would leave the seller and the orchestrator in a different world. It is
    // stated once, in the description every agent receives, and says nothing about what to do.
    const roster = buildRoster(input(1));
    for (const id of ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT"]) {
      const text = find(roster, id).skillPackText;
      expect(text, id).toContain("WHEN THE WINDOW COUNTS AS PASSED");
      expect(text, id).toMatch(/AND adversarial testing of it has been paid\s+for AND carried out/);
    }
  });

  it("does not describe testing as free or optional to the agent that now sells it", () => {
    // WORKER-EXTRACT used to be told to attack whenever a gate existed. A brief that still said so
    // would describe a world it is no longer in — the same defect as the "wait" instruction for a
    // protocol that offered no way to wait.
    const extract = find(buildRoster(input(1)), "WORKER-EXTRACT").skillPackText;
    expect(extract).toContain("TESTING IS A SERVICE YOU SELL");
    expect(extract).toContain("submit_attack is refused until a quote you issued has been");
    const code = find(buildRoster(input(1)), "WORKER-CODE").skillPackText;
    expect(code).not.toContain("Buying it is optional");
  });

  it("never teaches a call the tools now reject", () => {
    // Every pay_with_claim example in every brief must name a quote. The unkeyed
    // recipient-and-quantity form is refused by the arg builder, so a brief still teaching it
    // costs the agent a turn on an error — the §4.6-RULE defect.
    const roster = buildRoster(input(1));
    for (const a of roster) {
      const examples = a.skillPackText.match(/\{"tool": "pay_with_claim"[^}]*\}/g) ?? [];
      for (const ex of examples) {
        expect(ex, `${a.agentId}: ${ex}`).toContain("requestId");
        expect(ex, `${a.agentId}: ${ex}`).not.toMatch(/"quantity"|"agentId"/);
      }
    }
  });

  it("every agent's brief, in every window, passes the pre-turn validator — a brief that trips it benches the seat before turn 1", () => {
    // The validator guards the one behavioural finding (no asset steering, no doc leak, the asset
    // text verbatim) and HALTS the turn rather than warning. Briefs are rewritten constantly, and
    // nothing ran them through it: the first debug run on the sixth trio halted WORKER-EXTRACT with
    // `validation_failed` on turn one, with the cause printed nowhere. Asserted for every seat and
    // every window, so the cause is named here instead.
    for (const windowIndex of [1, 2, 3]) {
      for (const agent of buildRoster(input(windowIndex, { windowCount: 3 } as Partial<RosterInput>))) {
        const context = { agentId: agent.agentId, skillPackText: agent.skillPackText, toolCalls: [] };
        expect(
          () => validateAgentContext(context as never),
          `window ${windowIndex} ${agent.agentId}`,
        ).not.toThrow();
      }
    }
  });

  it("teaches the job sizes the loop enforces: each brief's example request is for exactly the required size", () => {
    // The loop refuses a request_quote whose size is not the job's. A brief example that showed any
    // other size would cost the agent a turn on an error — the §4.6-RULE defect — so the size in
    // the example and the size that is enforced are asserted to be the same number.
    const roster = buildRoster(input(1));
    const sizeOf = (text: string, sellerFragment: string): string | undefined =>
      [...text.matchAll(/"request_quote", "args": \{"siu": "([^"]+)"[^}]*"sellerId": "([^"]+)"/g)].find((m) =>
        m[2].includes(sellerFragment),
      )?.[1];
    const orchestrator = find(roster, "ORCHESTRATOR").skillPackText;
    const code = find(roster, "WORKER-CODE").skillPackText;
    expect(sizeOf(orchestrator, "erc8004")).toBe("10");
    expect(sizeOf(code, "erc8004")).toBe("4");
    expect(orchestrator).toContain("a request for any other size is\n    refused");
    expect(code).toContain("a request for any other size is refused, and\n  the rate is yours to propose");
  });

  it("never shows a quantity on a transfer that names a quote, because the loop sets it from the quote", () => {
    // A transfer naming a quote is sized from the quote's price at the print (parity.ts) and any
    // quantity the model supplies is ignored. A brief example that still carried one would teach a
    // number that is silently discarded — a prompt describing a protocol the loop no longer
    // implements (§4.6-RULE). The two-step form WITHOUT a requestId keeps its quantity.
    const roster = buildRoster(input(1));
    let named = 0;
    for (const a of roster) {
      const examples = a.skillPackText.match(/\{"tool": "transfer_claim"[^}]*\}/g) ?? [];
      for (const ex of examples) {
        if (!ex.includes("requestId")) continue;
        named += 1;
        expect(ex, `${a.agentId}: ${ex}`).not.toContain('"quantity"');
      }
    }
    expect(named, "the briefs must still show how to settle a quote with a held claim").toBeGreaterThan(0);
  });

  /**
   * Two F1 deciders facing different menus produce choices that cannot be compared with each
   * other — the comparison would measure the menus. They get the same payment routes.
   */
  it("gives both buyers the same payment menu", () => {
    const roster = buildRoster(input(1));
    const routes = ["pay", "pay_with_claim", "settle_split", "transfer_claim"];
    for (const id of ["ORCHESTRATOR", "WORKER-CODE"]) {
      const tools = find(roster, id).availableTools;
      for (const route of routes) {
        expect(tools, `${id} must be able to settle via ${route}`).toContain(route);
      }
    }
  });

  /**
   * Found live on 2026-09-30, and it would have produced a FAKE result rather than an obvious
   * failure. Phase 5 made WORKER-CODE a buyer and left its wake condition at "inbox", which
   * fires only when something ARRIVES. Buying is an act of initiation, so it could never be
   * woken to make its own purchase: it halted "nothing_to_act_on" in both windows of the
   * debugging run, having bought nothing. Across five runs that reads as "the second decider
   * never chose fSIU" — a number someone would quote. See §4.6r.
   */
  it("wakes both buyers as buyers, so each can initiate its own purchase", () => {
    const roster = buildRoster(input(1));
    for (const id of ["ORCHESTRATOR", "WORKER-CODE"]) {
      expect(find(roster, id).waitsFor, `${id} buys, so it must wake as a buyer`).toBe("buyer");
    }
  });

  /**
   * §4.6a, fourth occurrence. ORCHESTRATOR's brief says attempting to author a gate would be
   * "attempting it blind"; it did so in three runs, spending two of three turns on it in the
   * last. A rule stated in prose with no enforcement at the tool boundary is not a rule.
   */
  it("does not hand ORCHESTRATOR the authoring tool its own brief forbids", () => {
    for (const w of [1, 2, WINDOW_COUNT]) {
      expect(find(buildRoster(input(w)), "ORCHESTRATOR").availableTools).not.toContain("submit_job");
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

import {
  classifyFinalWindow,
  claimsHolderWasNeverOfferedSettlement,
  type WindowOutcome,
} from "./p5-three-window-full-run.js";
import { composeBoard, WAKE_SECTION_TOOLS } from "../loop/full-run.js";
import { validateAgentContext } from "../pack/validate.js";
import type { CapacityEvent, FullRunWindowResult } from "../loop/full-run.js";

function windowResult(overrides: Partial<FullRunWindowResult> = {}): FullRunWindowResult {
  return {
    passed: false,
    gateDelivered: false,
    claimPositions: [],
    paymentMoments: [],
    usdcSettlements: [],
    claimFlows: {},
    testingEngaged: false,
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

/** A SUCCESSFUL dollar purchase, as the turn log records it. The buyer's own `pay` returned;
 *  the capacity event it causes belongs to the SELLER, who is the one committing capacity. */
const succeededDollarTurn = {
  turn: 2,
  promptChars: 0,
  projectedUsd: "0",
  realizedUsd: "0",
  latencyMs: 0,
  parsed: '{"tool":"pay","args":{"requestId":"qr-1"}}',
  toolCall: { name: "pay" as const, ok: true },
};

/** The seller committing capacity for that dollar purchase — attributed to the SELLER. */
const sellerReservation: CapacityEvent = {
  agentId: "WORKER-CODE",
  turn: 2,
  kind: "reserve_for_work",
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

  it("calls a delivered-but-untested final window 'untested', not capacity and not a defect", () => {
    // Testing is bought, and a window in which nobody bought it is recorded as not passed with
    // the reason attached. Against a classifier that ignores the reason, that window falls
    // through to `failed_with_capacity` — "a defect to investigate" — and sends someone looking
    // for an apparatus fault in what is simply a buyer's decision.
    const verdict = classifyFinalWindow([
      outcome(1, ["38000", "32000"], windowResult({ passed: true })),
      outcome(2, ["35000", "32000"], windowResult({ passed: true })),
      outcome(
        3,
        ["22000", "32000"],
        windowResult({
          passed: false,
          gateDelivered: true,
          testingEngaged: false,
          incompleteBecause: "testing_never_purchased",
          turnLogsByAgent: { ORCHESTRATOR: [succeededDollarTurn] },
          capacityEvents: [sellerReservation],
        }),
      ),
    ]);
    expect(verdict.verdict).toBe("untested");
    expect(verdict.detail).toMatch(/nobody paid to have it tested/);
    expect(verdict.detail).toMatch(/not a failure of capacity/);
  });

  it("does not file a window with NO gate under 'untested'", () => {
    // `no_gate` is a different finding — nothing passed its checks at all — and must keep going
    // to the verdicts that look for a cause.
    const verdict = classifyFinalWindow([
      outcome(1, ["38000", "32000"], windowResult({ passed: true })),
      outcome(2, ["35000", "32000"], windowResult({ passed: true })),
      outcome(
        3,
        ["22000", "32000"],
        windowResult({
          passed: false,
          gateDelivered: false,
          incompleteBecause: "no_gate",
          turnLogsByAgent: { ORCHESTRATOR: [succeededDollarTurn] },
          capacityEvents: [sellerReservation],
        }),
      ),
    ]);
    expect(verdict.verdict).not.toBe("untested");
  });

  it("scores a SUCCESSFUL USDC final-window purchase as a purchase, not as scarcity", () => {
    // Run 16, 2026-10-02, and the reason the protocol freeze was called off (spec §4.6af).
    // ORCHESTRATOR paid dollars in window 3 and the payment settled. `purchaseSucceeded` looked
    // only for a mint_claim/pay_with_claim capacity event attributed to the BUYER; a dollar
    // payment produces neither, because its capacity event is the SELLER's reserve_for_work. So
    // the attempt was counted and the success was invisible, `buyerWasShutOut` was true by
    // construction, and the run reported scarcity while the largest issuer held 32,000 against a
    // 10,000 job — a sentence that refutes itself.
    //
    // This matters beyond one label: every F1 run whose buyer chose dollars in the last window
    // would have carried a verdict reading as the instrument failing. A scoring penalty applied
    // to one arm of the comparison by the scoring code.
    const verdict = classifyFinalWindow([
      outcome(1, ["38000", "32000"], windowResult({ passed: true })),
      outcome(2, ["35000", "32000"], windowResult({ passed: true })),
      outcome(
        3,
        ["22000", "32000"],
        windowResult({
          passed: true,
          turnLogsByAgent: { ORCHESTRATOR: [succeededDollarTurn] },
          capacityEvents: [sellerReservation],
        }),
      ),
    ]);
    expect(verdict.verdict).not.toBe("scarcity");
    expect(verdict.verdict).toBe("completed");
  });

  it("still calls it scarcity when the dollar purchase genuinely FAILED", () => {
    // The mirror of the above, and the reason the fix cannot simply count `"pay"` in the turn
    // log: a refused or reverted `pay` is recorded with the same tool name. Only a call that
    // genuinely returned is a purchase.
    const failedDollarTurn = {
      ...succeededDollarTurn,
      parsed: '{"tool":"pay","args":{"requestId":"qr-1"}} -> tool call error: reverted',
      toolCall: { name: "pay" as const, ok: false },
    };
    const verdict = classifyFinalWindow([
      outcome(1, ["24000", "16000"], windowResult({ passed: true })),
      outcome(2, ["14000", "6000"], windowResult({ passed: true })),
      outcome(
        3,
        ["4000", "2000"],
        windowResult({ passed: false, turnLogsByAgent: { ORCHESTRATOR: [failedDollarTurn] } }),
      ),
    ]);
    expect(verdict.verdict).toBe("scarcity");
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

describe("issuers can see what they owe (spec §4.6x, §4.6y)", () => {
  it("gives both issuers list_obligations, in every window", () => {
    // Not seasonal, unlike quote_forward: an issuer owes work in the last window exactly as
    // much as in the first, and the last window is where carried-unsettled claims land.
    for (const w of [1, WINDOW_COUNT]) {
      for (const id of ["ISSUER-A", "ISSUER-B"]) {
        expect(find(buildRoster(input(w)), id).availableTools).toContain("list_obligations");
      }
    }
  });

  it("does not give it to buyers — it answers about the caller's own bond, which they have none of", () => {
    for (const id of ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT"]) {
      expect(find(buildRoster(input(1)), id).availableTools).not.toContain("list_obligations");
    }
  });

  it("shows the issuer worked syntax for it, as it does for every other tool (§4.6q)", () => {
    // §4.6q: a tool demonstrated in prose while its alternatives carry copy-pasteable JSON is
    // not a neutral offer. This one takes no arguments, so the example must still show that.
    const brief = find(buildRoster(input(1)), "ISSUER-A").skillPackText;
    expect(brief).toContain('{"tool": "list_obligations", "args": {}}');
  });

  it("states it is a read that changes nothing, and that it costs a turn", () => {
    const brief = find(buildRoster(input(1)), "ISSUER-B").skillPackText;
    expect(brief).toMatch(/changes nothing/);
    expect(brief).toMatch(/costs a turn/);
  });
});

describe("a holder can check whether what it paid for arrived (spec §4.6w)", () => {
  it("gives check_delivery to every agent that can be paid in fSIU, in every window", () => {
    for (const w of [1, 2, WINDOW_COUNT]) {
      for (const id of ["WORKER-CODE", "WORKER-EXTRACT"]) {
        expect(
          find(buildRoster(input(w)), id).availableTools,
          `${id} can be paid in fSIU and must be able to check it was served`,
        ).toContain("check_delivery");
      }
    }
  });

  it("shows it with worked syntax beside every other thing a holder can do (§4.6q)", () => {
    // The claim-holder section already gives redeem / transfer / pay_with_claim copy-pasteable
    // JSON. A verification option described only in prose would be the steer §4.6q warns about.
    const brief = find(buildRoster(input(1)), "WORKER-CODE").skillPackText;
    expect(brief).toContain('{"tool": "check_delivery", "args": {}}');
    expect(brief).toContain('{"tool": "redeem_claim"');
    expect(brief).toContain('{"tool": "pay_with_claim"');
  });

  it("still names no preferred asset — the new tools must not tilt the F1 question", () => {
    // F1 asks which asset agents use when nothing recommends either. Two tools added on the
    // fSIU side could read as encouragement, so the existing neutrality guard must still hold.
    for (const id of ["ORCHESTRATOR", "WORKER-CODE", "ISSUER-A", "ISSUER-B"]) {
      const brief = find(buildRoster(input(1)), id).skillPackText;
      expect(brief).not.toMatch(/\b(prefer|better|recommend|should use|best)\b.{0,40}\b(fSIU|USDC|claim|dollar)\b/i);
    }
  });
});

describe("the dollar route gives its capacity back too (spec §4.6z)", () => {
  const outcome = (windowIndex: number, events: { kind: string; quoteHash?: string }[]) =>
    ({
      windowIndex,
      result: { capacityEvents: events },
      headroomBefore: [],
      headroomAfter: [],
    }) as unknown as Parameters<typeof reservedQuoteHashes>[0][number];

  it("collects every reserve_for_work across all windows, which nothing did before", () => {
    // The leak was never in releaseReservation — the contract has recorded the escrow's expiry
    // as a deadline and allowed anyone to release past it all along. settle_escrow called it on
    // the HAPPY path only, so a window that failed left its reservation standing forever. Run
    // 13 window 1 reserved 10,000 mSIU, WORKER-CODE then emitted nothing, and that capacity was
    // still consumed a day later.
    expect(
      reservedQuoteHashes([
        outcome(1, [{ kind: "reserve_for_work", quoteHash: "0xaa" }, { kind: "pay_with_claim" }]),
        outcome(2, [{ kind: "redeem_claim" }]),
        outcome(3, [{ kind: "reserve_for_work", quoteHash: "0xbb" }]),
      ]),
    ).toEqual(["0xaa", "0xbb"]);
  });

  it("ignores every other capacity event — only reservations hold headroom this way", () => {
    // A claim that is minted and abandoned expires at window close and returns its headroom.
    // That asymmetry between the two routes is the F1 confound, and it is why only
    // reserve_for_work needs sweeping.
    expect(
      reservedQuoteHashes([
        outcome(1, [
          { kind: "mint_claim", quoteHash: "0xcc" },
          { kind: "pay_with_claim", quoteHash: "0xdd" },
          { kind: "serve_redemption", quoteHash: "0xee" },
          { kind: "settle_split", quoteHash: "0xff" },
        ]),
      ]),
    ).toEqual([]);
  });

  it("returns nothing for a run that never used the dollar route", () => {
    expect(reservedQuoteHashes([outcome(1, [{ kind: "pay_with_claim" }])])).toEqual([]);
  });

  it("drops a reserve_for_work with no quote hash rather than sweeping undefined", () => {
    expect(reservedQuoteHashes([outcome(1, [{ kind: "reserve_for_work" }])])).toEqual([]);
  });
});

describe("the run's schedule is shown as fact, never as advice (spec §4.6ad, §4.6q)", () => {
  const BOUNDS = {
    1: { from: 1_800_000_000n, to: 1_800_002_400n },
    2: { from: 1_800_002_400n, to: 1_800_004_800n },
    3: { from: 1_800_004_800n, to: 1_800_007_200n },
  };

  it("states each remaining window's job, size and opening time", () => {
    const text = scheduleFacts(1, BOUNDS, 3);
    expect(text).toContain("window 2:");
    expect(text).toContain("window 3:");
    expect(text).toContain("10000 mSIU");
    expect(text).toMatch(/opens 2027-01-15T/);
  });

  it("lists EVERY purchase the run makes — WORKER-CODE's testing purchase as well as the gate", () => {
    // "What follows is the whole schedule — no other work is bought in this run" was false for as long
    // as the schedule named only gate authoring: WORKER-CODE buys 4 SIU of testing every window, and D4
    // makes that purchase a condition of `passed`. A brief describing a world the agent is not in.
    const text = scheduleFacts(1, BOUNDS, 3);
    for (const p of RUN_PURCHASES) {
      expect(text, p.job).toContain(p.job);
      expect(text, p.job).toContain(`${p.milliSiu} mSIU`);
      expect(text, p.job).toContain(`bought by ${p.buyer} from ${p.seller}`);
    }
    // Each remaining window lists both purchases.
    for (const w of [2, 3]) {
      const block = text.slice(text.indexOf(`window ${w}:`));
      expect(block.split("\n").slice(0, 3).join("\n")).toContain("adversarial testing");
    }
  });

  it("is built from the same list the loop enforces, so the two cannot disagree", () => {
    // The schedule once described the run's purchases from one place and the loop enforced job sizes
    // from another. One list now feeds both; this holds the enforcement to it.
    const ids = { "WORKER-CODE": "erc8004:0xcode", "WORKER-EXTRACT": "erc8004:0xextract" };
    const enforced = requiredQuoteSizes(ids);
    for (const p of RUN_PURCHASES) {
      const expected = String(p.milliSiu / 1000n);
      expect(enforced[ids[p.seller as keyof typeof ids]], p.job).toBe(expected);
    }
    expect(Object.keys(enforced).length).toBe(RUN_PURCHASES.length);
  });

  it("names no window that has already opened — a schedule is what is still ahead", () => {
    const text = scheduleFacts(2, BOUNDS, 3);
    expect(text).toContain("window 3:");
    expect(text).not.toContain("window 1:");
    expect(text).not.toContain("window 2:");
  });

  it("says plainly there is nothing ahead in the last window, rather than going silent", () => {
    const text = scheduleFacts(3, BOUNDS, 3);
    expect(text).toMatch(/the last one/);
    // True by construction: the window count is fixed before the run starts.
    expect(text).toMatch(/No window opens after it/);
  });

  it("claims no exclusivity about work it cannot enforce — only what the run itself fixes", () => {
    // "No other work is bought in this run" is a claim about every quote any agent might ever
    // request, and nothing stops a buyer requesting another one: `request_quote` constrains the
    // size a given SELLER's job may be, not which pairs trade or how often. A schedule is true of
    // what the run schedules; it says nothing about what agents might also do. The window count
    // and the opening times are fixed before the run, so those may be stated flatly.
    const claims = [
      /no\s+other\s+work/i,
      /no\s+further\s+work/i,
      /nothing\s+else\s+(is\s+)?(bought|purchased)/i,
      /every\s+purchase\s+the\s+run\s+makes/i,
      /the\s+whole\s+schedule/i,
      /only\s+work/i,
    ];
    for (const count of [1, 2, 3, 5]) {
      const bounds = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          i + 1,
          { from: BigInt(1_800_000_000 + i * 2400), to: BigInt(1_800_000_000 + (i + 1) * 2400) },
        ]),
      );
      for (let w = 1; w <= count; w++) {
        const text = scheduleFacts(w, bounds, count);
        for (const claim of claims) expect(text, `window ${w} of ${count}`).not.toMatch(claim);
      }
    }
  });

  it("no brief claims exclusivity about work, in any window", () => {
    // The same pin over the briefs as they are actually built, not only the helper that renders one
    // section of them, so a claim added anywhere else in a brief is caught too.
    const claims = [/no\s+other\s+work/i, /no\s+further\s+work/i, /every\s+purchase\s+the\s+run\s+makes/i];
    for (const w of [1, 2, 3]) {
      for (const id of ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT"]) {
        const brief = find(buildRoster(input(w, { windowBoundsByIndex: BOUNDS })), id).skillPackText;
        for (const claim of claims) expect(brief, `${id}, window ${w}`).not.toMatch(claim);
      }
    }
  });

  it("contains no steer — a buyer could read it and rationally do nothing", () => {
    // The test §4.6q asks of any new surface. "You will need capacity later", "consider
    // reserving", "holding may be advantageous" are advice; a schedule is not.
    for (const w of [1, 2, 3]) {
      const text = scheduleFacts(w, BOUNDS, 3).toLowerCase();
      for (const steer of [
        "you will need", "consider", "advantageous", "should", "recommend", "worth",
        "ahead of time", "secure", "reserve now", "don't miss", "before it runs out",
      ]) {
        expect(text, `"${steer}" is advice, not a schedule`).not.toContain(steer);
      }
    }
  });

  it("lists only work this run actually buys", () => {
    // A schedule naming work that never arrives describes a world the agent is not in, and
    // capacity reserved against it is stranded on false information.
    const text = scheduleFacts(1, BOUNDS, 3).toLowerCase();
    for (const absent of ["atc", "replay", "fingerprint", "extract-class", "settlement sdk"]) {
      expect(text).not.toContain(absent);
    }
  });

  it("reaches every buyer's brief, not just one", () => {
    for (const id of ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT"]) {
      const brief = find(buildRoster(input(1, { windowBoundsByIndex: BOUNDS })), id).skillPackText;
      expect(brief, `${id} must see the schedule`).toContain("THE REST OF THIS RUN");
    }
  });

  it("leaves the capacity facts standing beside it — scarcity needs both", () => {
    const brief = find(buildRoster(input(1, { windowBoundsByIndex: BOUNDS })), "ORCHESTRATOR").skillPackText;
    expect(brief).toMatch(/routed to a SINGLE issuer/i);
    expect(brief).toMatch(/Capacity they take is gone before you see it/);
  });
});

describe("the schedule renders the REAL window bounds, not anything stale", () => {
  it("prints exactly the computed bounds, for any run start", () => {
    // The defect this whole change exists to avoid is telling an agent something false. A
    // schedule showing dates that are not the run's own would be precisely that, and it would
    // be invisible — the text looks right whatever numbers are in it.
    const WINDOW_SECONDS = 2400n;
    for (const runStart of [1_790_000_000n, 1_800_000_000n, BigInt(Math.floor(Date.now() / 1000))]) {
      const bounds: Record<number, { from: bigint; to: bigint }> = {};
      for (let i = 1; i <= 3; i++) {
        bounds[i] = {
          from: runStart + BigInt(i - 1) * WINDOW_SECONDS,
          to: runStart + BigInt(i) * WINDOW_SECONDS,
        };
      }
      const text = scheduleFacts(1, bounds, 3);
      for (const i of [2, 3]) {
        const expected = new Date(Number(bounds[i].from) * 1000).toISOString();
        expect(text, `window ${i} must show its own computed opening time`).toContain(expected);
      }
      // And nothing from a window that is not in this run's bounds.
      expect(text).not.toContain(new Date(Number(runStart - WINDOW_SECONDS) * 1000).toISOString());
    }
  });

  it("moves with the run start — the same window index renders different times for different runs", () => {
    // Catches a hard-coded or cached schedule, which would read as correct in every test that
    // only checked the shape of the text.
    const mk = (start: bigint) => ({
      1: { from: start, to: start + 2400n },
      2: { from: start + 2400n, to: start + 4800n },
    });
    const a = scheduleFacts(1, mk(1_790_000_000n), 2);
    const b = scheduleFacts(1, mk(1_800_000_000n), 2);
    expect(a).not.toEqual(b);
  });
});

describe("a scripted seat can read the brief the real roster is given", () => {
  // The scripts place a prompt by the run-shape facts every brief carries, and a holder presents with
  // the task-spec hash its own brief states. If either moves out of the brief, a scripted run stalls
  // without a word — so the dependency is held here, against the briefs as they are really built.
  it("carries the window marker in every seat's brief, for every window", () => {
    for (const w of [1, 2, 3]) {
      for (const seat of AGENTS) {
        const brief = find(buildRoster(input(w)), seat).skillPackText;
        expect(windowOf(brief), `${seat}, window ${w}`).toBe(w);
      }
    }
  });

  it("carries the task-spec hash WORKER-CODE presents a claim with", () => {
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const brief = find(buildRoster(input(1, { taskSpecHash: hash })), "WORKER-CODE").skillPackText;
    expect(taskSpecHashIn(brief)).toBe(hash);
  });
});
