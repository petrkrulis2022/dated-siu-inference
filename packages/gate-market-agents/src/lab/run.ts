/**
 * One run of the currency lab, start to finish, written against `LabChain` so the orchestration can be
 * tested without a chain (plan §4, P7). The environment — keys, deployment, providers, flags — is wired in
 * `cli/lab-run.ts`; everything that decides what happens, and in what order, is here.
 *
 *   launch checks  →  opening balances and endowment  →  the loop  →  scoring snapshot  →  close-out  →  report
 *
 * Three rules shape the order:
 *   - Nothing is spent or minted until every launch check has passed, and a refusal names the number.
 *   - The scoring snapshot is taken before the window closes, so fSIU still counts at the print (§2.8).
 *   - The close-out always runs once anything has been minted — even if the run aborts or the loop throws —
 *     because a claim left outstanding is capacity the next run starts without (spec §4.6z).
 *
 * Operator actions (setting balances, the endowment, the fee rebate, the expiry sweep) are recorded apart
 * from every agent's record, so no behavioural statistic can include them.
 */
import type { Adapter } from "@touchstone/harness";
import { D } from "@touchstone/sdk";
import type { Hex } from "viem";
import type { ModelPrices } from "../budget/inference-cost.js";
import type { ExperimentBudget } from "../budget/experiment-budget.js";
import type { RunnerDeps } from "../deps.js";
import { erc8004IdFor, type AgentId } from "../identity/resolve.js";
import { claimMintCostMinorUnits } from "../loop/parity.js";
import {
  runFullRunWindow,
  type FullRunWindowResult,
  type JobEnvelope,
  type MintContext,
  type OpeningClaim,
} from "../loop/full-run.js";
import { QuoteBoard } from "../loop/quote-board.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { setWriteRetryListener, type WriteRetryEvent } from "../chain/write.js";
import { windowContamination } from "../cli/topology.js";
import { LAB_INSTRUMENT_CHANGES, LAB_INSTRUMENT_VERSION } from "./instrument.js";
import { labDisqualification, type MeasureReport } from "./measure.js";
import { toolErrorsOf } from "../cli/tool-errors.js";
import { LabBooks } from "./books.js";
import {
  DEFAULT_PARAMS,
  ISSUER_SEAT,
  LAB_TRADERS,
  SEAT_OF,
  buildEconomy,
  labDisplayName,
  type Economy,
  type LabParams,
  type TraderLabel,
} from "./economy.js";
import type { WorkExecutor } from "./jobs.js";
import { checkMintsFit, mintBound, type MintBound } from "./launch.js";
import { openingUsdcMinor, printNano, quotedPrice, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu, jobSiu } from "./money.js";
import {
  operatorUsdcNeed,
  planUsdcReset,
  rebateReserveMinor,
  type LabChain,
  type Signer,
  type UsdcMove,
} from "./operator.js";
import { buildLabRoster } from "./roster.js";
import { LabService, type LabOperatorAction } from "./service.js";
import { openingMatches, snapshotToJson, takeSnapshot, type Snapshot } from "./scoring.js";

/** Refused before anything was spent or minted. */
export class LaunchRefused extends Error {
  constructor(reason: string) {
    super(`lab launch refused: ${reason}`);
    this.name = "LaunchRefused";
  }
}

