import { keccak256, stringToBytes, type Hex } from "viem";
import { ZodError } from "zod";
import { classifyFailure, isPolicyRefusalStopReason, type Adapter, type AdapterParams, type FailureCategory } from "@touchstone/harness";
import { quoteHashHex, type QuoteBody, type TouchstoneQuote } from "@touchstone/sdk";
import type {
  GateHardeningJobInputs,
  GateHardeningResult,
  HeldOutInstance,
  ReferenceTaskInstance,
  Submission,
  TaskClass,
} from "@touchstone/task-pack-gate-hardening";
import { assembleContext } from "../context/assemble.js";
import { computeTimeToExpirySeconds } from "../context/expiry.js";
import {
  projectedTurnCostUsd,
  realizedTurnCostUsd,
  type ModelPrices,
} from "../budget/inference-cost.js";
import { ExperimentBudget, ExperimentCapExceededError } from "../budget/experiment-budget.js";
import { CeilingExceededError } from "../budget/ceiling.js";
import { gateResultsMatch } from "../gate/determinism.js";
import { signRateAttestation } from "../chain/rate-attestation.js";
import { Runner } from "../runner.js";
import type { RunnerDeps } from "../deps.js";
import type { AgentId } from "../identity/resolve.js";
import { ContextValidationError, validateAgentContext } from "../pack/validate.js";
import type { ToolName } from "../tools/index.js";
import type { AttackToolResult } from "../tools/submit-attack.js";
import { RunRecorder, type RunManifest } from "../run-recorder/recorder.js";
import { FrictionLogWriter, type FrictionLogEntry } from "../friction/log.js";
import { QuoteBoard } from "./quote-board.js";
import { ForwardQuoteBook, type ForwardQuote } from "./forward-book.js";
import { RedemptionTracker } from "./redemption-tracker.js";
import { buildTurnPrompt } from "./prompt.js";
import { ModelResponseParseError, parseModelResponse, type FrictionReport } from "./parse-tool-call.js";

/**
 * WP-7's own general loop — P4 (one agent, one job) and P5 (six agents, several windows) are both
 * configurations of this same machinery, not separate code paths (this package's own WP-7 plan:
 * "P4 is this same loop... a real smoke test of the P5 machinery, not a fiction"). Per-agent
 * turn-order across a roster is genuinely new here; the per-turn body (assemble -> validate ->
 * prompt -> project cost -> charge ceiling -> call adapter -> parse -> call tool) is the same
 * proven shape `loop/gate-authoring-pass.ts` already uses for one agent, extended with real
 * friction-log writes, hold-decision `time_to_expiry` logging, and the gate-determinism check
 * (spec §9.3) around a `submit_job` call specifically.
 *
 * P5's own remaining, real gap — noted rather than silently worked around: this package has only
 * one fixed reference task per class (`CODE_REFERENCE`/`EXTRACT_REFERENCE`), not a generator for
 * distinct per-job content. A real P5 run reuses the same reference task across multiple job
 * attempts (varying quantity/timing/pricing, not task content) — adequate for a mechanism test
 * (do agents trade, settle, choose an asset), not a task-diversity benchmark. Building a real
 * per-job generator is separate, deferred work if P5 needs it.
 */
export interface RosterAgentConfig {
  agentId: AgentId;
  adapter: Adapter;
  modelString: string;
  prices: ModelPrices;
  skillPackText: string;
  availableTools: readonly ToolName[];
  privateKeyHex: string;
  /** This agent's own address, derived from `privateKeyHex` by the caller once — needed to
   * resolve a `transfer_claim`'s symbolic `{ agentId }` destination and to build the roster
   * address map `buildToolArgs` uses, without re-deriving it from the key on every turn. */
  address: string;
  /** `erc8004:0x...` — matches `identity/resolve.ts`'s own convention. Needed to know which open
   * quote-board requests are addressed to *this* agent (a request names a `seller_id`, not an
   * `AgentId`). */
  erc8004Id: string;
  rpcUrl: string;
  maxOutputTokens: number;
  /** Deciding agents (ORCHESTRATOR, the workers, HEDGER) run at 0.7 so five F1 runs are genuinely
   * distinct attempts rather than near-copies of one another; issuers stay at 0, where variation
   * is noise rather than the thing being measured. Per-agent rather than per-run because those
   * two roles want opposite things from the same loop. */
  temperature: number;
  /**
   * When set, this agent's turns are skipped — no model call, no turn consumed — until it has
   * something real to act on. Found live, 2026-09-27: WORKER-EXTRACT spent all ten of its turns
   * submitting attacks before any gate existed, every one correctly refused, and both issuers
   * spent eight turns each polling `get_print` with nothing routed to them. That polling was the
   * single largest provider cost in the run and produced nothing.
   *
   *  - "gate":  wait until a gate has actually been delivered (the adversary has nothing to test
   *             before that, by definition).
   *  - "inbox": wait until this agent's own board section is non-empty — an open request
   *             addressed to it, a claim minted or presented against it, or a redemption routed
   *             to it.
   */
  waitsFor?: "gate" | "inbox";
  /** The real provider this agent's model is served by (`data/registry/models.json`'s own
   * `provider`) — carried here so the run can report spend per provider, which is what shows
   * whether a run drew down an account the daily print also depends on. */
  provider: string;
}

/** Real, real-key-signed context for a `mint_claim` splice (see `buildToolArgs`) — absent when a
 * window's roster has no agent that can mint (e.g. P4's solo ORCHESTRATOR pass, which never calls
 * `mint_claim` at all). `nanoUsdPerSiu` is the one real rate every mint in this window attests to
 * — the model chooses *whether* and *how much* to mint, never the rate itself, matching how
 * `submit_job`'s envelope is spliced rather than retyped. */
export interface MintContext {
  publisherPrivateKeyHex: Hex;
  printId: string;
  /** Which Touchstone Assay grade every mint in this window attests to and mints as — added
   * 2026-09-27 alongside `printDate` (see `RateAttestation`'s own doc comment): a real, real-key
   * signed rate for one blended print previously carried no grade at all, so nothing stopped a
   * frontier-priced mint from claiming to be a commodity one or vice versa. */
  series: Hex;
  /** Unix timestamp of 00:00:00 UTC on `printId`'s own calendar date — see
   * `chain/rate-attestation.ts`'s `printDateToUnixDay`. */
  printDate: bigint;
  nanoUsdPerSiu: bigint;
  /** How long a freshly-signed attestation stays valid — generous on purpose (this run's own
   * compressed windows are hours, not weeks); a real production system would want this much
   * tighter (spec's own EIP-712 replay-guard point). */
  validitySeconds: bigint;
}

export interface JobEnvelope {
  jobId: string;
  taskClass: TaskClass;
  originalGate: import("@touchstone/task-pack-gate-hardening").GateSpec;
  referenceInstance: ReferenceTaskInstance;
  knownGoodSubmission: Submission;
  adversarialSubmissions: Submission[];
  heldOutInstances: readonly [HeldOutInstance, ...HeldOutInstance[]];
}

export interface FullRunWindowOptions {
  windowId: string;
  roster: readonly RosterAgentConfig[];
  /** One job at a time for now (P4: exactly one) — the roster takes turns against it until it
   * passes, a maxTurnsPerAgent ceiling is hit for everyone active, or the budget halts the run.
   * P5's real "6-10 jobs per window, alternating class" needs a queue of these, cycled through as
   * each is delivered or abandoned — not built here; see this file's own top comment. */
   job: JobEnvelope;
  maxTurnsPerAgent: number;
  budget: ExperimentBudget;
  deps: RunnerDeps;
  runsRoot: string;
  runId: string;
  manifest: RunManifest;
  /** This window's own real, compressed bounds (spec 9.2's "three weekly windows" compressed to
   * hours) — any real `mint_claim` in this window mints against these, not a fictional weekly
   * one, so `time_to_expiry` reflects the window an agent actually faces. Defaults to a generous
   * now-to-now+7days span when omitted (P4's solo pass never mints, so the exact bounds don't
   * matter there). */
  windowFrom?: bigint;
  windowTo?: bigint;
  /** Present only for a window whose roster can actually mint (an agent with `mint_claim` in its
   * tool grant) — see `MintContext`'s own doc comment. */
  mintContext?: MintContext;
  /** 1-based index of this window within a multi-window run, and how many there are in all.
   * Both default to 1, which is what a single-window run is. Only these two numbers make a
   * "later window" meaningful, so `quote_forward` is only usable where they are set. */
  windowIndex?: number;
  windowCount?: number;
  /** Every window's real bounds in a multi-window run, keyed by 1-based index and computed from
   * the chain clock before the first window opens. This is what makes a claim genuinely *dated*:
   * without it a buyer can only ever mint for the window it is standing in, which makes a claim a
   * slower way to pay for work about to be consumed rather than a reservation of future capacity —
   * the instrument's whole claimed property. Absent for a single-window run. */
  windowBoundsByIndex?: Record<number, { from: bigint; to: bigint }>;
  /** The forward-terms book. Supplied by a multi-window runner so it survives from one window to
   * the next — an offer stated in window 1 for window 3 has to still be there in window 3, and a
   * book created per window could never hold one. A fresh one is made when omitted. */
  forwardBook?: ForwardQuoteBook;
  /** Seed for the independent oracle's trial set (see task-pack-gate-hardening's code-oracle).
   * Defaults to `F1_ORACLE_TRIAL_SEED` and should stay there for any run whose attack yield is
   * meant to be compared with another run's — see that constant's own doc comment. Overridable
   * only for tests that need a different draw. */
  oracleSeed?: number;
  onTurn?: (agentId: AgentId, log: TurnLog) => void;
}

