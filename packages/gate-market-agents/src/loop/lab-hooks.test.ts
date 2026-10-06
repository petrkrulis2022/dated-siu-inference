import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import type { GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import type { RunnerDeps } from "../deps.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { AGENT_IDS, erc8004IdFor, type AgentId } from "../identity/resolve.js";
import { composeBoard, runFullRunWindow, WAKE_SECTION_TOOLS, type JobEnvelope, type RosterAgentConfig } from "./full-run.js";
import type { LabHooks, LabToolEvent } from "./lab-hooks.js";
import type { ToolName } from "../tools/index.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";

// Anvil's first two default accounts: real keys, so `request_quote` and `issue_quote` run for real,
// and no chain is needed because neither tool touches one.
const KEYS: Record<string, `0x${string}`> = {
  ORCHESTRATOR: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "WORKER-CODE": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
};
const PRICES = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" };
const noGate = async (): Promise<GateHardeningResult> => {
  throw new Error("a lab run has no gate");
};

function fakeDeps(): RunnerDeps {
  return {
    chainReader: {
      usdcBalance: async () => 0n,
      claimBalance: async () => 0n,
      headroom: async () => 0n,
      issuanceLimit: async () => 0n,
      claimWindow: async () => ({ windowFrom: 0n, windowTo: 0n }),
      currentBlockTimestamp: async () => 0n,
      escrowState: async () => ({ status: "none" as const, buyer: `0x${"00".repeat(20)}`, seller: `0x${"00".repeat(20)}`, maxAmountMinorUnits: 0n, expiryUnix: 0n }),
      reservation: async () => ({ exists: false, released: false, issuer: `0x${"00".repeat(20)}`, classId: `0x${"00".repeat(32)}`, quantityMilliSiu: 0n, deadlineUnix: 0n }),
      issuersForClass: async () => [],
    },
    deployment: { network: { name: "test", chainId: 0 }, usdc: { address: "0x0" }, capacityBond: { address: "0x0" }, claimRouter: { address: "0x0" }, workClaim: { address: "0x0" } },
    escrowAddress: "0x0",
    runGateHardeningChecks: noGate,
    loadPrint: async () => ({ print_id: "lab" }) as unknown as Print,
    isReconciled: async () => false,
  } as unknown as RunnerDeps;
}

const JOB: JobEnvelope = {
  jobId: "lab-test",
  taskClass: "extract",
  originalGate: { taskClass: "extract", source: "" },
  referenceInstance: { taskClass: "extract", files: {} },
  knownGoodSubmission: { files: {} },
  adversarialSubmissions: [],
  heldOutInstances: [{ referenceInstance: { taskClass: "extract", files: {} }, knownGoodSubmission: { files: {} }, adversarialSubmissions: [] }],
};
const MANIFEST: RunManifest = { benchVersion: "0.0.0", packVersion: "lab@0.0.0", agentConfigs: {}, seed: "lab-test" };

const respond = (intent: unknown): AdapterResult => ({
  text: JSON.stringify(intent),
  usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
  latency_ms: 1,
  raw: {},
  deviations: [],
});

describe("runFullRunWindow with the currency lab's hooks", () => {
  let runsRoot: string;
  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "lab-hooks-"));
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const idOf = (seat: string): string => erc8004IdFor(privateKeyToAccount(KEYS[seat]).address);
  const cfg = (agentId: AgentId, adapter: Adapter, tools: readonly ToolName[], waitsFor: "inbox" | "buyer" = "inbox"): RosterAgentConfig => ({
    agentId,
    adapter,
    modelString: "test",
    prices: PRICES,
    // The context validator stays on: every brief carries the canonical asset text verbatim.
    skillPackText: `${CANONICAL_ASSET_DESCRIPTION}\n\nLAB BRIEF`,
    availableTools: tools,
    privateKeyHex: KEYS[agentId],
    address: privateKeyToAccount(KEYS[agentId]).address,
    erc8004Id: idOf(agentId),
    rpcUrl: "http://127.0.0.1:1",
    maxOutputTokens: 1000,
    temperature: 0,
    provider: "test",
    waitsFor,
  });
  const budget = () =>
    new ExperimentBudget({
      ceiling: new BudgetCeiling(
        Object.fromEntries(AGENT_IDS.map((id) => [id, { maxUsdcSpend: "0", maxInferenceTurns: 40, maxInferenceUsd: "5" }])) as never,
      ),
      runCapUsd: "30",
      experimentCapUsd: "150",
      ledgerPath: path.join(runsRoot, "ledger.json"),
    });
  const run = (roster: RosterAgentConfig[], lab: LabHooks, runId: string) =>
    runFullRunWindow({
      windowId: "w-lab",
      roster,
      job: JOB,
      maxTurnsPerAgent: 12,
      budget: budget(),
      deps: fakeDeps(),
      runsRoot,
      runId,
      manifest: MANIFEST,
      lab,
    });

  const REQUEST = (rate: string) => ({
    tool: "request_quote",
    args: {
      siu: "1", model: "m", rateUsdPerSiu: rate, indexVersion: "SIU-2026a", printId: "lab", printHash: "0x00",
      sellerId: idOf("WORKER-CODE"), chain: "base-sepolia", expiresInSeconds: 600, pattern: "fixed",
    },
  });

  it("shows the lab's text, vets each call's arguments, and reports what each call did", async () => {
    const events: LabToolEvent[] = [];
    const guarded: { agent: AgentId; tool: ToolName }[] = [];
    let aOpen = true;
    const lab: LabHooks = {
      infoTextFor: (a) => `LAB-INFO-FOR-${a}`,
      actionTextFor: (a) => (a === "ORCHESTRATOR" && aOpen ? "LAB-ACTION-A" : ""),
      guard: (agent, tool, args) => {
        guarded.push({ agent, tool });
        return tool === "request_quote" && (args as { rateUsdPerSiu?: string }).rateUsdPerSiu !== "0.0017244" ? "LAB-REFUSAL: wrong price" : null;
      },
      afterToolCall: async (e) => {
        events.push(e);
        if (e.tool === "request_quote") aOpen = false;
      },
      advanceRound: async () => false,
    };
    const aPrompts: string[] = [];
    let aCall = 0;
    const adapterA: Adapter = async (_m, prompt) => {
      aPrompts.push(prompt);
      aCall++;
      if (aCall === 1) return respond(REQUEST("0.001"));
      if (aCall === 2) return respond(REQUEST("0.0017244"));
      return respond({ done: true, summary: "asked" });
    };
    let bCall = 0;
    const adapterB: Adapter = async (_m, prompt) => {
      bCall++;
      const id = prompt.match(/(qr-\d+)/)?.[1];
      return id && bCall === 1 ? respond({ tool: "issue_quote", args: { requestId: id } }) : respond({ done: true, summary: "answered" });
    };
    const tools: ToolName[] = ["request_quote", "issue_quote", "get_balances"];
    const result = await run([cfg("ORCHESTRATOR", adapterA, tools), cfg("WORKER-CODE", adapterB, tools)], lab, "run-lab-1");

    expect(aPrompts[0]).toContain("LAB-INFO-FOR-ORCHESTRATOR");
    expect(aPrompts[0]).toContain("LAB-ACTION-A");
    expect(aPrompts[1], "the refusal reaches the agent as its call's error").toContain("LAB-REFUSAL: wrong price");
    expect(guarded.filter((g) => g.agent === "ORCHESTRATOR").map((g) => g.tool)).toEqual(["request_quote", "request_quote"]);
    const asked = events.filter((e) => e.tool === "request_quote");
    expect(asked, "the refused call is not an event; only the accepted one is").toHaveLength(1);
    expect(asked[0]).toMatchObject({ agentId: "ORCHESTRATOR", requestId: "qr-1" });
    const answered = events.find((e) => e.tool === "issue_quote");
    expect(answered).toMatchObject({ agentId: "WORKER-CODE", intentArgs: { requestId: "qr-1" } });
    expect(result.labErrors).toEqual([]);
  });

  it("opens the next round where a window would have ended, and wakes an agent the new round concerns", async () => {
    let round = 1;
    let advanced = 0;
    const lab: LabHooks = {
      infoTextFor: () => "",
      actionTextFor: (a) => (a === "ORCHESTRATOR" ? `ACTION-ROUND-${round}` : ""),
      guard: () => null,
      afterToolCall: async () => {},
      advanceRound: async () => {
        advanced++;
        if (round >= 2) return false;
        round++;
        return true;
      },
    };
    const aPrompts: string[] = [];
    let aCall = 0;
    const adapterA: Adapter = async (_m, prompt) => {
      aPrompts.push(prompt);
      aCall++;
      return aCall === 1 ? respond({ wait: true }) : respond({ done: true, summary: "round two seen" });
    };
    const adapterB: Adapter = async () => respond({ done: true, summary: "nothing" });
    const tools: ToolName[] = ["request_quote", "issue_quote"];
    const result = await run([cfg("ORCHESTRATOR", adapterA, tools), cfg("WORKER-CODE", adapterB, tools)], lab, "run-lab-2");

    expect(aPrompts).toHaveLength(2);
    expect(aPrompts[0]).toContain("ACTION-ROUND-1");
    expect(aPrompts[1], "woken by the new round's text").toContain("ACTION-ROUND-2");
    expect(aPrompts[1]).not.toContain("ACTION-ROUND-1");
    expect(advanced, "once to open round 2, once to learn there is no round 3").toBe(2);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("voluntary_stop");
  });

  it("records a failure of the lab's own bookkeeping as the harness's, and does not stop the run", async () => {
    const lab: LabHooks = {
      infoTextFor: () => "",
      actionTextFor: () => "",
      guard: () => null,
      afterToolCall: async (e) => {
        if (e.tool === "request_quote") throw new Error("operator out of funds");
      },
      advanceRound: async () => false,
    };
    let aCall = 0;
    const adapterA: Adapter = async () => (++aCall === 1 ? respond(REQUEST("0.0017244")) : respond({ done: true, summary: "x" }));
    const adapterB: Adapter = async () => respond({ done: true, summary: "x" });
    const result = await run([cfg("ORCHESTRATOR", adapterA, ["request_quote"], "buyer"), cfg("WORKER-CODE", adapterB, ["issue_quote"])], lab, "run-lab-3");
    expect(result.labErrors).toEqual([{ agentId: "ORCHESTRATOR", turn: 1, tool: "request_quote", message: "operator out of funds" }]);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("voluntary_stop");
    // The agent was not told its call failed: it succeeded, and what went wrong was the operator's.
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].toolCall).toEqual({ name: "request_quote", ok: true });
  });

  it("knows the opening endowment as held, not received and not as flows", async () => {
    const lab: LabHooks = { infoTextFor: () => "", actionTextFor: () => "", guard: () => null, afterToolCall: async () => {}, advanceRound: async () => false };
    const adapter: Adapter = async () => respond({ done: true, summary: "x" });
    const result = await runFullRunWindow({
      windowId: "w-opening",
      roster: [cfg("ORCHESTRATOR", adapter, ["request_quote"], "buyer"), cfg("WORKER-CODE", adapter, ["issue_quote"])],
      job: JOB,
      maxTurnsPerAgent: 12,
      budget: budget(),
      deps: fakeDeps(),
      runsRoot,
      runId: "run-opening",
      manifest: MANIFEST,
      lab,
      openingClaims: [
        { agentId: "ORCHESTRATOR", tokenId: "777", quantityMilliSiu: "2000", issuerAgentId: "ISSUER-B" },
        { agentId: "WORKER-CODE", tokenId: "777", quantityMilliSiu: "2000", issuerAgentId: "ISSUER-B" },
      ],
    });
    expect(result.claimPositions).toEqual([
      { tokenId: "777", holder: "ORCHESTRATOR", issuer: "ISSUER-B", quantity: "2000", presented: false },
      { tokenId: "777", holder: "WORKER-CODE", issuer: "ISSUER-B", quantity: "2000", presented: false },
    ]);
    // Neither a payment received nor an agent's own mint: the endowment is the operator's, and the report states it.
    for (const seat of ["ORCHESTRATOR", "WORKER-CODE"]) {
      expect(result.claimFlows[seat]).toMatchObject({ receivedMilliSiu: "0", mintedMilliSiu: "0", transferredOutKeyedMilliSiu: "0" });
    }
  });

  describe("the names the lab gives its tools", () => {
    // `ask_for_quote` stands in for a renamed payment tool: request_quote needs no chain, so the seam can be tested whole.
    const NAMES = { request_quote: "ask_for_quote" } as const;
    const hooks = (events: LabToolEvent[] = []): LabHooks => ({
      infoTextFor: () => "",
      actionTextFor: () => "",
      guard: async () => null,
      afterToolCall: async (e) => void events.push(e),
      advanceRound: async () => false,
      toolDescription: (t) => (t === "request_quote" ? "ask_for_quote(siu, rateUsdPerSiu, sellerId, ...) -> asks a seller for a quote." : undefined),
      resolveCall: (_agent, name, args) => {
        if (name === "request_quote") return { refuse: "request_quote is not one of your tools." };
        if (name === NAMES.request_quote) return { tool: "request_quote", args };
        return undefined;
      },
      rewriteText: (t) => t.replace(/request_quote/g, "ask_for_quote"),
    });
    const runWith = (adapter: Adapter, lab: LabHooks, runId: string) =>
      run([cfg("ORCHESTRATOR", adapter, ["request_quote"], "buyer"), cfg("WORKER-CODE", async () => respond({ done: true, summary: "x" }), ["issue_quote"])], lab, runId);

    it("shows the description the lab gives a tool in place of the loop's own", async () => {
      const prompts: string[] = [];
      await runWith(async (_m, p) => (prompts.push(p), respond({ done: true, summary: "x" })), hooks(), "run-names-1");
      expect(prompts[0]).toContain("ask_for_quote(siu, rateUsdPerSiu, sellerId, ...) -> asks a seller for a quote.");
      expect(prompts[0]).not.toContain("request_quote(siu, model, rateUsdPerSiu");
    });

    it("runs the loop's tool for a call by the lab's name, and shows the history as the agent made the call", async () => {
      const prompts: string[] = [];
      const events: LabToolEvent[] = [];
      let n = 0;
      const adapter: Adapter = async (_m, p) => {
        prompts.push(p);
        return ++n === 1 ? respond({ ...REQUEST("0.0017244"), tool: "ask_for_quote" }) : respond({ done: true, summary: "x" });
      };
      const result = await runWith(adapter, hooks(events), "run-names-2");
      // The loop ran request_quote, and told the lab so under that name.
      expect(events.map((e) => e.tool)).toEqual(["request_quote"]);
      expect(result.turnLogsByAgent.ORCHESTRATOR[0].toolCall).toEqual({ name: "request_quote", ok: true });
      // The agent's next prompt shows the call it made, by the name it used, and never the loop's.
      expect(prompts[1]).toContain("Turn 1 — called ask_for_quote(");
      expect(prompts[1]).not.toContain("called request_quote(");
    });

    it("refuses the loop's own name for a renamed tool, in the agent's next prompt, in the lab's words", async () => {
      const prompts: string[] = [];
      let n = 0;
      const adapter: Adapter = async (_m, p) => {
        prompts.push(p);
        return ++n === 1 ? respond(REQUEST("0.0017244")) : respond({ done: true, summary: "x" });
      };
      const events: LabToolEvent[] = [];
      await runWith(adapter, hooks(events), "run-names-3");
      expect(events).toEqual([]); // nothing ran
      expect(prompts[1]).toContain("Turn 1 — called request_quote(");
      expect(prompts[1]).toContain('"error":"request_quote is not one of your tools."');
    });

    it("writes the loop's tool name in an error sentence as the agent knows it", async () => {
      const prompts: string[] = [];
      let n = 0;
      const adapter: Adapter = async (_m, p) => {
        prompts.push(p);
        // pattern "estimate" with no siuMax: the tool's own error names request_quote.
        return ++n === 1
          ? respond({ tool: "ask_for_quote", args: { siu: "1", model: "m", rateUsdPerSiu: "0.001", indexVersion: "i", printId: "p", printHash: "0x0", sellerId: "erc8004:0xabc", chain: "base-sepolia", expiresInSeconds: 60, pattern: "estimate" } })
          : respond({ done: true, summary: "x" });
      };
      await runWith(adapter, hooks(), "run-names-4");
      expect(prompts[1]).toContain("Turn 1 — called ask_for_quote(");
      expect(prompts[1]).toContain('ask_for_quote: pattern \\"estimate\\" requires siuMax');
      expect(prompts[1]).not.toContain("request_quote: pattern");
    });
  });

  it("refuses a call by a guard that has to read the chain first, and the agent is told", async () => {
    const prompts: string[] = [];
    let n = 0;
    const adapter: Adapter = async (_m, p) => {
      prompts.push(p);
      return ++n === 1 ? respond(REQUEST("0.0017244")) : respond({ done: true, summary: "x" });
    };
    const lab: LabHooks = {
      infoTextFor: () => "",
      actionTextFor: () => "",
      // Asynchronous: it has to read a balance before it can say no.
      guard: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "This payment costs 1700 USDC minor units; the wallet holds 100 USDC minor units.";
      },
      afterToolCall: async () => {},
      advanceRound: async () => false,
    };
    await run([cfg("ORCHESTRATOR", adapter, ["request_quote"], "buyer"), cfg("WORKER-CODE", async () => respond({ done: true, summary: "x" }), ["issue_quote"])], lab, "run-async-guard");
    expect(prompts[1]).toContain("This payment costs 1700 USDC minor units; the wallet holds 100 USDC minor units.");
  });

  it("does nothing different when no hooks are given", async () => {
    let aCall = 0;
    const adapterA: Adapter = async () => (++aCall === 1 ? respond(REQUEST("0.0017244")) : respond({ done: true, summary: "x" }));
    const adapterB: Adapter = async () => respond({ done: true, summary: "x" });
    const result = await runFullRunWindow({
      windowId: "w-nolab",
      roster: [cfg("ORCHESTRATOR", adapterA, ["request_quote"], "buyer"), cfg("WORKER-CODE", adapterB, ["issue_quote"])],
      job: JOB,
      maxTurnsPerAgent: 12,
      budget: budget(),
      deps: fakeDeps(),
      runsRoot,
      runId: "run-nolab",
      manifest: MANIFEST,
    });
    expect(result.labErrors).toEqual([]);
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].toolCall?.ok).toBe(true);
  });
});