export interface LabRunInput {
  seed: number;
  runId: string;
  params?: LabParams;
  /** A scripted run calls no model. Its report says so and is never counted. */
  scripted: boolean;
  print: { printId: string; rateUsdPerSiu: string };
  chain: LabChain;
  classId: Hex;
  /** Wallet addresses and keys by seat: the four trader seats and ISSUER-B. */
  addresses: Readonly<Partial<Record<AgentId, Hex>>>;
  keys: Readonly<Partial<Record<AgentId, string>>>;
  operator: Signer;
  /** ISSUER-B's issuance limit in this class — what a whole pool's headroom is. */
  issuerLimitMilliSiu: bigint;
  /** Wallets that must never act as a trader or the issuer service: another role's identity (D22). */
  forbiddenAddresses?: Readonly<Record<string, Hex>>;
  /** Proceed from a pool that is not whole. Recorded in the report; never the default. */
  allowPartialPool?: boolean;
  windowSeconds: number;
  /** Turns stop being handed out this long before the window closes, so the scoring snapshot falls inside it. */
  closeMarginSeconds?: number;
  escrowFeeBps: number;
  maxTurns: number;
  chainName: string;
  rpcUrl: string;
  adapters: Readonly<Record<TraderLabel, Adapter>>;
  models: Readonly<Record<TraderLabel, string>>;
  prices: Readonly<Record<string, ModelPrices>>;
  providerOf: (modelString: string) => string;
  executorFor: (trader: TraderLabel) => WorkExecutor;
  issuerAdapter?: Adapter;
  loopDeps: RunnerDeps;
  budget: ExperimentBudget;
  runsRoot: string;
  mintContext: MintContext;
  /** Gas each transacting wallet must hold before the run. */
  minEthWei: bigint;
  /**
   * Called the moment the endowment exists on chain, before anything else can fail. The caller writes it
   * down, so a run that is killed outright leaves enough behind for `lab-sweep` to return the capacity.
   */
  onMinted?: (open: OpenLabState) => void;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  onTurn?: (agentId: AgentId, turn: unknown) => void;
}

/** What must survive a crash for the capacity to be returned: the token, when it closes, who may hold it. */
export interface OpenLabState {
  runId: string;
  tokenId: string;
  windowToChainSeconds: string;
  startingHeadroomMilliSiu: string;
  holders: { label: string; address: string }[];
}

export type OperatorRecord =
  | { kind: "usdc_reset"; seat: AgentId; move: "top_up" | "return"; minorUnits: string; txHash: string }
  | { kind: "endowment_mint"; quantityMilliSiu: string; tokenId: string; backedBy: string; txHash: string }
  | { kind: "endowment_transfer"; seat: AgentId; quantityMilliSiu: string; txHash: string }
  | { kind: "expiry"; holder: string; quantityMilliSiu: string; txHash: string }
  | { kind: "expiry_failed"; holder: string; quantityMilliSiu: string; reason: string }
  | LabOperatorAction;

export interface LabReport {
  runId: string;
  seed: number;
  scripted: boolean;
  print: { printId: string; rateUsdPerSiu: string };
  params: LabParams;
  economy: {
    skillOf: Record<string, string>;
    needs: { id: string; buyer: string; type: string; seller: string; round: number }[];
  };
  seats: Record<string, string>;
  models: Record<string, string>;
  window: { fromChainSeconds: string; toChainSeconds: string };
  mintBound: { openingMilliSiu: string; jobClaimMilliSiu: string; rawClaimMilliSiu: string; needs: number; worstCaseMilliSiu: string; allowanceMilliSiu: string };
  pool: { startingHeadroomMilliSiu: string; limitMilliSiu: string; whole: boolean; endingHeadroomMilliSiu?: string; restored?: boolean };
  opening: { usdcMinorPerTrader: string; fsiuMilliSiuPerTrader: string; tokenId?: string };
  snapshots: unknown[];
  /** The scoring snapshot, taken before the window closed. */
  final?: unknown;
  measuredBeforeClose?: boolean;
  needsMet: Record<string, number>;
  /** Every sale the books saw: a job bought from a trader, or a unit of raw work bought from the issuer. */
  sales: unknown[];
  /** What the escrow kept per dollar settlement, in basis points, and so what the operator gave back. */
  escrowFeeBps: number;
  workLog: unknown[];
  workCostUsd: string;
  operatorActions: OperatorRecord[];
  contamination?: string;
  abortedBecause?: string;
  infrastructureFailure?: unknown;
  labErrors: FullRunWindowResult["labErrors"];
  toolErrors: unknown;
  turnsByAgent: Record<string, number>;
  haltedReason: unknown;
  totalRealizedUsd: string;
  spendByProvider: Record<string, string>;
  paymentMoments: unknown;
  usdcSettlements: unknown;
  claimFlows: unknown;
  capacityEvents: unknown;
  claimPositions: unknown;
  /** Which lab this was (`lab/instrument.ts`): runs under different versions are never pooled. */
  instrument: { version: number; changes: readonly string[] };
  /** Every write that needed the node to catch up (a stale simulation) and how it ended — the lag, made visible. */
  lag: { writesRetried: number; recovered: number; gaveUp: number; events: WriteRetryEvent[] };
  /** The shape the existing `assertCountableForF1` guard reads: why this run cannot be counted, or null. */
  debugMode: { disqualifiedBecause: string | null };
}

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`lab run: no ${what}`);
  return value;
};