/** One real capacity- or instrument-moving action. `kind` names the tool that caused it; the
 * remaining fields are whichever of them that tool genuinely produces — a mint has a tokenId and
 * no quoteHash, a reservation the reverse, and a taken forward offer has neither because nothing
 * moves on-chain at all. */
export interface CapacityEvent {
  agentId: AgentId;
  turn: number;
  kind:
    | "mint_claim"
    | "pay_with_claim"
    | "transfer_claim"
    | "reserve_for_work"
    | "release_on_settle"
    | "redeem_claim"
    | "serve_redemption"
    | "settle_window_close"
    | "take_forward";
  quantityMilliSiu?: string;
  issuer?: string;
  tokenId?: string;
  quoteHash?: string;
  counterparty?: string;
  txHash?: string;
  /** Seconds until the claim's own window closes at the moment of the decision — §7.1(a)'s own
   * requirement that every hold and redeem decision carries it, so "they redeemed immediately"
   * can be told apart from "they redeemed under expiry pressure". */
  timeToExpirySeconds?: number;
  /** For take_forward only: the offer taken, since nothing on-chain records it. */
  forwardQuoteId?: string;
}

export interface AttackRecord {
  attacker: AgentId;
  turn: number;
  gateVersion: number;
  oracleSeed: number;
  classification: string;
  reason: string;
  countsAsAdversaryYield: boolean;
  countsAsGateOverRejection: boolean;
  gateAccepted?: boolean;
  oracleAccepted?: boolean;
  /** The attacking submission itself, kept verbatim: a false-accept finding is worth nothing if
   * the submission that produced it isn't reproducible. */
  submissionSource: string;
}

export interface TurnLog {
  turn: number;
  promptChars: number;
  projectedUsd: string;
  realizedUsd: string;
  latencyMs: number;
  parsed: string;
  gateResult?: { passed: boolean; summary: string };
  quarantinedNonDeterministicGate?: boolean;
  /** The quote-board text this agent's own prompt actually carried this turn, if any — real
   * evidence of what this agent could see of the market, not just what it did (empty when the
   * board had nothing for it, matching `buildTurnPrompt`'s own "omit when empty" convention). */
  marketBoardText?: string;
  /** The provider's own real reason the completion ended, and the real type of every content
   * block/part it returned — `Adapter`'s own new diagnostic fields (see harness/adapters/
   * types.ts), threaded straight through so a real turn's own raw shape survives into
   * metrics.json rather than only ever existing in memory. Added 2026-09-26: a real call
   * (claude-sonnet-5, P5 window 1) returned no text for a real, separately-billed $0.24 request,
   * and nothing persisted anywhere let this be diagnosed after the fact. */
  stopReason?: string;
  usage?: { input: number; output: number; cached_input: number; reasoning: number };
  contentBlockTypes?: string[];
  /** Set exactly when this turn ended because the provider failed or declined the call, rather
   * than because of anything the model produced — see the adapter-call guard in the loop. */
  providerFailure?: { category: FailureCategory; message: string };
  /** Set exactly on a turn that ran `submit_attack`. */
  attack?: { gateVersion: number; classification: string; countsAsAdversaryYield: boolean };
}

export interface FullRunWindowResult {
  passed: boolean;
  passedBy?: AgentId;
  totalRealizedUsd: string;
  /** Real inference spend this run, per provider — decimal-string USD. Lands in metrics.json via
   * `recorder.finalizeMetrics(result)`. A single aggregate can't answer the question that
   * matters operationally: which provider accounts this run drew on, including the ones the
   * daily print series also runs through. */
  spendByProvider: Record<string, string>;
  /** Every agent-authored attack against a delivered gate, in order — the evidence behind both
   * "adversarial yield" (spec §3.1) and the gate's own measured false-accept rate, which is the
   * artefact §1.3 says the project keeps whether or not fSIU is ever built. */
  attacks: AttackRecord[];
  /** Each gate the builder delivered, in order — an attack names the version it was aimed at, so
   * a revision that closed a hole is visible as such rather than inferred from ordering. */
  gateVersions: { version: number; submittedBy: string; turn: number }[];
  /** Every forward offer stated in this run so far, taken or not — the whole book, not this
   * window's slice, since a multi-window runner shares one book and the interesting reading is
   * across windows. */
  forwardQuotes: readonly ForwardQuote[];
  /** Every turn on which an agent was actually shown the invitation to state forward terms.
   *
   * Exists so that a run with no forward quotes is attributable rather than merely empty:
   * "issuers were prompted and chose not to quote" and "issuers never reached a turn where they
   * could" are different findings, and without this record they look identical in the output. An
   * entry here means the agent genuinely saw the invitation in its own prompt — not that the tool
   * was in its grant. */
  forwardInvitations: { agentId: AgentId; turn: number }[];
  /** Every real, confirmed action that moved capacity or an instrument, with its transaction
   * hash where one exists. Assembled from the tool results themselves rather than from the
   * models' own accounts of what they did, so the report can state what happened on-chain
   * without re-deriving it from prose in the turn logs. */
  capacityEvents: CapacityEvent[];
  turnsByAgent: Record<string, number>;
  haltedReason?: Record<string, "ceiling" | "parse_error" | "max_turns" | "validation_failed" | "voluntary_stop" | "experiment_halt" | "policy_refusal" | "adapter_error" | "nothing_to_act_on">;
  turnLogsByAgent: Record<string, TurnLog[]>;
}

function summarizeGateResult(result: GateHardeningResult): string {
  if (result.passed) return "G1-G6 all passed";
  const checks = [
    ["G1", result.g1], ["G2", result.g2], ["G3", result.g3],
    ["G4", result.g4], ["G5", result.g5], ["G6", result.g6],
  ] as const;
  return checks.filter(([, c]) => !c.passed).map(([n, c]) => `${n} failed: ${c.reason}`).join("; ");
}

const DEFAULT_FRICTION: Required<FrictionReport> = {
  could_not_express: null,
  forced_conversion: false,
  conversion_reason: null,
  missing_information: null,
  decision_confidence: "medium",
};

/** Real, but only for the (currently empty) case where an agent holds a known claim past this
 * turn without redeeming it — P4's ORCHESTRATOR never mints/holds a claim (it authors gates
 * directly), so this always logs `time_to_expiry_seconds: null` for P4. Kept real and wired
 * rather than stubbed so a future P5 agent that does hold claims gets a genuine log, not a retrofit. */
async function holdTimeToExpiry(
  deps: RunnerDeps,
  heldTokenId: bigint | null,
): Promise<number | null> {
  if (heldTokenId === null) return null;
  const [{ windowTo }, now] = await Promise.all([
    deps.chainReader.claimWindow(heldTokenId),
    deps.chainReader.currentBlockTimestamp(),
  ]);
  return computeTimeToExpirySeconds(now, windowTo);
}

/** A small, deterministic 32-bit hash — seeds the shuffle below from a real string (the run's
 * own manifest seed plus the agent id), not from wall-clock time, so the same real seed always
 * reproduces the same real order (an audit can recompute it, not just trust the manifest). */
function hashSeed(input: string): number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Found live (WORKER-CODE/claude-sonnet-5, P5 window 1, 2026-09-26): LLMs show a real ordering
 * bias — the first-listed or most prominently described tool gets picked more. Before any
 * asset-choice result (fSIU vs USDC) is trusted, the tool list a model actually saw must not be
 * fixed in the same order every real turn, every real run — that would make "which asset did it
 * choose" partly an artefact of tools.yaml's own literal ordering rather than a genuine decision.
 * Deterministic per (seed, agentId): same seed always reproduces the same real order (recorded in
 * the manifest below), not silently unreproducible.
 */