describe("an agent is told when a call it made failed", () => {
  // Found by the lab-hooks test above: the history an agent reads was built from SUCCESSFUL calls only,
  // so a refused or reverted call left no trace in its next prompt. The code's own comment claimed the
  // agent "sees this in its tool-call history exactly like any other tool error"; no agent ever has.
  let runsRoot: string;
  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "failed-call-"));
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const roster = (adapter: Adapter): RosterAgentConfig[] => {
    const account = privateKeyToAccount(KEYS.ORCHESTRATOR);
    return [
      {
        agentId: "ORCHESTRATOR",
        adapter,
        modelString: "test",
        prices: PRICES,
        skillPackText: `${CANONICAL_ASSET_DESCRIPTION}\n\nBRIEF`,
        availableTools: ["request_quote", "issue_quote"],
        privateKeyHex: KEYS.ORCHESTRATOR,
        address: account.address,
        erc8004Id: erc8004IdFor(account.address),
        rpcUrl: "http://127.0.0.1:1",
        maxOutputTokens: 1000,
        temperature: 0,
        provider: "test",
        waitsFor: "buyer",
      },
    ];
  };
  const run = (adapter: Adapter, id: string) =>
    runFullRunWindow({
      windowId: "w-fail",
      roster: roster(adapter),
      job: JOB,
      maxTurnsPerAgent: 6,
      budget: new ExperimentBudget({
        ceiling: new BudgetCeiling(Object.fromEntries(AGENT_IDS.map((x) => [x, { maxUsdcSpend: "0", maxInferenceTurns: 40, maxInferenceUsd: "5" }])) as never),
        runCapUsd: "30",
        experimentCapUsd: "150",
        ledgerPath: path.join(runsRoot, "ledger.json"),
      }),
      deps: fakeDeps(),
      runsRoot,
      runId: id,
      manifest: MANIFEST,
    });

  it("shows a call that threw while running, with the sentence, in the very next prompt", async () => {
    const prompts: string[] = [];
    let n = 0;
    const adapter: Adapter = async (_m, prompt) => {
      prompts.push(prompt);
      return ++n === 1
        ? respond({ tool: "request_quote", args: { siu: "1", model: "m", rateUsdPerSiu: "0.001", indexVersion: "i", printId: "p", printHash: "0x0", sellerId: "erc8004:0xabc", chain: "base-sepolia", expiresInSeconds: 60, pattern: "estimate" } })
        : respond({ done: true, summary: "x" });
    };
    await run(adapter, "run-fail-1");
    expect(prompts[0]).toContain("(no turns yet");
    expect(prompts[1]).toContain("Turn 1 — called request_quote(");
    expect(prompts[1]).toContain('"error":"');
    expect(prompts[1]).toContain('pattern \\"estimate\\" requires siuMax');
    expect(prompts[1]).not.toContain("(no turns yet");
  });

  it("shows a call whose arguments were refused, and keeps successes and failures in the order they happened", async () => {
    const prompts: string[] = [];
    let n = 0;
    const adapter: Adapter = async (_m, prompt) => {
      prompts.push(prompt);
      n++;
      if (n === 1) return respond({ tool: "issue_quote", args: { requestId: "qr-404" } }); // no such request: refused
      if (n === 2) return respond({ tool: "request_quote", args: { siu: "1", model: "m", rateUsdPerSiu: "0.001", indexVersion: "i", printId: "p", printHash: "0x0", sellerId: "erc8004:0xabc", chain: "base-sepolia", expiresInSeconds: 60, pattern: "fixed" } });
      return respond({ done: true, summary: "x" });
    };
    await run(adapter, "run-fail-2");
    expect(prompts[1]).toContain("Turn 1 — called issue_quote(");
    expect(prompts[1]).toContain("no open request");
    const last = prompts[2];
    expect(last.indexOf("Turn 1 — called issue_quote")).toBeGreaterThan(-1);
    expect(last.indexOf("Turn 2 — called request_quote")).toBeGreaterThan(last.indexOf("Turn 1 — called issue_quote"));
  });
});