/** The loop wants a job; the lab has no gate and no reference task. Its fields are never read. */
function labJobEnvelope(runId: string): JobEnvelope {
  return {
    jobId: runId,
    taskClass: "extract",
    originalGate: { taskClass: "extract", source: "" },
    referenceInstance: { taskClass: "extract", files: {} },
    knownGoodSubmission: { files: {} },
    adversarialSubmissions: [],
    heldOutInstances: [
      { referenceInstance: { taskClass: "extract", files: {} }, knownGoodSubmission: { files: {} }, adversarialSubmissions: [] },
    ],
  } as unknown as JobEnvelope;
}

const iso = (unix: bigint): string => new Date(Number(unix) * 1000).toISOString().slice(0, 19).replace("T", " ");

export async function runLab(input: LabRunInput): Promise<LabReport> {
  const log = input.log ?? (() => {});
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const params = input.params ?? DEFAULT_PARAMS;
  const economy: Economy = buildEconomy(input.seed, params);
  const p = printNano(input.print.rateUsdPerSiu);
  const addr = (seat: AgentId): Hex => required(input.addresses[seat], `address for ${seat}`);
  const key = (seat: AgentId): string => required(input.keys[seat], `key for ${seat}`);
  const traderAddress = Object.fromEntries(LAB_TRADERS.map((t) => [t, addr(SEAT_OF[t])])) as Record<TraderLabel, Hex>;
  const issuerAddress = addr(ISSUER_SEAT);
  const traderSigner = (t: TraderLabel): Signer => ({ label: t, address: traderAddress[t], privateKeyHex: key(SEAT_OF[t]) });
  const classId = input.classId;
  const margin = BigInt(input.closeMarginSeconds ?? 90);

  // ---------------------------------------------------------------- launch checks (nothing spent yet)
  // Every seat is its own wallet, and none is another role's. A trader's receipts under an issuer's identity would
  // be confusing in any explorer, and a mint ever routed to that issuer would make the trader the issuer of
  // claims it holds (D22).
  const wallets: { who: string; address: Hex }[] = [
    ...LAB_TRADERS.map((t) => ({ who: t as string, address: traderAddress[t] })),
    { who: ISSUER_SEAT as string, address: issuerAddress },
    { who: "operator", address: input.operator.address },
  ];
  const seen = new Map<string, string>();
  for (const w of wallets) {
    const key = w.address.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) throw new LaunchRefused(`${w.who} and ${other} are the same wallet (${w.address}); each seat needs its own.`);
    seen.set(key, w.who);
  }
  for (const [role, address] of Object.entries(input.forbiddenAddresses ?? {})) {
    const holder = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (holder !== undefined) {
      throw new LaunchRefused(`${holder.who} is using ${role}'s wallet (${address}). An issuer's identity must not act as a trader.`);
    }
  }

  const startingHeadroom = await input.chain.headroom(issuerAddress, classId);
  const poolWhole = startingHeadroom === input.issuerLimitMilliSiu;
  if (!poolWhole && !input.allowPartialPool) {
    throw new LaunchRefused(
      `ISSUER-B's headroom is ${startingHeadroom} mSIU, not its whole ${input.issuerLimitMilliSiu}: an earlier run left claims outstanding. ` +
        "Settle them, or pass --allow-partial-pool (recorded in the report).",
    );
  }
  const bound: MintBound = mintBound(p, economy);
  const fit = checkMintsFit(bound, startingHeadroom);
  if (!fit.ok) throw new LaunchRefused(fit.reason);

  const gasWallets: { label: string; address: Hex }[] = [
    ...LAB_TRADERS.map((t) => ({ label: t, address: traderAddress[t] })),
    { label: ISSUER_SEAT, address: issuerAddress },
    { label: "operator", address: input.operator.address },
  ];
  const lowGas: string[] = [];
  for (const w of gasWallets) {
    const eth = await input.chain.ethBalance(w.address);
    if (eth < input.minEthWei) lowGas.push(`${w.label} holds ${eth} wei`);
  }
  if (lowGas.length > 0) throw new LaunchRefused(`not enough gas (needs ${input.minEthWei} wei each): ${lowGas.join("; ")}.`);

  const openingUsdc = openingUsdcMinor(p, params);
  const openingFsiu = BigInt(params.openingMilliSiu);
  const totalEndowment = openingFsiu * BigInt(LAB_TRADERS.length);
  const current = new Map<AgentId, bigint>();
  for (const t of LAB_TRADERS) current.set(SEAT_OF[t], await input.chain.usdcBalance(traderAddress[t]));
  const moves: UsdcMove[] = planUsdcReset(current, openingUsdc);
  const size = jobSiu(params);
  const jobQuote = quotedPrice(size, tradeRateUsdPerSiu(p, params)).minorUnits;
  const rawQuote = quotedPrice(size, rawWorkRateUsdPerSiu(p)).minorUnits;
  const reserve = rebateReserveMinor(
    economy.needs.flatMap(() => [jobQuote, rawQuote]),
    input.escrowFeeBps,
  );
  const mintCost = claimMintCostMinorUnits(totalEndowment, p);
  const operatorNeeds = operatorUsdcNeed(moves, mintCost, reserve);
  const operatorHolds = await input.chain.usdcBalance(input.operator.address);
  if (operatorHolds < operatorNeeds) {
    throw new LaunchRefused(
      `the operator holds ${operatorHolds} USDC minor units and needs ${operatorNeeds} ` +
        `(top-ups, the endowment's mint cost ${mintCost}, and a fee-rebate reserve ${reserve}).`,
    );
  }
  log(
    `launch checks passed: pool ${poolWhole ? "whole" : "NOT whole (allowed)"} at ${startingHeadroom} mSIU; worst-case mint ` +
      `${bound.worstCaseMilliSiu} of ${fit.allowanceMilliSiu} allowed; operator holds ${operatorHolds}, needs ${operatorNeeds}.`,
  );

  // ---------------------------------------------------------------- the run
  const operatorActions: OperatorRecord[] = [];
  const snapshots: Snapshot[] = [];
  let tokenId: bigint | undefined;
  let abortedBecause: string | undefined;
  let result: FullRunWindowResult | undefined;
  let service: LabService | undefined;
  let books: LabBooks | undefined;
  let final: Snapshot | undefined;
  let contamination: string | undefined;
  let endowmentIssuer: Hex | undefined;
  let workCostUsd = new D(0); // what the graded jobs cost to run; also recorded in the experiment ledger

  const lag: WriteRetryEvent[] = [];
  setWriteRetryListener((e) => lag.push(e));

  const t0 = await input.chain.now();
  const windowFrom = t0 - 60n;
  const windowTo = t0 + BigInt(input.windowSeconds);

  try {
    // Opening balances. Returns first, so the operator holds what it will top up with.
    for (const m of [...moves].sort((a, b) => Number(a.kind === "top_up") - Number(b.kind === "top_up"))) {
      const t = LAB_TRADERS.find((x) => SEAT_OF[x] === m.seat)!;
      const txHash =
        m.kind === "top_up"
          ? await input.chain.transferUsdc(input.operator, traderAddress[t], m.minorUnits)
          : await input.chain.transferUsdc(traderSigner(t), input.operator.address, m.minorUnits);
      operatorActions.push({ kind: "usdc_reset", seat: m.seat, move: m.kind, minorUnits: m.minorUnits.toString(), txHash });
    }

    // The endowment: one mint, then each trader's share. The mint's issuer is read from its own event.
    const minted = await input.chain.mintEndowment({
      classId,
      series: input.mintContext.series,
      quantityMilliSiu: totalEndowment,
      windowFrom,
      windowTo,
    });
    tokenId = minted.tokenId;
    endowmentIssuer = minted.issuer;
    input.onMinted?.({
      runId: input.runId,
      tokenId: minted.tokenId.toString(),
      windowToChainSeconds: windowTo.toString(),
      startingHeadroomMilliSiu: startingHeadroom.toString(),
      holders: [
        ...LAB_TRADERS.map((t) => ({ label: t, address: traderAddress[t] as string })),
        { label: ISSUER_SEAT, address: issuerAddress as string },
        { label: "operator", address: input.operator.address as string },
      ],
    });
    operatorActions.push({
      kind: "endowment_mint",
      quantityMilliSiu: totalEndowment.toString(),
      tokenId: minted.tokenId.toString(),
      backedBy: minted.issuer,
      txHash: minted.txHash,
    });
    if (minted.issuer.toLowerCase() !== issuerAddress.toLowerCase()) {
      throw new Error(`the endowment mint was backed by ${minted.issuer}, not ISSUER-B (${issuerAddress}): the pool is not what the run assumes`);
    }
    for (const t of LAB_TRADERS) {
      const txHash = await input.chain.transferClaim(traderAddress[t], tokenId, openingFsiu);
      operatorActions.push({ kind: "endowment_transfer", seat: SEAT_OF[t], quantityMilliSiu: openingFsiu.toString(), txHash });
    }

    const ids = {
      traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, erc8004IdFor(traderAddress[t])])) as Record<TraderLabel, string>,
      issuer: erc8004IdFor(issuerAddress),
    };
    books = new LabBooks(economy, ids);
    const snap = (label: string): Promise<Snapshot> =>
      takeSnapshot({ label, chain: input.chain, books: books!, addressOf: traderAddress, tokenId: tokenId!, printNano: p, params });

    const opening = await snap("opening");
    snapshots.push(opening);
    const mismatch = openingMatches(opening, openingUsdc, openingFsiu);
    if (mismatch !== undefined) throw new Error(mismatch);
    log(`opening set: ${LAB_TRADERS.length} traders, each ${openingUsdc} USDC minor units and ${openingFsiu} mSIU (token ${tokenId}).`);

    service = new LabService({
      books,
      guard: { printNano: p, params },
      seed: input.seed,
      executorFor: input.executorFor,
      rebate: async (seat, minorUnits) => ({ txHash: await input.chain.transferUsdc(input.operator, addr(seat), minorUnits) }),
      escrowFeeBps: input.escrowFeeBps,
      recordWorkCost: (usd) => {
        workCostUsd = workCostUsd.plus(new D(usd));
        input.budget.recordRealizedInferenceSpend(usd);
      },
      onRoundOpened: async (round) => {
        snapshots.push(await snap(`round ${round} opened`));
      },
    });

    const roster = buildLabRoster({
      economy,
      print: input.print,
      claim: { tokenId: tokenId.toString(), classLabel: "extract", fromIso: iso(windowFrom), untilIso: iso(windowTo) },
      maxTurns: input.maxTurns,
      chain: input.chainName,
      rpcUrl: input.rpcUrl,
      adapters: input.adapters,
      prices: input.prices,
      models: input.models,
      keys: input.keys,
      addresses: input.addresses,
      providerOf: input.providerOf,
      ...(input.issuerAdapter !== undefined ? { issuerAdapter: input.issuerAdapter } : {}),
    });
    const openingClaims: OpeningClaim[] = LAB_TRADERS.map((t) => ({
      agentId: SEAT_OF[t],
      tokenId: tokenId!.toString(),
      quantityMilliSiu: openingFsiu.toString(),
      issuerAgentId: ISSUER_SEAT,
    }));
    const manifest: RunManifest = {
      benchVersion: "0.0.0",
      packVersion: "currency-lab/phase-1@0.0.0",
      agentConfigs: Object.fromEntries(LAB_TRADERS.map((t) => [t, { seat: SEAT_OF[t], model: input.models[t] }])),
      seed: `currency-lab:${input.seed}`,
    };

    log(`window ${iso(windowFrom)} to ${iso(windowTo)} UTC; turns stop ${margin}s before it closes.`);
    result = await runFullRunWindow({
      windowId: `lab-${input.runId}`,
      roster,
      job: labJobEnvelope(input.runId),
      maxTurnsPerAgent: input.maxTurns,
      windowSpanEndsAtUnixSeconds: windowTo - margin,
      budget: input.budget,
      // The tools reach the lab through `deps.lab` (`deliver_job` calls it); the loop reaches it through `lab`.
      // Both are the one service. Leaving this out made every `deliver_job` fail "this run has no jobs to deliver",
      // found by the first scripted walk on a fork.
      deps: { ...input.loopDeps, lab: service },
      runsRoot: input.runsRoot,
      runId: input.runId,
      manifest,
      windowFrom,
      windowTo,
      mintContext: input.mintContext,
      lab: service,
      board: new QuoteBoard({ reservationStep: false, displayName: labDisplayName }),
      openingClaims,
      ...(input.onTurn !== undefined ? { onTurn: input.onTurn as never } : {}),
    });

    // Before the window closes: unexpired fSIU still counts at the print.
    final = await snap("final");
    contamination = windowContamination(1, result.capacityEvents, [endowmentIssuer], issuerAddress);
    if (contamination !== undefined) abortedBecause = contamination;
  } catch (err) {
    abortedBecause = err instanceof Error ? err.message : String(err);
    log(`RUN ABORTED: ${abortedBecause}`);
  } finally {
    // Always, once anything was minted: capacity a claim holds is capacity the next run starts without.
    if (tokenId !== undefined) {
      const closeBy = windowTo;
      for (let now = await input.chain.now(); now < closeBy; now = await input.chain.now()) {
        log(`waiting ${Number(closeBy - now) + 2}s for the window to close before expiring what is left.`);
        await sleep((Number(closeBy - now) + 2) * 1000);
      }
      const holders: { label: string; address: Hex }[] = [
        ...LAB_TRADERS.map((t) => ({ label: t, address: traderAddress[t] })),
        { label: ISSUER_SEAT, address: issuerAddress },
        { label: "operator", address: input.operator.address },
      ];
      for (const h of holders) {
        let held: bigint;
        try {
          held = await input.chain.claimBalance(tokenId, h.address);
        } catch (err) {
          operatorActions.push({ kind: "expiry_failed", holder: h.label, quantityMilliSiu: "unknown", reason: `could not read: ${String(err)}` });
          continue;
        }
        if (held === 0n) continue;
        try {
          const txHash = await input.chain.settleExpired(tokenId, h.address);
          operatorActions.push({ kind: "expiry", holder: h.label, quantityMilliSiu: held.toString(), txHash });
        } catch (err) {
          operatorActions.push({
            kind: "expiry_failed",
            holder: h.label,
            quantityMilliSiu: held.toString(),
            reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
          });
        }
      }
    }
  }

  setWriteRetryListener(undefined);
  const endingHeadroom = tokenId !== undefined ? await input.chain.headroom(issuerAddress, classId) : undefined;
  const restored = endingHeadroom === undefined ? undefined : endingHeadroom === startingHeadroom;

  const report: Omit<LabReport, "debugMode"> = {
    runId: input.runId,
    seed: input.seed,
    scripted: input.scripted,
    print: input.print,
    params,
    economy: {
      skillOf: { ...economy.skillOf },
      needs: economy.needs.map((n) => ({ id: n.id, buyer: n.buyer, type: n.type, seller: n.seller, round: n.round })),
    },
    seats: Object.fromEntries(LAB_TRADERS.map((t) => [t, SEAT_OF[t]])),
    models: { ...input.models },
    window: { fromChainSeconds: windowFrom.toString(), toChainSeconds: windowTo.toString() },
    mintBound: {
      openingMilliSiu: bound.openingMilliSiu.toString(),
      jobClaimMilliSiu: bound.jobClaimMilliSiu.toString(),
      rawClaimMilliSiu: bound.rawClaimMilliSiu.toString(),
      needs: bound.needs,
      worstCaseMilliSiu: bound.worstCaseMilliSiu.toString(),
      allowanceMilliSiu: fit.allowanceMilliSiu.toString(),
    },
    pool: {
      startingHeadroomMilliSiu: startingHeadroom.toString(),
      limitMilliSiu: input.issuerLimitMilliSiu.toString(),
      whole: poolWhole,
      ...(endingHeadroom !== undefined ? { endingHeadroomMilliSiu: endingHeadroom.toString() } : {}),
      ...(restored !== undefined ? { restored } : {}),
    },
    opening: {
      usdcMinorPerTrader: openingUsdc.toString(),
      fsiuMilliSiuPerTrader: openingFsiu.toString(),
      ...(tokenId !== undefined ? { tokenId: tokenId.toString() } : {}),
    },
    snapshots: snapshots.map(snapshotToJson),
    ...(final !== undefined ? { final: snapshotToJson(final), measuredBeforeClose: final.atChainSeconds < windowTo } : {}),
    needsMet: Object.fromEntries(LAB_TRADERS.map((t) => [t, books?.needsMet(t) ?? 0])),
    sales: books?.allSales().map((x) => ({ ...x })) ?? [],
    escrowFeeBps: input.escrowFeeBps,
    workLog: service?.workLog ?? [],
    workCostUsd: workCostUsd.toFixed(6),
    operatorActions: [...operatorActions, ...(service?.operatorActions ?? [])],
    ...(contamination !== undefined ? { contamination } : {}),
    ...(abortedBecause !== undefined ? { abortedBecause } : {}),
    ...(result?.infrastructureFailure !== undefined ? { infrastructureFailure: result.infrastructureFailure } : {}),
    labErrors: result?.labErrors ?? [],
    toolErrors: result !== undefined ? toolErrorsOf(result.turnLogsByAgent) : [],
    turnsByAgent: result?.turnsByAgent ?? {},
    haltedReason: result?.haltedReason ?? {},
    totalRealizedUsd: result?.totalRealizedUsd ?? "0.000000",
    spendByProvider: result?.spendByProvider ?? {},
    paymentMoments: result?.paymentMoments ?? [],
    usdcSettlements: result?.usdcSettlements ?? [],
    claimFlows: result?.claimFlows ?? {},
    capacityEvents: result?.capacityEvents ?? [],
    claimPositions: result?.claimPositions ?? [],
    // `recovered` is the lag: a write that went through once the node caught up. `gaveUp` is a write that never did,
    // which is usually a genuine refusal (a mint with too few dollars reverts the same way a stale read does).
    lag: {
      writesRetried: lag.length,
      recovered: lag.filter((e) => e.outcome === "recovered").length,
      gaveUp: lag.filter((e) => e.outcome === "gave_up").length,
      events: lag,
    },
    instrument: { version: LAB_INSTRUMENT_VERSION, changes: LAB_INSTRUMENT_CHANGES },
  };
  // Stamped where it cannot be separated from the run, and recomputed by the aggregator from the facts.
  return { ...report, debugMode: { disqualifiedBecause: labDisqualification(report as unknown as MeasureReport) } };
}