export function shuffledToolOrder<T>(items: readonly T[], seedInput: string): T[] {
  const rand = mulberry32(hashSeed(seedInput));
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function runFullRunWindow(options: FullRunWindowOptions): Promise<FullRunWindowResult> {
  // Computed before RunRecorder is constructed so the real order used is recorded in the
  // manifest from turn one, not added after the fact.
  const toolOrderByAgent: Record<string, readonly ToolName[]> = {};
  for (const agent of options.roster) {
    toolOrderByAgent[agent.agentId] = shuffledToolOrder(
      agent.availableTools,
      `${options.manifest.seed}:${agent.agentId}`,
    );
  }
  const manifestWithToolOrder: RunManifest = { ...options.manifest, toolOrderByAgent };
  const recorder = new RunRecorder(options.runsRoot, options.runId, manifestWithToolOrder);
  const friction = new FrictionLogWriter(options.runsRoot, options.runId);
  const board = new QuoteBoard();
  const forwardBook = options.forwardBook ?? new ForwardQuoteBook();
  const windowIndex = options.windowIndex ?? 1;
  const windowCount = options.windowCount ?? 1;
  const redemption = new RedemptionTracker();
  const agentIdByAddress = Object.fromEntries(
    options.roster.map((a) => [a.address.toLowerCase(), a.agentId]),
  ) as Record<string, AgentId>;

  // The chain's own clock, never `Date.now()` — the same rule `devnet/anvil.ts`'s `advanceTime`
  // already states for `time_to_expiry`, applied to the window bounds themselves. `mint` writes
  // `windowFrom` into the claim and `presentForRedemption` compares it against `block.timestamp`,
  // so a window opened against wall time is a window whose opening instant the contract may not
  // agree has arrived: on a devnet whose clock runs behind wall time the very next call reverts
  // `WindowNotOpenYet`, and on one running ahead the window silently opens early.
  const nowSeconds = await options.deps.chainReader.currentBlockTimestamp();
  const windowFrom = options.windowFrom ?? nowSeconds;
  const windowTo = options.windowTo ?? nowSeconds + 7n * 24n * 3600n;

  const agentAddressByAgentId = Object.fromEntries(
    options.roster.map((a) => [a.agentId, a.address]),
  ) as Partial<Record<AgentId, string>>;

  const runners = new Map(
    options.roster.map((agent) => [
      agent.agentId,
      new Runner({
        agentId: agent.agentId,
        windowId: options.windowId,
        privateKeyHex: agent.privateKeyHex,
        rpcUrl: agent.rpcUrl,
        deps: options.deps,
        ceiling: options.budget,
        allowedTools: agent.availableTools,
      }),
    ]),
  );

  const turnsByAgent: Record<string, number> = {};
  const haltedReason: FullRunWindowResult["haltedReason"] = {};
  const turnLogsByAgent: Record<string, TurnLog[]> = {};
  let totalRealizedUsd = 0;
  const realizedUsdByProvider: Record<string, number> = {};
  const attacks: AttackRecord[] = [];
  const forwardInvitations: { agentId: AgentId; turn: number }[] = [];
  const capacityEvents: CapacityEvent[] = [];
  const attackContext: AttackContext = {
    gateVersions: [],
    attackedVersions: new Set<number>(),
    oracleSeed: options.oracleSeed ?? F1_ORACLE_TRIAL_SEED,
  };
  let passed = false;
  let passedBy: AgentId | undefined;

  for (const agent of options.roster) {
    turnsByAgent[agent.agentId] = 0;
    turnLogsByAgent[agent.agentId] = [];
  }

  const activeAgents = new Set(options.roster.map((a) => a.agentId));

  turnLoop: for (let turnCursor = 0; ; turnCursor++) {
    if (activeAgents.size === 0) break;
    const agent = options.roster[turnCursor % options.roster.length];
    if (!activeAgents.has(agent.agentId)) continue;

    const turn = turnsByAgent[agent.agentId] + 1;
    if (turn > options.maxTurnsPerAgent) {
      haltedReason[agent.agentId] = "max_turns";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const runner = runners.get(agent.agentId)!;

    if (options.budget.isHalted(agent.agentId, options.windowId)) {
      haltedReason[agent.agentId] = "ceiling";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const context = assembleContext(agent.agentId, agent.skillPackText, runner.toolCallRecords());
    recorder.recordContext(agent.agentId, turn, context);

    try {
      validateAgentContext(context);
      recorder.recordValidatorVerdict(agent.agentId, turn, null);
    } catch (err) {
      if (err instanceof ContextValidationError) recorder.recordValidatorVerdict(agent.agentId, turn, err);
      haltedReason[agent.agentId] = "validation_failed";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const marketBoardText = board.renderFor(agent.agentId, agent.erc8004Id);
    const redemptionText = redemption.renderFor(agent.agentId);
    const transferText = redemption.renderForHolder(agent.agentId);
    const deliveryOwedText = redemption.renderForIssuerAwaitingDelivery(agent.agentId);
    const canQuoteForward = agent.availableTools.includes("quote_forward");
    // An issuer's own standing offers are NOT an inbox item: they are not an arrival, and an
    // issuer whose only reason to wake is its own earlier quote would spin turns re-reading it.
    const forwardText = forwardBook.renderFor(agent.agentId, windowIndex, canQuoteForward);
    // The one exception, and the reason it is separate: an issuer that has not yet stated terms
    // for a later window genuinely does have something to do before anything is routed to it —
    // and gating that on an inbox would mean it could only ever quote *after* being minted
    // against, which is exactly when a forward offer stops being forward. Once it has quoted,
    // this line disappears and the ordinary wait-gate applies again, so the wake is worth at most
    // one turn per window rather than every turn.
    const mayStillQuoteForward =
      canQuoteForward && forwardBook.quotesBy(agent.agentId).every((q) => q.statedInWindow !== windowIndex);
    const forwardInvitation = mayStillQuoteForward
      ? `FORWARD TERMS\n  You have not stated terms for a later window of this run yet. You may (quote_forward), ` +
        `or you may choose not to — nothing here suggests a price, a quantity, or whether to quote at all.`
      : "";
    const boardSectionText = [marketBoardText, redemptionText, transferText, deliveryOwedText, forwardInvitation]
      .filter(Boolean)
      .join("\n\n");

    // Skipped before the model is called and before the turn counter moves, so waiting costs
    // nothing. Guarded against a stall: if every remaining agent is waiting, nothing will ever
    // arrive to wake them, so the window ends rather than spinning.
    if (
      (agent.waitsFor === "gate" && attackContext.gateVersions.length === 0) ||
      (agent.waitsFor === "inbox" && boardSectionText === "")
    ) {
      const someoneCanAct = [...activeAgents].some((id) => {
        const other = options.roster.find((r) => r.agentId === id);
        if (!other?.waitsFor) return true;
        if (other.waitsFor === "gate") return attackContext.gateVersions.length > 0;
        return (
          board.renderFor(other.agentId, other.erc8004Id) !== "" ||
          redemption.renderFor(other.agentId) !== "" ||
          redemption.renderForHolder(other.agentId) !== "" ||
          redemption.renderForIssuerAwaitingDelivery(other.agentId) !== "" ||
          (other.availableTools.includes("quote_forward") &&
            forwardBook.quotesBy(other.agentId).every((q) => q.statedInWindow !== windowIndex))
        );
      });
      if (someoneCanAct) continue;
      for (const waiting of activeAgents) {
        if (options.roster.find((r) => r.agentId === waiting)?.waitsFor) {
          haltedReason[waiting] = "nothing_to_act_on";
        }
      }
      break turnLoop;
    }

    // Recorded here, not where the invitation text is built: an agent that is gated out before
    // its adapter is called never actually saw it, and counting that as "prompted" is exactly the
    // conflation this record exists to prevent.
    if (forwardInvitation !== "") forwardInvitations.push({ agentId: agent.agentId, turn });

    const prompt = buildTurnPrompt(
      context,
      toolOrderByAgent[agent.agentId],
      [boardSectionText, forwardText].filter(Boolean).join("\n\n"),
    );
    const projectedUsd = projectedTurnCostUsd(Math.ceil(prompt.length / 4), agent.maxOutputTokens, agent.prices);

    try {
      options.budget.recordInferenceSpend(agent.agentId, options.windowId, projectedUsd);
    } catch (err) {
      if (err instanceof ExperimentCapExceededError) {
        // A run/experiment-cap breach is the whole run's problem, not just this agent's — stop
        // scheduling everyone, not only the agent whose turn happened to trip it.
        for (const other of activeAgents) haltedReason[other] = "experiment_halt";
        break turnLoop;
      }
      if (err instanceof CeilingExceededError) {
        haltedReason[agent.agentId] = "ceiling";
        activeAgents.delete(agent.agentId);
        continue;
      }
      throw err;
    }

    turnsByAgent[agent.agentId] = turn;

    const adapterParams: AdapterParams = {
      temperature: agent.temperature,
      max_tokens: agent.maxOutputTokens,
    };

    // The adapter call was previously unguarded: a provider error took down the whole run, and a
    // refusal that came back as a successful-but-empty response fell through to the parser and was
    // recorded as the model failing to produce valid JSON. Both misread an environmental fact as
    // agent behaviour, which for this roster — whose prompts legitimately discuss probing a
    // grader — is exactly the wrong attribution. Errors now halt only the agent they happened to,
    // classified, with a policy refusal distinguished from everything else.
    let adapterResult;
    try {
      adapterResult = await agent.adapter(agent.modelString, prompt, adapterParams);
    } catch (err) {
      const category = classifyFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd: "0",
        marketBoardText: marketBoardText || undefined, latencyMs: 0,
        parsed: `${category}: ${message}`,
        providerFailure: { category, message },
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      haltedReason[agent.agentId] = category === "policy_refusal" ? "policy_refusal" : "adapter_error";
      activeAgents.delete(agent.agentId);
      await friction.append(
        buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null, {
          attempted: "model call",
          outcome: `provider ${category}: ${message}`,
        }),
      );
      continue;
    }

    const realizedUsd = realizedTurnCostUsd(adapterResult.usage.input, adapterResult.usage.output, agent.prices);
    totalRealizedUsd += Number(realizedUsd);
    realizedUsdByProvider[agent.provider] = (realizedUsdByProvider[agent.provider] ?? 0) + Number(realizedUsd);

    // A refusal that arrives on a 200 — the commoner shape, reported via the provider's own stop
    // reason. Caught before parsing, so it is never recorded as unparseable output.
    if (isPolicyRefusalStopReason(adapterResult.stopReason)) {
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd,
        marketBoardText: marketBoardText || undefined, latencyMs: adapterResult.latency_ms,
        stopReason: adapterResult.stopReason, usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
        parsed: `policy_refusal: provider returned stop reason "${adapterResult.stopReason}"`,
        providerFailure: { category: "policy_refusal", message: `stop reason "${adapterResult.stopReason}"` },
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      haltedReason[agent.agentId] = "policy_refusal";
      activeAgents.delete(agent.agentId);
      await friction.append(
        buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null, {
          attempted: "model call",
          outcome: `provider policy_refusal (stop reason "${adapterResult.stopReason}")`,
        }),
      );
      continue;
    }

    let intent;
    try {
      intent = parseModelResponse(adapterResult.text);
    } catch (err) {
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd, marketBoardText: marketBoardText || undefined,
        latencyMs: adapterResult.latency_ms,
        stopReason: adapterResult.stopReason, usage: adapterResult.usage, contentBlockTypes: adapterResult.contentBlockTypes,
        parsed: err instanceof Error ? err.message : String(err),
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      if (err instanceof ModelResponseParseError) {
        haltedReason[agent.agentId] = "parse_error";
        activeAgents.delete(agent.agentId);
        await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null));
        continue;
      }
      throw err;
    }

    if ("done" in intent) {
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd, marketBoardText: marketBoardText || undefined,
        latencyMs: adapterResult.latency_ms, parsed: JSON.stringify(intent),
        stopReason: adapterResult.stopReason, usage: adapterResult.usage, contentBlockTypes: adapterResult.contentBlockTypes,
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      haltedReason[agent.agentId] = "voluntary_stop";
      activeAgents.delete(agent.agentId);
      await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null));
      continue;
    }

    let args: unknown;
    try {
      args = await buildToolArgs(intent.tool, intent.args, {
        job: options.job,
        board,
        agentAddressByAgentId,
        deployment: options.deps.deployment,
        windowFrom,
        windowTo,
        mintContext: options.mintContext,
        attackContext,
        forwardBook,
        windowIndex,
        windowCount,
        windowBoundsByIndex: options.windowBoundsByIndex,
        caller: { agentId: agent.agentId, erc8004Id: agent.erc8004Id },
      });
    } catch (err) {
      // A real, disclosed failure (an unknown requestId, a missing address) — not a crash. The
      // model's own next turn sees this in its tool-call history exactly like any other tool
      // error, since Runner.callTool would have surfaced the same shape for a real revert.
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd, marketBoardText: marketBoardText || undefined,
        latencyMs: adapterResult.latency_ms,
        stopReason: adapterResult.stopReason, usage: adapterResult.usage, contentBlockTypes: adapterResult.contentBlockTypes,
        parsed: `${JSON.stringify(intent)} -> args error: ${err instanceof Error ? err.message : String(err)}`,
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null));
      continue;
    }

    try {
      // Always the real, recorded call — allowlist-checked and ceiling-charged exactly once via
      // Runner, regardless of which tool this is. The determinism check (below) is an *extra*
      // verification alongside this, never a substitute for it — bypassing Runner to "check
      // twice instead of calling for real" would skip the allowlist check for this specific tool.
      const record = await runner.callTool(intent.tool, args, { turn, jobId: options.job.jobId });
      let quarantined = false;

      // Read from the tool's own real result, never from the model's account of what it did. The
      // seconds-to-expiry is the same chain-clock figure §7.1(a) requires on every hold and redeem
      // decision, so a "they redeemed immediately" reading can be separated from expiry pressure.
      const recordCapacityEvent = async (
        kind: CapacityEvent["kind"],
        fields: Omit<CapacityEvent, "agentId" | "turn" | "kind">,
      ): Promise<void> => {
        let timeToExpirySeconds: number | undefined;
        if (fields.tokenId !== undefined) {
          try {
            timeToExpirySeconds =
              (await holdTimeToExpiry(options.deps, BigInt(fields.tokenId))) ?? undefined;
          } catch {
            // A claim whose window cannot be read is still a real event; recording it without the
            // figure beats dropping the event or inventing one.
          }
        }
        capacityEvents.push({
          agentId: agent.agentId,
          turn,
          kind,
          ...(timeToExpirySeconds === undefined ? {} : { timeToExpirySeconds }),
          ...fields,
        });
      };

      if (intent.tool === "request_quote") {
        board.postRequest(agent.agentId, record.result as QuoteBody);
      }
      if (intent.tool === "issue_quote") {
        const requestId = (intent.args as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === "string") {
          board.postIssuedQuote(requestId, record.result as TouchstoneQuote);
        }
      }

      if (intent.tool === "mint_claim") {
        const mintResult = record.result as { tokenId: string; issuer: string; txHash?: string };
        const issuerAgentId = agentIdByAddress[mintResult.issuer.toLowerCase()];
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        if (issuerAgentId && typeof quantity === "string") {
          redemption.recordMint(mintResult.tokenId, issuerAgentId, quantity);
        }
        await recordCapacityEvent("mint_claim", {
          tokenId: mintResult.tokenId,
          issuer: mintResult.issuer,
          ...(typeof quantity === "string" ? { quantityMilliSiu: quantity } : {}),
          ...(mintResult.txHash ? { txHash: mintResult.txHash } : {}),
        });
      }

      if (intent.tool === "transfer_claim") {
        const to = (args as { to?: unknown } | undefined)?.to;
        if (typeof to === "string") {
          const recipientAgentId = agentIdByAddress[to.toLowerCase()];
          if (recipientAgentId) redemption.recordTransfer(recipientAgentId);
        }
        const transferred = record.result as { txHash?: string };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        await recordCapacityEvent("transfer_claim", {
          ...(typeof tokenId === "string" ? { tokenId } : {}),
          ...(typeof quantity === "string" ? { quantityMilliSiu: quantity } : {}),
          ...(typeof to === "string" ? { counterparty: to } : {}),
          ...(transferred.txHash ? { txHash: transferred.txHash } : {}),
        });
      }

      // One call, but the same two real events mint_claim + transfer_claim would have produced —
      // so the redemption tracker sees an fSIU payment identically whichever tool made it.
      if (intent.tool === "pay_with_claim") {
        const paid = record.result as {
          tokenId: string; issuer: string; quantity: string; mintTxHash?: string; transferTxHash?: string;
        };
        const issuerAgentId = agentIdByAddress[paid.issuer.toLowerCase()];
        if (issuerAgentId) redemption.recordMint(paid.tokenId, issuerAgentId, paid.quantity);
        const to = (args as { to?: unknown } | undefined)?.to;
        if (typeof to === "string") {
          const recipientAgentId = agentIdByAddress[to.toLowerCase()];
          if (recipientAgentId) redemption.recordTransfer(recipientAgentId);
        }
        // One tool call, two real transactions — both hashes kept, since a run record must never
        // show a payment that half-occurred as if it had completed.
        await recordCapacityEvent("pay_with_claim", {
          tokenId: paid.tokenId,
          issuer: paid.issuer,
          quantityMilliSiu: paid.quantity,
          ...(typeof to === "string" ? { counterparty: to } : {}),
          ...(paid.mintTxHash ? { txHash: `${paid.mintTxHash} (mint) / ${paid.transferTxHash ?? "?"} (transfer)` } : {}),
        });
      }

      if (intent.tool === "reserve_for_work") {
        const reserved = record.result as {
          txHash: string; quoteHash: string; issuer: string; quantity: string; deadline: string;
        };
        await recordCapacityEvent("reserve_for_work", {
          quoteHash: reserved.quoteHash,
          issuer: reserved.issuer,
          quantityMilliSiu: reserved.quantity,
          txHash: reserved.txHash,
        });
      }

      if (intent.tool === "settle_escrow") {
        const settled = record.result as { txHash: string; releaseTxHash?: string };
        if (settled.releaseTxHash) {
          await recordCapacityEvent("release_on_settle", { txHash: settled.releaseTxHash });
        }
      }

      if (intent.tool === "serve_redemption") {
        const served = record.result as { txHash?: string };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        const passed = (args as { passed?: unknown } | undefined)?.passed;
        if (passed === true) {
          await recordCapacityEvent("serve_redemption", {
            ...(typeof tokenId === "string" ? { tokenId } : {}),
            ...(typeof quantity === "string" ? { quantityMilliSiu: quantity } : {}),
            ...(served.txHash ? { txHash: served.txHash } : {}),
          });
        }
      }

      if (intent.tool === "settle_window_close") {
        const settled = record.result as { txHash?: string };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        await recordCapacityEvent("settle_window_close", {
          ...(typeof tokenId === "string" ? { tokenId } : {}),
          ...(settled.txHash ? { txHash: settled.txHash } : {}),
        });
      }

      if (intent.tool === "quote_forward") {
        const quoted = record.result as {
          forWindow: number;
          rateUsdPerSiu: string;
          maxQuantityMilliSiu: string;
          issuerHeadroomAtQuote: string;
        };
        forwardBook.record({
          issuer: agent.agentId,
          forWindow: quoted.forWindow,
          statedInWindow: windowIndex,
          rateUsdPerSiu: quoted.rateUsdPerSiu,
          maxQuantityMilliSiu: quoted.maxQuantityMilliSiu,
          issuerHeadroomAtQuote: quoted.issuerHeadroomAtQuote,
        });
      }

      if (intent.tool === "take_forward") {
        const taken = record.result as { quoteId: string };
        // Already validated as open in buildToolArgs, immediately before this call — a false
        // here would mean the book changed underneath a single-threaded loop, so it is recorded
        // as a real anomaly rather than ignored.
        if (!forwardBook.markTaken(taken.quoteId, agent.agentId, windowIndex)) {
          throw new Error(
            `take_forward: ${taken.quoteId} could not be marked taken — it was open when this turn began.`,
          );
        }
        const offer = forwardBook.byId(taken.quoteId);
        // No txHash, deliberately: nothing moves on-chain. Recorded all the same, because
        // "took an offer" and "ignored every offer" are the two findings this arm exists to tell
        // apart, and an event with no hash states that honestly.
        await recordCapacityEvent("take_forward", {
          forwardQuoteId: taken.quoteId,
          ...(offer ? { issuer: offer.issuer, quantityMilliSiu: offer.maxQuantityMilliSiu } : {}),
        });
      }

      if (intent.tool === "redeem_claim") {
        redemption.recordPresented(agent.agentId);
        const presented = record.result as { txHash?: string; timeToExpirySeconds?: number };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        await recordCapacityEvent("redeem_claim", {
          ...(typeof tokenId === "string" ? { tokenId } : {}),
          // `redeem_claim` already measures this at the instant of the decision, against the same
          // chain clock — preferred over re-reading it a moment later.
          ...(typeof presented.timeToExpirySeconds === "number"
            ? { timeToExpirySeconds: presented.timeToExpirySeconds }
            : {}),
          ...(presented.txHash ? { txHash: presented.txHash } : {}),
        });
      }

      if (intent.tool === "serve_redemption") {
        redemption.recordServed();
      }

      if (intent.tool === "submit_job") {
        // Runner's own call above is the real, recorded first invocation — one genuinely fresh
        // extra invocation, compared directly against it, is what actually checks determinism
        // (checkGateDeterminism's own two-thunk shape is for a caller with no first result yet).
        const secondOpinion = await options.deps.runGateHardeningChecks(
          args as unknown as GateHardeningJobInputs,
        );
        quarantined = !gateResultsMatch(record.result as GateHardeningResult, secondOpinion);
      }

      // Every delivered gate becomes an attackable version, whether or not it passed G1-G6: a
      // gate that passes the pack's own fixtures is exactly the one worth testing against a
      // submission an agent actually wrote.
      if (intent.tool === "submit_job") {
        const submitted = (args as GateHardeningJobInputs).hardenedGate.source;
        attackContext.gateVersions.push({
          version: attackContext.gateVersions.length + 1,
          source: submitted,
          submittedBy: agent.agentId,
          turn,
        });
      }

      let attackOutcome: AttackToolResult | undefined;
      if (intent.tool === "submit_attack") {
        attackOutcome = record.result as AttackToolResult;
        attackContext.attackedVersions.add(attackOutcome.gateVersion);
        attacks.push({
          attacker: agent.agentId,
          turn,
          gateVersion: attackOutcome.gateVersion,
          oracleSeed: attackOutcome.oracleSeed,
          classification: attackOutcome.classification,
          reason: attackOutcome.reason,
          countsAsAdversaryYield: attackOutcome.countsAsAdversaryYield,
          countsAsGateOverRejection: attackOutcome.countsAsGateOverRejection,
          gateAccepted: attackOutcome.gate.accept,
          oracleAccepted: attackOutcome.oracle.accept,
          submissionSource: (args as { submissionSource: string }).submissionSource,
        });
      }

      const gateResult = intent.tool === "submit_job" && !quarantined
        ? (record.result as GateHardeningResult)
        : undefined;

      // A real, deterministic receiptRef tied to this job — never invented — so the issuer's
      // eventual serve_redemption call references the same job an on-chain observer could
      // independently recompute. Skipped when quarantined: a non-deterministic gate result is not
      // a trustworthy verdict to route toward a real redemption.
      //
      // Found live, 2026-09-26 (see data/gate-market/first-real-default-2026-09-26.json):
      // redemption grades the routed ISSUER's own delivery, never the holder's — the holder
      // supplies only a task spec; the gate grades the issuer's own served output
      // (WorkClaim.sol's own top doc comment). A submit_job call from any agent OTHER than the
      // routed issuer for this claim must never reach the tracker, whatever its own verdict.
      if (gateResult && agent.agentId === redemption.state().issuerAgentId) {
        redemption.recordGraded(gateResult.passed, keccak256(stringToBytes(`receipt:${options.job.jobId}`)));
      }

      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd, marketBoardText: marketBoardText || undefined,
        latencyMs: adapterResult.latency_ms, parsed: JSON.stringify(intent),
        quarantinedNonDeterministicGate: quarantined || undefined,
        stopReason: adapterResult.stopReason, usage: adapterResult.usage, contentBlockTypes: adapterResult.contentBlockTypes,
      };
      if (gateResult) {
        log.gateResult = { passed: gateResult.passed, summary: summarizeGateResult(gateResult) };
      }
      if (attackOutcome) {
        log.attack = {
          gateVersion: attackOutcome.gateVersion,
          classification: attackOutcome.classification,
          countsAsAdversaryYield: attackOutcome.countsAsAdversaryYield,
        };
      }
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);

      const timeToExpiry = await holdTimeToExpiry(options.deps, null);
      await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, timeToExpiry));

      if (gateResult?.passed) {
        // Found live wiring the redemption tracker (2026-09-26, P5 planning): breaking the loop
        // the instant *any* submit_job passes was correct for P4's shape (one agent, no claim in
        // play — the job passing IS the window's whole point) but would end a P5 fSIU window
        // before its routed issuer ever gets a turn to see or serve a real pending redemption.
        // Every existing test mints nothing, so `tokenId` is always undefined there and this is
        // byte-identical to the old unconditional break — this only changes behaviour for a
        // window that actually minted a claim still awaiting service.
        if (passedBy === undefined) {
          passed = true;
          passedBy = agent.agentId;
        }
        const claimOutstanding = redemption.state().tokenId !== undefined && !redemption.state().served;
        if (!claimOutstanding) {
          break turnLoop;
        }
      }
    } catch (err) {
      if (err instanceof CeilingExceededError) {
        haltedReason[agent.agentId] = "ceiling";
        activeAgents.delete(agent.agentId);
        continue;
      }
      if (err instanceof ZodError) {
        // A real, disclosed tool-args validation failure — found live, 2026-09-26, P5 window 1:
        // ISSUER-A copied the redemption tracker's own rendered "quantity 10000" text into a
        // JSON *number* rather than the decimal string the real schema requires (nothing in the
        // rendered text or the tool description said it must be a string). This is model output,
        // not infra — never retried, the same distinction this window's own design already
        // draws for a parse failure — but it must not crash every other agent's own turn either.
        // Logged and continued, exactly like buildToolArgs's own disclosed failures above.
        const log: TurnLog = {
          turn, promptChars: prompt.length, projectedUsd, realizedUsd, marketBoardText: marketBoardText || undefined,
          latencyMs: adapterResult.latency_ms,
          stopReason: adapterResult.stopReason, usage: adapterResult.usage, contentBlockTypes: adapterResult.contentBlockTypes,
          parsed: `${JSON.stringify(intent)} -> tool args validation error: ${err.message}`,
        };
        turnLogsByAgent[agent.agentId].push(log);
        options.onTurn?.(agent.agentId, log);
        await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null));
        continue;
      }
      // Everything else — a real on-chain revert (ContractFunctionExecutionError), a
      // ToolNotAllowedError, a tool's own thrown Error (e.g. pay_with_claim's "found no Minted
      // event") — is a real, disclosed tool-call failure, not a crash. Found live, 2026-09-28,
      // first real three-window run: ORCHESTRATOR's very first pay_with_claim call reverted on
      // `safeTransferFrom` with ERC1155InsufficientBalance even though the preceding mint had
      // genuinely confirmed (re-querying moments later showed the correct minted balance) — the
      // exact RPC-lag family `@touchstone/sdk`'s `retryUntilConclusive` doc comment already
      // names three instances of, hit here as a fourth. Before this fix, ANY such failure — RPC
      // lag, a genuine revert, a model naming a tool outside its own grant — terminated the
      // entire process, discarding every other agent's turns and this run's whole real spend.
      // Every other error category above already treats its own failures as disclosed rather
      // than fatal; this makes that the rule rather than the exception. `main()`'s own top-level
      // `.catch` remains the backstop for a genuinely unrecoverable launch-time failure (a
      // missing env var, an unreachable RPC endpoint) — those throw before this loop ever runs.
      {
        const log: TurnLog = {
          turn, promptChars: prompt.length, projectedUsd, realizedUsd, marketBoardText: marketBoardText || undefined,
          latencyMs: adapterResult.latency_ms,
          stopReason: adapterResult.stopReason, usage: adapterResult.usage, contentBlockTypes: adapterResult.contentBlockTypes,
          parsed: `${JSON.stringify(intent)} -> tool call error: ${err instanceof Error ? err.message : String(err)}`,
        };
        turnLogsByAgent[agent.agentId].push(log);
        options.onTurn?.(agent.agentId, log);
        await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null));
        continue;
      }
    }
  }

  const result: FullRunWindowResult = {
    passed,
    passedBy,
    totalRealizedUsd: totalRealizedUsd.toFixed(6),
    attacks,
    gateVersions: attackContext.gateVersions.map(({ version, submittedBy, turn: t }) => ({
      version,
      submittedBy,
      turn: t,
    })),
    spendByProvider: Object.fromEntries(
      Object.entries(realizedUsdByProvider)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([provider, usd]) => [provider, usd.toFixed(6)]),
    ),
    forwardQuotes: forwardBook.all(),
    forwardInvitations,
    capacityEvents,
    turnsByAgent,
    haltedReason,
    turnLogsByAgent,
  };
  recorder.finalizeMetrics(result);
  return result;
}

