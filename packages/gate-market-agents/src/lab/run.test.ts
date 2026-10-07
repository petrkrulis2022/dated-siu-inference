import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import type { GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import type { RunnerDeps } from "../deps.js";
import { AGENT_IDS, type AgentId } from "../identity/resolve.js";
import type { MintContext } from "../loop/full-run.js";
import { DEFAULT_PARAMS, ISSUER_SEAT, LAB_TRADERS, SEAT_OF, type TraderLabel } from "./economy.js";
import { referenceExecutor } from "./jobs.js";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import type { EndowmentMint, LabChain, Signer } from "./operator.js";
import { setRevertRetryPolicy, writeAndConfirm } from "../chain/write.js";
import type { ChainClients } from "@touchstone/agents";
import { BaseError, ContractFunctionRevertedError, parseAbi } from "viem";
import { LaunchRefused, runLab, type LabRunInput } from "./run.js";

// Anvil's public development keys: real, valid, and worth nothing.
const KEYS: Record<string, Hex> = {
  ORCHESTRATOR: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "WORKER-CODE": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "WORKER-EXTRACT": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "ISSUER-A": "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "ISSUER-B": "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  operator: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
};
const addressOfKey = (k: Hex): Hex => privateKeyToAccount(k).address;
const ADDRESSES = Object.fromEntries(Object.entries(KEYS).map(([seat, k]) => [seat, addressOfKey(k)])) as Record<string, Hex>;
const CLASS_ID = `0x${"ee".repeat(32)}` as Hex;
const OPERATOR: Signer = { label: "operator", address: ADDRESSES.operator, privateKeyHex: KEYS.operator };
const LIMIT = 32_000n;

/** An in-memory chain with one clock, USDC balances, one claim token and ISSUER-B's headroom. */
class FakeChain implements LabChain {
  clock = 1_800_000_000n;
  usdc = new Map<string, bigint>();
  claims = new Map<string, bigint>();
  eth = new Map<string, bigint>();
  headroomNow = LIMIT;
  mintBackedBy: Hex = ADDRESSES["ISSUER-B"];
  /** If set, a claim transfer delivers this much less than asked — to test the opening check. */
  shortChange = 0n;
  calls: string[] = [];
  failExpiryFor: Hex | undefined;
  lagOnMint = false;
  #token = 777n;

  constructor() {
    for (const a of Object.values(ADDRESSES)) this.eth.set(a.toLowerCase(), 10n ** 18n);
    this.usdc.set(ADDRESSES.operator.toLowerCase(), 1_000_000n);
  }
  #u = (a: Hex) => this.usdc.get(a.toLowerCase()) ?? 0n;
  #c = (a: Hex) => this.claims.get(a.toLowerCase()) ?? 0n;
  async now() {
    return this.clock;
  }
  async usdcBalance(a: Hex) {
    return this.#u(a);
  }
  async claimBalance(_t: bigint, a: Hex) {
    return this.#c(a);
  }
  async headroom() {
    return this.headroomNow;
  }
  async ethBalance(a: Hex) {
    return this.eth.get(a.toLowerCase()) ?? 0n;
  }
  async transferUsdc(from: Signer, to: Hex, n: bigint) {
    this.calls.push(`usdc ${from.label} -> ${to.slice(0, 8)} ${n}`);
    this.usdc.set(from.address.toLowerCase(), this.#u(from.address) - n);
    this.usdc.set(to.toLowerCase(), this.#u(to) + n);
    return `0xusdc${this.calls.length}`;
  }
  async mintEndowment(m: EndowmentMint) {
    this.calls.push(`mint ${m.quantityMilliSiu}`);
    if (this.lagOnMint) {
      // A write whose first simulation reverts because the node has not caught up, through the real helper.
      const abi = parseAbi(["function f()", "error E()"]);
      let n = 0;
      await writeAndConfirm(
        {
          account: { address: "0x00000000000000000000000000000000000000aa" },
          walletClient: {
            writeContract: async () => {
              if (n++ === 0) throw new BaseError("reverted", { cause: new ContractFunctionRevertedError({ abi, functionName: "f", data: "0x3e47169c" }) });
              return "0xabc";
            },
          },
          publicClient: { waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash }) },
        } as unknown as ChainClients,
        { address: "0x0000000000000000000000000000000000000001", abi, functionName: "f", args: [] },
      );
    }
    this.headroomNow -= m.quantityMilliSiu;
    this.claims.set(OPERATOR.address.toLowerCase(), this.#c(OPERATOR.address) + m.quantityMilliSiu);
    return { tokenId: this.#token, issuer: this.mintBackedBy, txHash: "0xmint" };
  }
  async transferClaim(to: Hex, _t: bigint, q: bigint) {
    this.calls.push(`claim -> ${to.slice(0, 8)} ${q}`);
    // A short delivery leaves the difference with the operator, where the expiry sweep will find it.
    const delivered = q - this.shortChange;
    this.claims.set(OPERATOR.address.toLowerCase(), this.#c(OPERATOR.address) - delivered);
    this.claims.set(to.toLowerCase(), this.#c(to) + delivered);
    return `0xclaim${this.calls.length}`;
  }
  async settleExpired(_t: bigint, holder: Hex) {
    this.calls.push(`expire ${holder.slice(0, 8)}`);
    if (this.failExpiryFor?.toLowerCase() === holder.toLowerCase()) throw new Error("WindowNotClosedYet\nmore detail");
    const held = this.#c(holder);
    this.claims.set(holder.toLowerCase(), 0n);
    this.headroomNow += held;
    return `0xexpire${this.calls.length}`;
  }
}

const respond = (intent: unknown): AdapterResult => ({
  text: JSON.stringify(intent),
  usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
  latency_ms: 1,
  raw: {},
  deviations: [],
});
const noGate = async (): Promise<GateHardeningResult> => {
  throw new Error("a lab run has no gate");
};

describe("runLab", () => {
  let runsRoot: string;
  let chain: FakeChain;
  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "lab-run-"));
    chain = new FakeChain();
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const loopDeps = (): RunnerDeps =>
    ({
      chainReader: {
        usdcBalance: async () => 0n,
        claimBalance: async () => 0n,
        headroom: async () => 0n,
        issuanceLimit: async () => 0n,
        claimWindow: async () => ({ windowFrom: 0n, windowTo: 0n }),
        currentBlockTimestamp: async () => chain.clock,
        escrowState: async () => ({ status: "none" as const, buyer: `0x${"00".repeat(20)}`, seller: `0x${"00".repeat(20)}`, maxAmountMinorUnits: 0n, expiryUnix: 0n }),
        reservation: async () => ({ exists: false, released: false, issuer: `0x${"00".repeat(20)}`, classId: `0x${"00".repeat(32)}`, quantityMilliSiu: 0n, deadlineUnix: 0n }),
        issuersForClass: async () => [],
      },
      deployment: { network: { name: "test", chainId: 0 }, usdc: { address: "0x0" }, capacityBond: { address: "0x0" }, claimRouter: { address: "0x0" }, workClaim: { address: "0x0" } },
      escrowAddress: "0x0",
      runGateHardeningChecks: noGate,
      loadPrint: async () => ({ print_id: "print-illustrative" }) as unknown as Print,
      isReconciled: async () => false,
    }) as unknown as RunnerDeps;

  const budget = () =>
    new ExperimentBudget({
      ceiling: new BudgetCeiling(
        Object.fromEntries(AGENT_IDS.map((id) => [id, { maxUsdcSpend: "0", maxInferenceTurns: 40, maxInferenceUsd: "5" }])) as never,
      ),
      runCapUsd: "30",
      experimentCapUsd: "150",
      ledgerPath: path.join(runsRoot, "ledger.json"),
    });

  const leaves: Adapter = async () => respond({ done: true, summary: "nothing to do" });
  const adapters = Object.fromEntries(LAB_TRADERS.map((t) => [t, leaves])) as Record<TraderLabel, Adapter>;
  const models = { "TRADER-1": "claude-haiku-4-5", "TRADER-2": "gpt-5.4-mini", "TRADER-3": "claude-haiku-4-5", "TRADER-4": "gpt-5.4-mini" } as const;

  const input = (over: Partial<LabRunInput> = {}): LabRunInput => ({
    seed: 9,
    runId: "lab-test-run",
    scripted: true,
    print: { printId: "print-illustrative", rateUsdPerSiu: "0.001437" }, // illustrative
    chain,
    classId: CLASS_ID,
    addresses: ADDRESSES as Partial<Record<AgentId, Hex>>,
    keys: KEYS as Partial<Record<AgentId, string>>,
    operator: OPERATOR,
    issuerLimitMilliSiu: LIMIT,
    windowSeconds: 600,
    closeMarginSeconds: 90,
    maxTurns: 12,
    chainName: "base-sepolia",
    rpcUrl: "http://127.0.0.1:1",
    adapters,
    models,
    prices: {
      "claude-haiku-4-5": { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" },
      "gpt-5.4-mini": { priceInUsdPer1M: "0.75", priceOutUsdPer1M: "4.5" },
    },
    providerOf: (m) => (m.startsWith("claude") ? "anthropic" : "openai"),
    executorFor: () => referenceExecutor,
    loopDeps: loopDeps(),
    budget: budget(),
    runsRoot,
    mintContext: { publisherPrivateKeyHex: KEYS.operator, printId: "print-illustrative", series: `0x${"11".repeat(32)}`, printDate: 0n, nanoUsdPerSiu: 1_437_000n, validitySeconds: 3600n } as MintContext,
    minEthWei: 10n ** 14n,
    sleep: async (ms) => {
      chain.clock += BigInt(Math.ceil(ms / 1000));
    },
    ...over,
  });

  // ---- the launch ---------------------------------------------------------------------------

  it("refuses to start from a pool that is not whole, before anything is spent", async () => {
    chain.headroomNow = LIMIT - 3_000n;
    await expect(runLab(input())).rejects.toThrow(LaunchRefused);
    await expect(runLab(input())).rejects.toThrow(/headroom is 29000 mSIU, not its whole 32000/);
    expect(chain.calls).toEqual([]);
  });

  it("starts from a slightly short pool only when told to, and says so in the report", async () => {
    chain.headroomNow = LIMIT - 200n; // 31,800: 80% of it, 25,440, still covers the endowment of 17,272
    await expect(runLab(input())).rejects.toThrow(LaunchRefused);
    const report = await runLab(input({ allowPartialPool: true }));
    expect(report.pool).toMatchObject({ whole: false, startingHeadroomMilliSiu: "31800" });
    expect(report.abortedBecause).toBeUndefined();
  });

  it("does not let permission to start short override the endowment bound: a pool too short for the endowment is refused anyway", async () => {
    chain.headroomNow = 20_000n; // 80% of it is 16,000, less than the endowment of 17,272
    await expect(runLab(input({ allowPartialPool: true }))).rejects.toThrow(/ISSUER-B can back 16000/);
    expect(chain.calls).toEqual([]);
  });

  it("refuses an economy whose endowment does not fit, naming the figure: three needs each is 3 x 2,159 mSIU per trader", async () => {
    await expect(runLab(input({ params: { ...DEFAULT_PARAMS, needsPerTrader: 3 } }))).rejects.toThrow(/the endowment is 25908 mSIU/);
    expect(chain.calls).toEqual([]);
  });

  it("refuses to run a trader on another role's wallet, and two seats on one wallet (D22)", async () => {
    // In this fixture the TRADER-4 seat's wallet is ADDRESSES["ISSUER-A"]; declaring it the issuer's makes it a violation.
    await expect(runLab(input({ forbiddenAddresses: { "ISSUER-A": ADDRESSES["ISSUER-A"] } }))).rejects.toThrow(
      /TRADER-4 is using ISSUER-A's wallet .* An issuer's identity must not act as a trader/,
    );
    const shared = { ...ADDRESSES, "WORKER-EXTRACT": ADDRESSES.ORCHESTRATOR } as Partial<Record<AgentId, Hex>>;
    await expect(runLab(input({ addresses: shared }))).rejects.toThrow(/TRADER-3 and TRADER-1 are the same wallet/);
    expect(chain.calls).toEqual([]); // both refusals came before anything was spent or moved
    // A different wallet for the issuer role is no objection.
    const ok = await runLab(input({ forbiddenAddresses: { "ISSUER-A": `0x${"cc".repeat(20)}` as Hex } }));
    expect(ok.abortedBecause).toBeUndefined();
  });

  it("refuses a wallet without gas, and an operator without enough USDC", async () => {
    chain.eth.set(ADDRESSES["WORKER-CODE"].toLowerCase(), 5n);
    await expect(runLab(input())).rejects.toThrow(/TRADER-2 holds 5 wei/);
    chain.eth.set(ADDRESSES["WORKER-CODE"].toLowerCase(), 10n ** 18n);
    chain.usdc.set(ADDRESSES.operator.toLowerCase(), 10n);
    await expect(runLab(input())).rejects.toThrow(/the operator holds 10 USDC minor units and needs/);
    expect(chain.calls).toEqual([]);
  });

  // ---- the run ------------------------------------------------------------------------------

  it("sets every trader to the same opening, endows them from one mint, and records both as operator action", async () => {
    // Different starting USDC: one short, one over, one exact, one empty.
    chain.usdc.set(ADDRESSES.ORCHESTRATOR.toLowerCase(), 10_000n);
    chain.usdc.set(ADDRESSES["WORKER-CODE"].toLowerCase(), 6_205n);
    chain.usdc.set(ADDRESSES["WORKER-EXTRACT"].toLowerCase(), 100n);
    const report = await runLab(input());

    expect(report.abortedBecause).toBeUndefined();
    // Sized from the print and the schedule so either asset alone meets every need (D31): 2 x (1,184 + 975) mSIU, and USDC of equal value.
    expect(report.opening).toMatchObject({ usdcMinorPerTrader: "6205", fsiuMilliSiuPerTrader: "4318", tokenId: "777" });
    const resets = report.operatorActions.filter((a) => a.kind === "usdc_reset");
    expect(resets.map((a) => (a as { move: string }).move)).toEqual(["return", "top_up", "top_up"]); // returns first; the exact one moves nothing
    // One mint for all four, then each trader's share.
    expect(chain.calls.filter((c) => c.startsWith("mint"))).toEqual(["mint 17272"]);
    expect(report.operatorActions.filter((a) => a.kind === "endowment_transfer")).toHaveLength(4);
    const opening = report.snapshots[0] as { label: string; traders: { usdcMinor: string; fsiuMilliSiu: string }[] };
    expect(opening.label).toBe("opening");
    for (const t of opening.traders) expect(t).toMatchObject({ usdcMinor: "6205", fsiuMilliSiu: "4318" });
  });

  it("takes a snapshot when each round opens and one more before the window closes", async () => {
    const report = await runLab(input());
    const labels = (report.snapshots as { label: string }[]).map((s) => s.label);
    expect(labels).toEqual(["opening", "round 2 opened", "round 3 opened"]);
    expect((report.final as { label: string }).label).toBe("final");
    expect(report.measuredBeforeClose).toBe(true);
    // Nobody traded, so every result is the opening's value and no need is met.
    const final = report.final as { traders: { resultNano: string; needsMet: number }[] };
    for (const t of final.traders) {
      expect(t.needsMet).toBe(0);
      expect(t.resultNano).toBe((6_205n * 1000n + (4_318n * 1_437_000n) / 1000n).toString());
    }
  });

  it("waits for the window to close, expires what is left, and leaves the pool as it found it", async () => {
    const report = await runLab(input());
    const expiries = report.operatorActions.filter((a) => a.kind === "expiry") as { holder: string; quantityMilliSiu: string }[];
    expect(expiries.map((e) => e.holder).sort()).toEqual(["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4"]);
    for (const e of expiries) expect(e.quantityMilliSiu).toBe("4318");
    expect(report.pool).toMatchObject({ startingHeadroomMilliSiu: "32000", endingHeadroomMilliSiu: "32000", restored: true });
    // The clock was taken past the window's close before the first expiry (the fake sleep advances it).
    expect(chain.clock).toBeGreaterThanOrEqual(BigInt(report.window.toChainSeconds));
    const lastWork = chain.calls.findIndex((c) => c.startsWith("expire"));
    expect(lastWork).toBeGreaterThan(chain.calls.findIndex((c) => c.startsWith("claim ->")));
  });

  it("reports an expiry that failed rather than hiding it, and says the pool was not restored", async () => {
    chain.failExpiryFor = ADDRESSES["WORKER-EXTRACT"];
    const report = await runLab(input());
    const failed = report.operatorActions.filter((a) => a.kind === "expiry_failed") as { holder: string; reason: string }[];
    expect(failed).toEqual([{ kind: "expiry_failed", holder: "TRADER-3", quantityMilliSiu: "4318", reason: "WindowNotClosedYet" }]);
    // Three holders expired, so 12,954 of the 17,272 minted came back; TRADER-3's 4,318 is still outstanding.
    expect(report.pool).toMatchObject({ endingHeadroomMilliSiu: "27682", restored: false });
  });

  // ---- aborts -------------------------------------------------------------------------------

  it("aborts before the loop when the endowment is backed by anyone but ISSUER-B, and still returns the capacity", async () => {
    chain.mintBackedBy = ADDRESSES["ISSUER-A"];
    const report = await runLab(input());
    expect(report.abortedBecause).toMatch(/backed by .*not ISSUER-B/);
    expect(report.final).toBeUndefined();
    expect(report.turnsByAgent).toEqual({});
    expect(chain.calls.some((c) => c.startsWith("expire"))).toBe(true);
    expect(report.pool.restored).toBe(true);
  });

  it("aborts when what the traders hold is not what was handed out", async () => {
    chain.shortChange = 1n;
    const report = await runLab(input());
    expect(report.abortedBecause).toMatch(/the opening is not what was handed out/);
    expect(report.final).toBeUndefined();
    expect(report.pool.restored).toBe(true);
  });

  it("still closes out when the loop itself throws", async () => {
    const report = await runLab(
      input({
        onTurn: () => {
          throw new Error("the log pipe broke");
        },
        adapters: Object.fromEntries(LAB_TRADERS.map((t) => [t, async () => respond({ wait: true })])) as unknown as Record<TraderLabel, Adapter>,
      }),
    );
    expect(report.abortedBecause).toBe("the log pipe broke");
    expect(report.pool.restored).toBe(true);
  });

  it("gives the tools the lab's service, so deliver_job reaches it instead of saying the run has no jobs", async () => {
    let asked = false;
    const delivers: Adapter = async () => {
      if (asked) return respond({ done: true, summary: "x" });
      asked = true;
      return respond({ tool: "deliver_job", args: { requestId: "qr-1" } });
    };
    const withDeliver = { ...adapters, "TRADER-1": delivers } as Record<TraderLabel, Adapter>;
    const report = await runLab(input({ adapters: withDeliver }));
    const errors = report.toolErrors as { tool: string; error: string }[];
    const deliver = errors.find((e) => e.tool === "deliver_job");
    expect(deliver?.error).toContain("there is no request qr-1");
    expect(deliver?.error).not.toContain("no jobs to deliver");
  });

  it("hands over what a sweep needs the moment the endowment is minted — before the loop, so a killed run can be cleaned up", async () => {
    const seen: { at: string[]; open: unknown }[] = [];
    const report = await runLab(
      input({
        onMinted: (open) => seen.push({ at: [...chain.calls], open }),
      }),
    );
    expect(report.abortedBecause).toBeUndefined();
    expect(seen).toHaveLength(1);
    // Called after the mint and before the first transfer of the endowment to a trader.
    expect(seen[0].at).toContain("mint 17272");
    expect(seen[0].at.some((c) => c.startsWith("claim ->"))).toBe(false);
    expect(seen[0].open).toMatchObject({
      runId: "lab-test-run",
      tokenId: "777",
      startingHeadroomMilliSiu: "32000",
      windowToChainSeconds: report.window.toChainSeconds,
    });
    expect((seen[0].open as { holders: { label: string }[] }).holders.map((h) => h.label)).toEqual(["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4", "ISSUER-B", "operator"]);
  });

  it("reports every write that had to wait for the node to catch up, and removes its listener afterwards", async () => {
    chain.lagOnMint = true;
    // Retries are switched off under test (vitest.setup.ts); this test needs one, quickly.
    setRevertRetryPolicy({ attempts: 2, delayMs: 0 });
    let report;
    try {
      report = await runLab(input());
    } finally {
      setRevertRetryPolicy({ attempts: 0 });
    }
    expect(report.lag).toMatchObject({ writesRetried: 1, recovered: 1, gaveUp: 0 });
    expect(report.lag.events[0]).toMatchObject({ functionName: "f", retries: 1, outcome: "recovered" });
    // A quiet run reports none — and a later run in the same process is not handed this one's events.
    chain.lagOnMint = false;
    const quiet = await runLab(input({ runId: "lab-test-run-2" }));
    expect(quiet.lag).toEqual({ writesRetried: 0, recovered: 0, gaveUp: 0, events: [] });
  });

  it("states what it ran: seats, models, the schedule and whether it was scripted", async () => {
    const report = await runLab(input());
    expect(report.scripted).toBe(true);
    expect(report.seats).toEqual({ "TRADER-1": "ORCHESTRATOR", "TRADER-2": "WORKER-CODE", "TRADER-3": "WORKER-EXTRACT", "TRADER-4": SEAT_OF["TRADER-4"] });
    expect(report.economy.needs).toHaveLength(8);
    // Nothing is minted after the opening (D31): the whole fSIU supply is the endowment, 54% of the 32,000 mSIU headroom.
    expect(report.endowment).toEqual({
      perTraderMilliSiu: "4318",
      totalMilliSiu: "17272",
      perTraderUsdcMinor: "6205",
      perTraderUsdcNeededMinor: "6200",
      allowanceMilliSiu: "25600",
    });
    expect(report).not.toHaveProperty("mintBound");
    expect(report).not.toHaveProperty("escrowFeeBps");
    expect(report.instrument.version).toBe(LAB_INSTRUMENT_VERSION);
    expect(ISSUER_SEAT).toBe("ISSUER-B");
  });

  // ---- what the runner hands the loop (instrument v4) -----------------------------------------

  it("settles by direct transfer: the tools are told so, and an agent's balances show no escrow", async () => {
    const prompts: string[] = [];
    let turn = 0;
    const reads: Adapter = async (_m, prompt) => {
      prompts.push(prompt);
      turn++;
      return turn === 1
        ? respond({ tool: "get_balances", args: { account: ADDRESSES.ORCHESTRATOR, tokenIds: ["777"] } })
        : respond({ done: true, summary: "x" });
    };
    const report = await runLab(input({ adapters: { ...adapters, "TRADER-1": reads } as Record<TraderLabel, Adapter> }));
    expect(report.abortedBecause).toBeUndefined();
    const second = prompts.find((p) => p.includes("called get_balances"));
    expect(second).toBeDefined();
    // The tool ran in direct mode: its result has USDC and claims and no `escrows` at all.
    expect(second).toContain("called get_balances");
    expect(second).not.toMatch(/escrow/i);
  });

  it("states its own asset paragraph to the context validator, so no agent is halted for lacking the canonical one", async () => {
    const report = await runLab(input());
    expect(Object.values(report.haltedReason as Record<string, string>)).not.toContain("validation_failed");
  });

  it("gives a trader three ways to pay and none that mints or releases an escrow, and the issuer service one tool", async () => {
    let shown = "";
    const looks: Adapter = async (_m, prompt) => {
      shown = prompt;
      return respond({ done: true, summary: "x" });
    };
    await runLab(input({ adapters: { ...adapters, "TRADER-1": looks } as Record<TraderLabel, Adapter> }));
    for (const name of ["pay_with_usdc", "pay_with_held_claim", "pay_split"]) expect(shown, name).toContain(name);
    for (const name of ["pay_with_new_claim", "pay_with_claim", "settle_escrow", "mint_claim"]) expect(shown, name).not.toContain(name);
  });
});