describe("composeBoard — the lab's two sections", () => {
  const base = {
    marketBoardText: "", redemptionText: "", transferText: "", deliveryOwedText: "", settleableText: "", servedText: "",
    servedWasFailure: false, unservedText: "", lapsingText: "", deliveredGateText: "", gateDefeatedText: "", forwardInvitation: "",
  };

  it("shows the information section and never wakes on it", () => {
    const b = composeBoard({ ...base, labInfoText: "THE LAB" }, ["request_quote", "deliver_job"]);
    expect(b.shown).toBe("THE LAB");
    expect(b.wakeKey).toBe("");
  });

  it("wakes on the action section for an agent that holds a tool to act with, and only for it", () => {
    const text = "OPEN FOR YOU NOW";
    expect(composeBoard({ ...base, labActionText: text }, ["deliver_job"]).wakeKey).toBe(text);
    expect(composeBoard({ ...base, labActionText: text }, ["request_quote"]).wakeKey).toBe(text);
    const cannotAct = composeBoard({ ...base, labActionText: text }, ["get_balances", "get_print"]);
    expect(cannotAct.shown).toBe(text);
    expect(cannotAct.wakeKey, "shown, but it cannot spend the turn of an agent that cannot act on it").toBe("");
  });

  it("lists only tools that exist", () => {
    for (const t of WAKE_SECTION_TOOLS.labActionText) expect(typeof t).toBe("string");
    expect(WAKE_SECTION_TOOLS.labActionText).toContain("deliver_job");
  });
});