function buildFrictionEntry(
  agentId: AgentId,
  turn: number,
  jobId: string,
  report: FrictionReport | undefined,
  timeToExpirySeconds: number | null,
  overrides?: { attempted?: string; outcome?: string },
): FrictionLogEntry {
  const merged = { ...DEFAULT_FRICTION, ...report };
  return {
    agent: agentId,
    turn,
    job_id: jobId,
    attempted: overrides?.attempted ?? "turn taken",
    outcome: overrides?.outcome ?? "recorded",
    could_not_express: merged.could_not_express,
    forced_conversion: merged.forced_conversion,
    conversion_reason: merged.conversion_reason,
    missing_information: merged.missing_information,
    decision_confidence: merged.decision_confidence,
    time_to_expiry_seconds: timeToExpirySeconds,
  };
}

export interface BuildToolArgsContext {
  job: JobEnvelope;
  board: QuoteBoard;
  agentAddressByAgentId: Partial<Record<AgentId, string>>;
  deployment: RunnerDeps["deployment"];
  windowFrom: bigint;
  windowTo: bigint;
  /** Who is taking this turn. Needed to resolve "my own escrows" and "the quote I signed" from
   * the board without the model naming them — the same splice discipline `pay` already uses for
   * the quote object itself. */
  caller?: { agentId: AgentId; erc8004Id: string };
  mintContext?: MintContext;
  /** Live, mutated by the loop as gates are delivered and attacked — see `submit_attack`'s case
   * below for why an adversary may choose neither its own target nor its own oracle seed. */
  attackContext?: AttackContext;
  /** The forward-terms book and where this window sits in the run — both needed to tell a
   * "later window" from an impossible one, and to resolve a take against a real open offer. */
  forwardBook?: ForwardQuoteBook;
  windowIndex?: number;
  windowCount?: number;
  /** See `FullRunWindowOptions.windowBoundsByIndex`. */
  windowBoundsByIndex?: Record<number, { from: bigint; to: bigint }>;
}

/** Gate v1 -> attacks -> the builder may revise -> attacks again. Capped so an adaptive exchange
 * cannot spend the whole run's budget on itself. */
export const MAX_ATTACK_ROUNDS = 3;

/**
 * The oracle's trial set is pinned to this one constant for every F1 run, and is deliberately NOT
 * derived from a run's own seed. F1 compares runs against each other: if each run scored its
 * attacks against a different set of generated arrays, a gate could pass in one run and fail in
 * the next on a case the first never tried, and the yields would not be comparable — the
 * comparison would be measuring the trial draw rather than the agents. Runs differ in agent
 * behaviour (temperature 0.7 and a per-run label); they do not differ in what "defeated the gate"
 * means. Changing this constant invalidates cross-run comparison with everything run before it.
 */
export const F1_ORACLE_TRIAL_SEED = 20260927;

export interface DeliveredGate {
  version: number;
  source: string;
  submittedBy: AgentId;
  turn: number;
}

export interface AttackContext {
  gateVersions: DeliveredGate[];
  attackedVersions: Set<number>;
  oracleSeed: number;
}

/** The real class ids `WorkClaim`/`CapacityBond` already use — `keccak256(bytes(taskClass))`,
 * matching `devnet/deploy.ts`'s own `CLASS_CODE`/`CLASS_EXTRACT` computation exactly (confirmed
 * independently, not re-derived by guesswork) without importing a devnet-only module into a
 * real-chain loop. */
export function classIdFor(taskClass: TaskClass): Hex {
  return keccak256(stringToBytes(taskClass));
}

/** Found live, 2026-09-26 (P5 window 1): ISSUER-A copied the redemption tracker's own rendered
 * "quantity 10000" text into a JSON *number* rather than the decimal string every real tool
 * schema here requires (this repo's own "no floats in money maths — decimal strings throughout"
 * convention, but nothing told the model that) — a real, uncaught ZodError crashed the whole run.
 * The loop itself now recovers from this (see runFullRunWindow's own ZodError catch), but the
 * cheaper, turn-saving fix is tolerating the mistake at the boundary: a model's own economic
 * decision (how much) is never invented here, only its literal JSON type when it's unambiguous
 * (a bare number always has an exact decimal-string form). */
function asDecimalString(value: unknown): unknown {
  return typeof value === "number" ? String(value) : value;
}

/**
 * Splices in whatever a model cannot or should not be trusted to invent itself, exactly like
 * `submit_job`'s own fixed envelope — never overrides an agent's real economic decision (how
 * much to mint, whether to request a quote, whether to pay).
 */
export async function buildToolArgs(tool: ToolName, rawArgs: unknown, ctx: BuildToolArgsContext): Promise<unknown> {
  if (tool === "submit_job") {
    const rawSource = (rawArgs as { source?: unknown } | undefined)?.source;
    return {
      taskClass: ctx.job.taskClass,
      originalGate: ctx.job.originalGate,
      hardenedGate: { taskClass: ctx.job.taskClass, source: typeof rawSource === "string" ? rawSource : "" },
      referenceInstance: ctx.job.referenceInstance,
      knownGoodSubmission: ctx.job.knownGoodSubmission,
      adversarialSubmissions: ctx.job.adversarialSubmissions,
      heldOutInstances: ctx.job.heldOutInstances,
    };
  }

/**
 * Which delivery window a mint is for. Defaults to the window the buyer is standing in; naming a
 * later one resolves to that window's own real, pre-computed bounds.
 *
 * This is what makes a claim a claim. Until 2026-09-28 the bounds were always the current
 * window's, so a buyer could never reserve capacity for a *future* delivery window — which is the
 * one property the instrument is defined by. With that unavailable, an all-USDC result would have
 * read as a preference when the alternative it was being compared against did not exist.
 *
 * A window outside the run is refused rather than clamped: minting against bounds nobody will ever
 * be standing in produces a claim that can never be presented, and silently retargeting a buyer's
 * stated intent is worse than telling it the window does not exist.
 */
function resolveTargetWindow(
  tool: "mint_claim" | "pay_with_claim",
  rawArgs: unknown,
  ctx: BuildToolArgsContext,
): { windowFrom: bigint; windowTo: bigint; forWindow: number } {
  const raw = (rawArgs ?? {}) as { forWindow?: unknown };
  const currentIndex = ctx.windowIndex ?? 1;
  if (raw.forWindow === undefined) {
    return { windowFrom: ctx.windowFrom, windowTo: ctx.windowTo, forWindow: currentIndex };
  }
  const forWindow =
    typeof raw.forWindow === "number" ? raw.forWindow : Number(asDecimalString(raw.forWindow));
  if (!Number.isInteger(forWindow) || forWindow < 1) {
    throw new Error(`${tool}: "forWindow" must be a whole window number, got ${JSON.stringify(raw.forWindow)}.`);
  }
  if (forWindow === currentIndex) {
    return { windowFrom: ctx.windowFrom, windowTo: ctx.windowTo, forWindow };
  }
  const bounds = ctx.windowBoundsByIndex?.[forWindow];
  if (!bounds) {
    const known = Object.keys(ctx.windowBoundsByIndex ?? {}).join(", ");
    throw new Error(
      `${tool}: this run has no window ${forWindow}${known ? ` (it has ${known})` : " beyond the one you are in"}.`,
    );
  }
  if (forWindow < currentIndex) {
    throw new Error(
      `${tool}: window ${forWindow} has already closed — a claim minted for it could never be presented.`,
    );
  }
  return { windowFrom: bounds.from, windowTo: bounds.to, forWindow };
}

  if (tool === "mint_claim") {
    if (!ctx.mintContext) {
      throw new Error("mint_claim: this window has no mintContext — no agent should have this tool.");
    }
    const quantity = asDecimalString((rawArgs as { quantity?: unknown } | undefined)?.quantity);
    if (typeof quantity !== "string") {
      throw new Error('mint_claim: expected a string "quantity" in args.');
    }
    const validUntil = BigInt(Math.floor(Date.now() / 1000)) + ctx.mintContext.validitySeconds;
    const signature = await signRateAttestation(
      {
        printId: ctx.mintContext.printId,
        series: ctx.mintContext.series,
        printDate: ctx.mintContext.printDate,
        nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu,
        validUntil,
      },
      ctx.deployment.network.chainId,
      ctx.deployment.workClaim.address as Hex,
      ctx.mintContext.publisherPrivateKeyHex,
    );
    const target = resolveTargetWindow("mint_claim", rawArgs, ctx);
    return {
      classId: classIdFor(ctx.job.taskClass),
      series: ctx.mintContext.series,
      quantity,
      windowFrom: Number(target.windowFrom),
      windowTo: Number(target.windowTo),
      printId: ctx.mintContext.printId,
      printDate: ctx.mintContext.printDate.toString(),
      nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu.toString(),
      validUntil: validUntil.toString(),
      signature,
    };
  }

  if (tool === "get_balances") {
    const raw = (rawArgs ?? {}) as { account?: unknown; tokenIds?: unknown };
    // Every escrow this agent is party to, resolved from the board rather than asked of the
    // model: the escrow contract has no enumeration, so an agent that wasn't handed these hashes
    // cannot discover that it has been paid. Found live, 2026-09-27 — see settle-escrow.ts.
    const erc8004Id = ctx.caller?.erc8004Id;
    const mine = erc8004Id
      ? [
          ...ctx.board.issuedQuotesBySeller(erc8004Id),
          ...(ctx.caller ? ctx.board.issuedQuotesFor(ctx.caller.agentId) : []),
        ]
      : [];
    const escrowQuoteHashes = [...new Set(mine.map((i) => quoteHashHex(i.quote)))];
    return {
      account: typeof raw.account === "string" ? raw.account : (ctx.caller && ctx.agentAddressByAgentId[ctx.caller.agentId]) ?? "",
      tokenIds: Array.isArray(raw.tokenIds) ? raw.tokenIds.map((t) => asDecimalString(t)) : [],
      escrowQuoteHashes,
    };
  }

  if (tool === "settle_escrow") {
    const erc8004Id = ctx.caller?.erc8004Id;
    if (!erc8004Id) {
      throw new Error("settle_escrow: no caller identity on this turn.");
    }
    // The seller's own signed quote, newest first — never reconstructed by the model, for the
    // same reason `pay` takes the real object: a hand-copied quote hashes to a different, and
    // nonexistent, escrow.
    const mine = ctx.board.issuedQuotesBySeller(erc8004Id);
    const latest = mine.at(-1);
    if (!latest) {
      throw new Error(
        "settle_escrow: you have not issued any quote this window, so there is no escrow to settle.",
      );
    }
    const raw = (rawArgs ?? {}) as { actualAmountUsd?: unknown };
    return {
      quote: latest.quote,
      ...(typeof raw.actualAmountUsd === "string" ? { actualAmountUsd: raw.actualAmountUsd } : {}),
      receiptRef: keccak256(stringToBytes(`receipt:${ctx.job.jobId}`)),
    };
  }

  if (tool === "quote_forward") {
    const book = ctx.forwardBook;
    const windowIndex = ctx.windowIndex ?? 1;
    const windowCount = ctx.windowCount ?? 1;
    if (!book || windowCount < 2) {
      throw new Error(
        "quote_forward: this run has only one window, so there is no later window to quote for.",
      );
    }
    const erc8004Id = ctx.caller?.erc8004Id;
    const issuerAddress = ctx.caller ? ctx.agentAddressByAgentId[ctx.caller.agentId] : undefined;
    if (!erc8004Id || !issuerAddress) {
      throw new Error("quote_forward: no caller identity on this turn.");
    }
    const raw = (rawArgs ?? {}) as { forWindow?: unknown; rateUsdPerSiu?: unknown; maxQuantityMilliSiu?: unknown };
    const forWindow = typeof raw.forWindow === "number" ? raw.forWindow : Number(asDecimalString(raw.forWindow));
    if (!Number.isInteger(forWindow) || forWindow <= windowIndex || forWindow > windowCount) {
      throw new Error(
        `quote_forward: forWindow must be a later window in this run — an integer above ${windowIndex} and at most ${windowCount}.`,
      );
    }
    const rateUsdPerSiu = asDecimalString(raw.rateUsdPerSiu);
    const maxQuantityMilliSiu = asDecimalString(raw.maxQuantityMilliSiu);
    if (typeof rateUsdPerSiu !== "string" || typeof maxQuantityMilliSiu !== "string") {
      throw new Error(
        'quote_forward: expected string "rateUsdPerSiu" (decimal USD per SIU) and "maxQuantityMilliSiu" (whole mSIU).',
      );
    }
    // The class and the issuer's own address are spliced, never named by the model: the headroom
    // recorded beside an offer has to be genuinely that issuer's own in the class the work is in,
    // or the record cannot distinguish a backed offer from an empty one.
    return {
      forWindow,
      rateUsdPerSiu,
      maxQuantityMilliSiu,
      classId: classIdFor(ctx.job.taskClass),
      issuerAddress,
    };
  }

  if (tool === "take_forward") {
    const book = ctx.forwardBook;
    if (!book) {
      throw new Error("take_forward: this run keeps no forward-terms book.");
    }
    const quoteId = (rawArgs as { quoteId?: unknown } | undefined)?.quoteId;
    if (typeof quoteId !== "string") {
      throw new Error('take_forward: expected a string "quoteId" naming the offer you are taking.');
    }
    const offer = book.byId(quoteId);
    if (!offer) {
      throw new Error(`take_forward: no forward offer "${quoteId}" exists.`);
    }
    if (offer.takenInWindow !== null) {
      throw new Error(
        `take_forward: ${quoteId} was already taken by ${offer.takenBy} in window ${offer.takenInWindow}.`,
      );
    }
    // Echoed from the book rather than from the model, so the tool history records the terms
    // that were actually on offer and not a restatement of them.
    return {
      quoteId,
      issuer: offer.issuer,
      rateUsdPerSiu: offer.rateUsdPerSiu,
      maxQuantityMilliSiu: offer.maxQuantityMilliSiu,
      forWindow: offer.forWindow,
    };
  }

  if (tool === "reserve_for_work") {
    const erc8004Id = ctx.caller?.erc8004Id;
    if (!erc8004Id) {
      throw new Error("reserve_for_work: no caller identity on this turn.");
    }
    // The seller's own signed quote, exactly as `settle_escrow` resolves it — the quote hash is
    // what ties the reservation to a real, funded escrow, and a reconstructed quote would hash
    // to a different and nonexistent one.
    const latest = ctx.board.issuedQuotesBySeller(erc8004Id).at(-1);
    if (!latest) {
      throw new Error(
        "reserve_for_work: you have not issued any quote this window, so there is no paid job to reserve capacity against.",
      );
    }
    const raw = (rawArgs ?? {}) as { classId?: unknown };
    // The job's own class by default: this window has exactly one, and a model naming a class the
    // job isn't in would reserve capacity from a pool the work will never draw on.
    return {
      quote: latest.quote,
      classId: typeof raw.classId === "string" ? raw.classId : classIdFor(ctx.job.taskClass),
    };
  }

  if (tool === "submit_attack") {
    const attackCtx = ctx.attackContext;
    if (!attackCtx) {
      throw new Error("submit_attack: this window has no attack context — no agent should have this tool.");
    }
    const source = (rawArgs as { submissionSource?: unknown } | undefined)?.submissionSource;
    if (typeof source !== "string" || source.trim() === "") {
      throw new Error(
        'submit_attack: expected a non-empty string "submissionSource" — the full answer.mjs module source, as a JSON string.',
      );
    }
    // Always the newest delivered gate: an adversary able to pick an older, already-defeated
    // version would score hits the live gate no longer allows.
    const latest = attackCtx.gateVersions.at(-1);
    if (!latest) {
      throw new Error("submit_attack: no gate has been delivered yet — there is nothing to test yet.");
    }
    if (!attackCtx.attackedVersions.has(latest.version) && attackCtx.attackedVersions.size >= MAX_ATTACK_ROUNDS) {
      throw new Error(
        `submit_attack: the ${MAX_ATTACK_ROUNDS}-round cap is reached (versions already tested: ${[...attackCtx.attackedVersions].join(", ")}). No further rounds this window.`,
      );
    }
    return {
      submissionSource: source,
      targetGateSource: latest.source,
      taskClass: ctx.job.taskClass,
      referenceFiles: ctx.job.referenceInstance.files,
      oracleSeed: attackCtx.oracleSeed,
      gateVersion: latest.version,
    };
  }

  if (tool === "pay_with_claim") {
    if (!ctx.mintContext) {
      throw new Error("pay_with_claim: this window has no mintContext — no agent should have this tool.");
    }
    const raw = (rawArgs as { to?: unknown; agentId?: unknown; quantity?: unknown } | undefined) ?? {};
    let to = raw.to;
    if (typeof raw.agentId === "string") {
      const resolved = ctx.agentAddressByAgentId[raw.agentId as AgentId];
      if (!resolved) throw new Error(`pay_with_claim: no known address for agentId "${raw.agentId}".`);
      to = resolved;
    }
    if (typeof to !== "string") {
      throw new Error('pay_with_claim: name the recipient as {"agentId": "WORKER-CODE"} or a literal "to" address.');
    }
    const quantity = asDecimalString(raw.quantity);
    if (typeof quantity !== "string") {
      throw new Error('pay_with_claim: expected a string "quantity" in milli-SIU.');
    }
    const validUntil = BigInt(Math.floor(Date.now() / 1000)) + ctx.mintContext.validitySeconds;
    const signature = await signRateAttestation(
      {
        printId: ctx.mintContext.printId,
        series: ctx.mintContext.series,
        printDate: ctx.mintContext.printDate,
        nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu,
        validUntil,
      },
      ctx.deployment.network.chainId,
      ctx.deployment.workClaim.address as Hex,
      ctx.mintContext.publisherPrivateKeyHex,
    );
    const target = resolveTargetWindow("pay_with_claim", rawArgs, ctx);
    return {
      to,
      quantity,
      classId: classIdFor(ctx.job.taskClass),
      series: ctx.mintContext.series,
      windowFrom: Number(target.windowFrom),
      windowTo: Number(target.windowTo),
      printId: ctx.mintContext.printId,
      printDate: ctx.mintContext.printDate.toString(),
      nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu.toString(),
      validUntil: validUntil.toString(),
      signature,
    };
  }

  if (tool === "transfer_claim") {
    const raw = rawArgs as { to?: unknown; agentId?: unknown; tokenId?: unknown; quantity?: unknown } | undefined;
    // A model may name the destination symbolically ({ agentId: "WORKER-CODE" }) rather than
    // risk mistyping a real hex address — resolved here against the roster's own real addresses,
    // never guessed. A literal "to" address is still honoured unchanged if given instead.
    let to = raw?.to;
    if (typeof raw?.agentId === "string") {
      const resolved = ctx.agentAddressByAgentId[raw.agentId as AgentId];
      if (!resolved) {
        throw new Error(`transfer_claim: no known address for agentId "${raw.agentId}".`);
      }
      to = resolved;
    }
    return { to, tokenId: asDecimalString(raw?.tokenId), quantity: asDecimalString(raw?.quantity) };
  }

  if (tool === "pay") {
    // `tools/pay.ts`'s real schema takes the full `{quote: TouchstoneQuote, settler}` — the exact
    // seller-signed object, not something a model reconstructs from the board's own deliberately
    // partial summary text (amount/expiry/seller only — see quote-board.ts's own doc comment on
    // `issuedQuoteById`). A model names which answered request it's paying by `requestId`; the
    // real quote is spliced in here, the same pattern `issue_quote` already uses.
    const raw = rawArgs as { requestId?: unknown; settler?: unknown } | undefined;
    if (typeof raw?.requestId !== "string") {
      throw new Error('pay: expected a string "requestId" naming the quote being paid.');
    }
    const quote = ctx.board.issuedQuoteById(raw.requestId);
    if (!quote) {
      throw new Error(`pay: no issued quote found for request "${raw.requestId}".`);
    }
    return { quote, settler: raw.settler };
  }

  if (tool === "serve_redemption") {
    // `RedemptionTracker.renderFor` (spec §13.3: no agent messages, only structured facts) shows
    // an issuer the holder's own AgentId ("WORKER-CODE"), never a raw address — the issuer has no
    // other way to learn it. Resolved here exactly like `transfer_claim`'s own symbolic `to`,
    // rather than let a real serve_redemption call revert on a non-address string.
    const raw = rawArgs as
      | { holder?: unknown; agentId?: unknown; tokenId?: unknown; quantity?: unknown; passed?: unknown; receiptRef?: unknown }
      | undefined;
    let holder = raw?.holder;
    const symbolicId = typeof raw?.agentId === "string" ? raw.agentId : typeof holder === "string" ? holder : undefined;
    if (symbolicId && ctx.agentAddressByAgentId[symbolicId as AgentId]) {
      holder = ctx.agentAddressByAgentId[symbolicId as AgentId];
    }
    return {
      tokenId: asDecimalString(raw?.tokenId),
      holder,
      quantity: asDecimalString(raw?.quantity),
      passed: raw?.passed,
      receiptRef: raw?.receiptRef,
    };
  }

  if (tool === "issue_quote") {
    // The seller answers a specific open request by id — the actual signed body is the board's
    // own stored QuoteBody from that request, never whatever the model reconstructs by hand, so a
    // seller can't accidentally (or otherwise) sign something other than what was really asked.
    const requestId = (rawArgs as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== "string") {
      throw new Error('issue_quote: expected a string "requestId" naming the request being answered.');
    }
    const request = ctx.board.requestById(requestId);
    if (!request) {
      throw new Error(`issue_quote: no open request "${requestId}" on the board.`);
    }
    return request.body;
  }

  return rawArgs;
}
