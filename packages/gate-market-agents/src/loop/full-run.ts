import { keccak256, stringToBytes, type Hex } from "viem";
import { ZodError } from "zod";
import {
  classifyFailure,
  isPolicyRefusalStopReason,
  type Adapter,
  type AdapterParams,
  type AdapterResult,
  type FailureCategory,
} from "@touchstone/harness";
import { quoteHashHex, type QuoteBody, type TouchstoneQuote } from "@touchstone/sdk";
import type {
  GateHardeningJobInputs,
  GateHardeningResult,
  HeldOutInstance,
  ReferenceTaskInstance,
  Submission,
  TaskClass,
} from "@touchstone/task-pack-gate-hardening";
import { assembleContext, type ToolCallRecord } from "../context/assemble.js";
import { computeTimeToExpirySeconds } from "../context/expiry.js";
import {
  projectedTurnCostUsd,
  realizedTurnCostUsd,
  type ModelPrices,
} from "../budget/inference-cost.js";
import { ExperimentBudget, ExperimentCapExceededError } from "../budget/experiment-budget.js";
import { CeilingExceededError } from "../budget/ceiling.js";
import { gateResultsMatch } from "../gate/determinism.js";
import { isEmptyAtTokenBudget } from "./empty-completion.js";
import { signRateAttestation } from "../chain/rate-attestation.js";
import { Runner } from "../runner.js";
import type { RunnerDeps } from "../deps.js";
import type { IssuerObligation } from "../tools/list-obligations.js";
import type { DeliveryStatus } from "../tools/check-delivery.js";
import type { AgentId } from "../identity/resolve.js";
import { ContextValidationError, validateAgentContext } from "../pack/validate.js";
import type { ToolName } from "../tools/index.js";
import type { AttackToolResult } from "../tools/submit-attack.js";
import { RunRecorder, type RunManifest } from "../run-recorder/recorder.js";
import { FrictionLogWriter, type FrictionLogEntry } from "../friction/log.js";
import { QuoteBoard, type PaidAsset } from "./quote-board.js";
import { claimMilliSiuForQuote } from "./parity.js";
import { extractThinking } from "./thinking.js";
import { explainToolError } from "./plain-errors.js";
import { ClaimLedger, type ClaimFlows } from "./claim-ledger.js";
import {
  submitAttackRefusalFor,
  quoteSizeRefusalFor,
  testingEngaged,
  windowCompletion,
  type IncompleteBecause,
} from "./testing-purchase.js";
import { ForwardQuoteBook, type ForwardQuote } from "./forward-book.js";
import { classIdFor } from "../tools/class-id.js";
import { RedemptionTracker, type OpenPosition, type RedemptionState } from "./redemption-tracker.js";
import type { LabHooks } from "./lab-hooks.js";
import { buildTurnPrompt } from "./prompt.js";
import {
  ModelResponseParseError,
  parseModelResponse,
  type FrictionReport,
} from "./parse-tool-call.js";

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
  /**
   * What a turn is PROJECTED to produce, for the spending cap only; `maxOutputTokens` is still what the model is
   * allowed. Projecting every turn at the full allowance made the cap fire at five times realized spend: the first
   * lab run, projected at 4,500 output tokens a turn, was stopped having realized $0.69 of a $3 cap, when its turns
   * produced about 100 to 300 tokens. Absent, the allowance is the projection, as before.
   */
  projectedOutputTokens?: number;
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
   *  - "buyer": always awake until it has completed one successful action this window, then
   *             behaves like "inbox" but is additionally woken by a forward offer it has not yet
   *             been shown. A buyer must get its first turn unconditionally — at the start of a
   *             window nothing has arrived for anyone, so "inbox" alone would mean it never buys
   *             and the window never begins. A failed call does not count as acting, so a buyer
   *             whose purchase reverted stays awake to deal with it.
   *
   * Added for the buyer 2026-09-29. Until then ORCHESTRATOR had no `waitsFor` at all: it was
   * polled every round and its only non-action was `{"done": true}`, which ends the window for
   * it. Its own summaries across three windows say it was waiting, not finishing — "I must now
   * wait for WORKER-CODE to complete and deliver", "I end this turn with no further on-chain
   * actions". It was told to wait, had no way to wait, and the nearest available move was
   * permanent exit. The same missing primitive produced the opposite failure the run before,
   * where a model repeated a known-failing call four times rather than leave. Both are rational
   * given a forced choice between acting and leaving.
   */
  waitsFor?: "gate" | "inbox" | "buyer";
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
  /**
   * The quantity of each seller's job, in SIU as a decimal string, keyed by the seller's erc8004
   * id. Quantity is a property of the job and price floats: a `request_quote` naming another size
   * is refused, and a paid quote of another size does not count as the testing purchase. A seller
   * with no entry is unconstrained.
   */
  requiredQuoteSiu?: Readonly<Record<string, string>>;
  /**
   * The quote board for this window. Defaults to a fresh one — which is what every real run uses.
   * It exists so a test can place a real, signed quote on the board beforehand: `request_quote`
   * builds its settlement asset from a fixed table keyed by chain name, which has no entry for a
   * local devnet's token, so a loop test of a dollar settlement could not otherwise run.
   */
  board?: QuoteBoard;
  roster: readonly RosterAgentConfig[];
  /** One job at a time for now (P4: exactly one) — the roster takes turns against it until it
   * passes, a maxTurnsPerAgent ceiling is hit for everyone active, or the budget halts the run.
   * P5's real "6-10 jobs per window, alternating class" needs a queue of these, cycled through as
   * each is delivered or abandoned — not built here; see this file's own top comment. */
  job: JobEnvelope;
  maxTurnsPerAgent: number;
  /**
   * Unix seconds at which this window's span ends. Turns stop being handed out once it passes.
   *
   * Bounding turns to the span, rather than letting a window run until its agents are done, is
   * the deliberate choice between the two available fixes. The alternative — starting each
   * window's clock when its first turn actually runs — cannot work here: `resolveTargetWindow`
   * lets a buyer mint for a LATER window, which requires that window's real bounds to be known
   * and stable before it begins. A clock that starts late moves those bounds after a claim has
   * been minted against them, and a forward-dated claim whose window shifts is a claim that can
   * expire before it can ever be presented. The instrument's defining property has to win over
   * the convenience of never truncating an exchange.
   *
   * The cost is real and is not hidden: an exchange can be cut off mid-hardening-loop. That is
   * also what a real delivery window does, and the remedy is to size the span for the exchange
   * rather than to let the exchange redefine the span.
   */
  windowSpanEndsAtUnixSeconds?: bigint;
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
  /**
   * The task specification a holder presents with `redeem_claim`, handed on to the routed issuer
   * in its own "A CLAIM WAS PRESENTED AGAINST YOU" notice — the materials, reference inputs and
   * gate contract it needs to author the deliverable it owes.
   *
   * Absent means the issuer is told it owes work without being told what the work is, which is
   * what every run before 2026-09-29 did: the contract lived only in the holder's static pack, so
   * no issuer had ever seen a job it was asked to deliver, no issuer-authored gate was ever valid,
   * and every window that ever passed was passed by the holder doing work the economic model says
   * it must not do.
   */
  taskSpecText?: string;
  /** Claims minted in an EARLIER window that their issuer never served, carried forward so this
   * window's issuers can settle them.
   *
   * A claim cannot default inside its own window — `settleWindowClose` reverts
   * `WindowNotClosedYet` until the window it was minted for has actually closed, and agents only
   * act while their own window is open. So the default path is only ever reachable across
   * windows, and a window that does not know what the previous one left outstanding can never
   * reach it at all. That is exactly why it had never run in an agent context before 2026-09-28
   * despite being the enforcement the whole bond design rests on. */
  outstandingClaims?: readonly OutstandingClaim[];
  /**
   * A pinned, already-known-good gate to inject at window start instead of buying one.
   *
   * `--debug` only (`cli/debug-mode.ts`), and the single biggest cost saving available: gate
   * authoring is where a debugging run's money goes. It is still GRADED for real, by the same
   * grader on the same job inputs — what is skipped is a model writing it, not the checking of
   * it — and it is attributed to `PRE_AUTHORED` rather than to any agent.
   */
  preAuthoredGateSource?: string;
  /**
   * Adversarial testing must be PAID FOR, and `passed` means a gate passed AND testing was
   * purchased AND carried out. Off by default so every other caller keeps the old meaning.
   * An instrument change, recorded as one (see `loop/testing-purchase.ts`).
   */
  requireTestingPurchase?: boolean;
  /**
   * The currency lab's hooks (`loop/lab-hooks.ts`). Absent in every other run, which then behaves
   * exactly as before. Present, the loop adds the lab's board text, asks it to vet each call's
   * arguments, tells it what each call did, lets it open the next round when nobody can act — and
   * stops showing the claim-presentation notices, which name tools a lab trader does not hold.
   */
  lab?: LabHooks;
  /**
   * The asset paragraph the context validator requires in every agent's context, byte for byte. Absent: the canonical
   * text, as in every run before the lab's instrument v4. The lab passes its own (`lab/asset-text.ts`), the canonical text
   * with the sentences its direct settlement makes false replaced; the validator is otherwise unchanged.
   */
  assetDescription?: string;
  /**
   * Currency lab only: claims the operator put into traders' hands before the first turn (the opening
   * endowment). The loop's trackers learn only what its own calls do, so without this a trader holding the
   * endowment would be a holder of nothing as far as the claim ledger and the redemption tracker can see —
   * and a `transfer_claim` of it would be a gap in the record. Seeded as held, not received and not as
   * flows: the endowment is neither a payment nor an agent's own mint, and the report states it apart.
   */
  openingClaims?: readonly OpeningClaim[];
  /** Reported so the log says the pinned gate was graded, and with what result, rather than a
   *  window silently starting out already passed. */
  onPreAuthoredGate?: (passed: boolean, summary: string) => void;
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
    | "take_forward"
    /** One quote settled in both assets at once — see tools/settle-split.ts. */
    | "settle_split";
  quantityMilliSiu?: string;
  issuer?: string;
  tokenId?: string;
  quoteHash?: string;
  /** Claim share of the quote, 0..1 as a decimal string — `settle_split` only. */
  claimShare?: string;
  /** `settle_window_close` only: the terminal state, decoded from the tool's own receipt. Absent
   *  means it could not be decoded, never that it was something in particular. */
  settlementOutcome?: "Defaulted" | "Expired";
  /** `settle_window_close` only, and only for a Default: USDC minor units the bond paid the holder. */
  bondPaidMinorUnits?: string;
  /** A claim's mint: USDC minor units the minter paid, read from the mint receipt's own transfer
   *  log (`usdc-paid.ts`) — what an fSIU payment cost the payer, as distinct from the claim's
   *  print-equivalent value. Absent for a transfer, which mints nothing. */
  mintCostMinorUnits?: string;
  /** The quote this movement of claims settled, when it named one. A transfer that names none
   *  settles nothing, and a report counts it apart. */
  settlesRequestId?: string;
  counterparty?: string;
  txHash?: string;
  /** Seconds until the claim's own window closes at the moment of the decision — §7.1(a)'s own
   * requirement that every hold and redeem decision carries it, so "they redeemed immediately"
   * can be told apart from "they redeemed under expiry pressure". */
  timeToExpirySeconds?: number;
  /** For take_forward only: the offer taken, since nothing on-chain records it. */
  forwardQuoteId?: string;
  /** For a mint only: true when the claim's own delivery window ends after the window it was
   * minted in — i.e. it genuinely reserves capacity for a LATER window rather than paying for
   * the work in front of it.
   *
   * Recorded because the distinction is invisible otherwise, and getting it wrong inverts a
   * result: the first three-window run's own classifier counted every earlier-window mint as
   * "capacity secured ahead" and therefore called a scarcity outcome "the instrument working as
   * intended". Both those mints were ordinary same-window payments. A claim is only forward
   * cover if it is dated forward. */
  forwardDated?: boolean;
}

/** Claims placed in an agent's hands by the operator before the loop starts. */
export interface OpeningClaim {
  agentId: AgentId;
  tokenId: string;
  /** mSIU, as a decimal string. */
  quantityMilliSiu: string;
  issuerAgentId: AgentId;
}

/** A claim an earlier window minted and nobody ever served. */
export interface OutstandingClaim {
  tokenId: string;
  /** The agent that held it when its window closed — whose balance the settlement pays out. */
  holder: string;
  holderAgentId?: AgentId;
  issuerAgentId?: AgentId;
  quantityMilliSiu?: string;
  mintedInWindow: number;
  /**
   * Whether this claim was ever presented, which decides what settling it actually does.
   *
   * `WorkClaim.settleWindowClose` burns the claim and restores headroom either way, but the
   * bond draw lives inside `if (everPresented[tokenId][holder])`. A presented claim pays its
   * holder; an unpresented one emits `Expired` and pays nobody, returning the capacity to the
   * issuer that failed to deliver. Run 17 settled one of each and the board text promised
   * payment for both (fsiu-design.md §4.3a).
   *
   * Undefined on a claim whose history this run cannot see; the text then says what it knows
   * rather than guessing, which is the only honest option.
   */
  everPresented?: boolean;
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
  /** True only for `apparatus_attack`: the submission attacked the measurement, not the gate.
   * Counted separately from adversarial yield because it is a more severe finding, not a lesser
   * one — run 9 filed exactly this as an infrastructure flake. */
  countsAsApparatusAttack?: boolean;
  /** Why the oracle returned no verdict, when it returned none. */
  oracleErrorCause?: string;
  gateAccepted?: boolean;
  oracleAccepted?: boolean;
  /**
   * The gate's OWN verdict text, exactly as `submit_attack` returned it to the adversary — not
   * the scoring reason, which is this harness's summary of the two verdicts crossed.
   *
   * Added 2026-09-29 after run 9, where it decided nothing because it was recorded nowhere. That
   * run produced five false accepts and the adversary named the gate's test bounds exactly
   * ("length <= 10, values between -2 and 2"). The gate's SOURCE is withheld from an attacker by
   * construction — but its reason string is handed straight back, so a gate that explains itself
   * discloses its own test distribution. Without this field the record cannot tell an adversary
   * that inferred the bounds from behaviour from one that was simply told them, and those are a
   * capability result and a plumbing artefact respectively.
   */
  gateReason?: string;
  /** The oracle's own verdict text, kept for the same reason and at the same time. */
  oracleReason?: string;
  /** How many trials the oracle actually ran — the denominator any "caught at trial N" claim needs. */
  oracleTrialsRun?: number;
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
  /**
   * Which tool this turn called, and whether the call genuinely returned.
   *
   * Added 2026-10-02 (spec §4.6af). Before this, the only record of a tool call was `parsed`, a
   * STRING: `JSON.stringify(intent)` on success and
   * `` `${JSON.stringify(intent)} -> tool call error: …` `` on failure. Every reader therefore
   * had to sniff that string, and two readers got it wrong in opposite directions at once — the
   * final-window classifier could not see a successful dollar payment at all, while
   * `summarisePurchases` counted a reverted one as settled. A dollar payment is the case that
   * exposes this because it is the one route whose success leaves no capacity event of its own:
   * `pay` opens an escrow, and the capacity event it leads to belongs to the SELLER.
   *
   * So the fact is recorded as a fact. Ownership of a capacity event is not ownership of a
   * purchase, and the text of a model's own tool call is not evidence that the call worked.
   */
  toolCall?: { name: ToolName; ok: boolean };
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
  /**
   * The model's own untruncated response text, and the exact prompt it answered — recorded on
   * every turn, including (especially) the ones that failed to parse. Added 2026-09-29 after P5
   * run 3, where four turns died unparseable and the raw text existed nowhere on disk: `messages/`
   * was created by the recorder but never written to, and the console line slices at 200
   * characters. stopReason/usage/contentBlockTypes were already persisted and did most of the
   * diagnostic work; the text itself is what was missing to finish it.
   */
  rawText?: string;
  promptText?: string;
  /** Order in which turns were taken across all agents in the run, from 1: the turn counters are per agent, so this is the only global order. */
  seq?: number;
  /** The reasoning the provider returned with this turn's reply, if it returned any (`loop/thinking.ts`); never requested. */
  thinking?: string;
  /**
   * The sampling the turn's request was actually sent with, as the adapter reports it (`AdapterResult.sent`): the temperature, or "provider-default" when
   * none was sent (a model that rejects the one requested is retried without it, and a deviation is logged). Absent for an adapter that does not report it.
   */
  sent?: { temperature: number | "provider-default"; thinking?: unknown };
  /**
   * The two prompt sections that were genuinely shown to this agent but recorded nowhere, so
   * "did it see the offer?" could not be answered from the record — the exact question that
   * decided whether P5 run 3's "0 of 2 forward offers taken" was a real decision or a missing
   * affordance, and whether an agent had a real chance to settle. `marketBoardText` above is
   * only the quote board; these are its siblings in the assembled prompt.
   */
  settleableText?: string;
  forwardText?: string;
  /** Set exactly when this turn ended because the provider failed or declined the call, rather
   * than because of anything the model produced — see the adapter-call guard in the loop. */
  providerFailure?: { category: FailureCategory; message: string };
  /**
   * Set exactly when this turn's first model call came back empty at the token budget and the
   * turn was called again (loop/empty-completion.ts). The log's own fields describe the surviving
   * call; `firstAttempt` is what the discarded one returned and cost. `recovered`: the retry
   * produced text. `recurred`: it did not either, and the run was declared infrastructure-failed.
   */
  infrastructureRetry?: {
    outcome: "recovered" | "recurred" | "retry_failed";
    firstAttempt: {
      stopReason?: string;
      contentBlockTypes?: string[];
      usage: { input: number; output: number; cached_input: number; reasoning: number };
      realizedUsd: string;
      latencyMs: number;
    };
  };
  /** Set exactly on a turn that ran `submit_attack`. */
  attack?: { gateVersion: number; classification: string; countsAsAdversaryYield: boolean };
}

/**
 * One moment at which an agent settled a quote, with what it held when it did.
 *
 * Recorded so the decision rule (D5) can ask the only question that makes onward spending
 * comparable across runs: did the agent hold fSIU it had RECEIVED at the moment it paid? Taken
 * from the loop's own ledger BEFORE the payment's own effect is applied, so a claim being passed
 * on is still counted as held when it is being passed.
 */
export interface PaymentMoment {
  agentId: AgentId;
  turn: number;
  tool: ToolName;
  asset: PaidAsset;
  requestId?: string;
  /** mSIU of claims the agent had been GIVEN and still held, as a decimal string. */
  heldReceivedMilliSiu: string;
  /** mSIU of claims the agent held in all, opening supply included, before this payment's own effect — the lab's H2 decision rule (D51). */
  heldTotalMilliSiu: string;
  /**
   * The settled quote's own STATED terms, read from the signed quote — so a run's artefact can say
   * what a payment bought and at what price without a board that no longer exists. Decimal
   * strings throughout. `quotedUsdMax` is the ceiling the quote allows, not what was finally
   * settled: a seller may settle for less. Absent when the payment names no quote (an unkeyed
   * `transfer_claim`), which is itself the fact worth reporting.
   */
  quotedSiu?: string;
  quoteRateUsdPerSiu?: string;
  quotedUsdMax?: string;
}

/** A USDC quote settled by its seller, with what was actually settled. */
export interface UsdcSettlement {
  sellerAgentId: AgentId;
  turn: number;
  /** The quote it settles — the key that joins it to the payment that opened the escrow. */
  requestId: string;
  /** USDC minor units actually released to the seller. */
  settledMinorUnits: string;
  /** The quote's ceiling, in minor units; `settledMinorUnits` may be below it. */
  quotedMinorUnits: string;
}

export interface FullRunWindowResult {
  /** Under `requireTestingPurchase` this is gate PASS ∧ testing paid for ∧ testing carried out;
   *  otherwise it is `gateDelivered`, exactly as before. */
  passed: boolean;
  /** A gate passed G1-G6 — the old meaning of `passed`, kept so the two can be told apart. */
  gateDelivered: boolean;
  /** Every position in a claim still held when the window ended — per holder, with what each holds
   *  and whether it presented — from the loop's own record of every mint and transfer. What the next
   *  window is carried to settle is built from this, not from the mints. */
  claimPositions: OpenPosition[];
  /** Currency lab only: failures of the lab's own bookkeeping — operator-side, never an agent's. */
  labErrors: { agentId: AgentId; turn: number; tool: string; message: string }[];
  /** Every quote settlement this window, in order, with what the payer held at that moment. */
  paymentMoments: PaymentMoment[];
  /** Every USDC quote settled this window, with the amount actually released. */
  usdcSettlements: UsdcSettlement[];
  /** Each seat's cumulative claim flows over the window — received, minted, paid out of balance,
   *  redeemed — the totals the decision rule is stated in. */
  claimFlows: Record<string, ClaimFlows>;
  /** A quote sold by an attacker was settled, in either asset. */
  testingEngaged: boolean;
  /** Why `passed` is false when it is, so a decline is recorded rather than silent. Absent when
   *  `infrastructureFailure` is set: a run the harness failed has no verdict about its agents. */
  incompleteBecause?: IncompleteBecause;
  /** Set when a turn came back empty at the token budget twice running. The run cannot be read as
   *  agent behaviour and is excluded from the block; `no_gate` and its kin are never assigned. */
  infrastructureFailure?: {
    agentId: AgentId;
    turn: number;
    attempts: number;
    stopReason?: string;
    detail: string;
  };
  passedBy?: AgentId | typeof PRE_AUTHORED;
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
  haltedReason?: Record<
    string,
    | "ceiling"
    | "parse_error"
    /** The provider returned a completion with no text block at all — typically a reasoning model
     * that consumed its whole budget thinking. Distinct from `parse_error`, which means text was
     * returned and could not be parsed: the two need different remedies and were conflated until
     * 2026-09-29. */
    | "no_text_emitted"
    | "max_turns"
    | "validation_failed"
    | "voluntary_stop"
    | "experiment_halt"
    | "policy_refusal"
    | "adapter_error"
    /** Every agent still active when the run was declared infrastructure-failed (see
     *  `FullRunWindowResult.infrastructureFailure`) — theirs is not a decision either. */
    | "run_infrastructure_failed"
    | "nothing_to_act_on"
    /** The window's own span ran out while this agent was still active. Added 2026-09-30: turns
     * used to run past their window's end, so a slow window ate the next one's time — run 10's
     * window 2 opened with 386 seconds of its 1,200-second span left because window 1 overran.
     * Windows whose real duration depends on how long the previous one took are not comparable,
     * and claim windows are fixed on-chain before any of them starts. */
    | "window_span_elapsed"
    /**
     * The agent said it was waiting and nothing it can act on has changed since. Distinct from
     * `nothing_to_act_on`, which the LOOP concludes, and from `voluntary_stop`, which leaves
     * the window for good: a waiting agent is still in, and would have been woken had anything
     * arrived. Read it as "idle by its own choice", not as a halt.
     */
    | "waiting"
  >;
  turnLogsByAgent: Record<string, TurnLog[]>;
  /** The order each agent's tool descriptions were shown in (`shuffledToolOrder`): seeded per agent and per run, and recorded so a reader can check a choice against position. */
  toolOrderByAgent: Record<string, readonly ToolName[]>;
}

function summarizeGateResult(result: GateHardeningResult): string {
  if (result.passed) return "G1-G6 all passed";
  const checks = [
    ["G1", result.g1],
    ["G2", result.g2],
    ["G3", result.g3],
    ["G4", result.g4],
    ["G5", result.g5],
    ["G6", result.g6],
  ] as const;
  return checks
    .filter(([, c]) => !c.passed)
    .map(([n, c]) => `${n} failed: ${c.reason}`)
    .join("; ");
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
/**
 * The board sections an agent's turn is built from, each already rendered for that agent.
 *
 * Named rather than positional because `composeBoard` makes a decision per section — whether it
 * belongs in the wake key — and a list of eleven bare strings makes that decision unreadable and
 * unreviewable.
 */
export interface BoardSections {
  marketBoardText: string;
  redemptionText: string;
  transferText: string;
  deliveryOwedText: string;
  settleableText: string;
  /** Holder-facing, added 2026-10-02 (spec §4.6ae). */
  servedText: string;
  /** Whether that serve reported a FAIL — the only case in which it wakes. */
  servedWasFailure: boolean;
  /** Holder-facing, added 2026-10-02 (spec §4.6ae). Fires once per claim. */
  unservedText: string;
  /** Holder-facing, added 2026-10-03 (fsiu-design.md §4.3a). Fires once per claim. */
  lapsingText: string;
  deliveredGateText: string;
  gateDefeatedText: string;
  forwardInvitation: string;
  /** Currency lab only. Shown, never wakes. */
  labInfoText?: string;
  /** Currency lab only. Shown, and wakes an agent that holds a tool to act on it. */
  labActionText?: string;
}

/**
 * Which tool each wake-contributing section is about — the §4.6ac invariant made checkable.
 *
 * §4.6ac's finding was that an agent given a turn with nothing it can do is put straight back
 * into the forced choice that costs it a turn to escape. So a section may only wake an agent
 * that holds a tool the section is actually about. This table is what the tests assert against,
 * and it lives beside the composition rather than in the test, so the two cannot drift.
 *
 * Deliberately NOT asserted by looking for tool names in the prose. §4.6q: worked syntax for one
 * option is a steer even when the surrounding prose is neutral, and the holder's two sections are
 * read by a buyer whose asset choice F1 is measuring. The mapping is structural; the prose stays
 * free to name no action at all.
 */
/** Sections that are shown and by construction never wake an agent, so they name no tool. */
export const NEVER_WAKING_SECTIONS: readonly string[] = ["labInfoText"];

export const WAKE_SECTION_TOOLS: Record<string, readonly ToolName[]> = {
  marketBoardText: ["request_quote", "issue_quote", "pay", "pay_with_claim", "settle_split", "settle_split_held"],
  redemptionText: ["serve_redemption"],
  transferText: ["redeem_claim"],
  deliveryOwedText: ["submit_job"],
  settleableText: ["settle_window_close"],
  // A holder whose work came back failed still has the rest of the window to buy again.
  servedText: ["request_quote", "pay", "mint_claim", "pay_with_claim", "settle_split"],
  // A holder told its claim is overdue can buy again, pass the claim on, or settle it later.
  unservedText: ["request_quote", "pay", "transfer_claim", "settle_window_close"],
  // A holder told its unpresented claim is lapsing can present it or pass it on. Both are
  // actions it could not usefully have taken a moment earlier, because it did not know the
  // deadline was near — which is the whole of what this section supplies.
  lapsingText: ["redeem_claim", "transfer_claim"],
  deliveredGateText: ["submit_attack"],
  gateDefeatedText: ["submit_job"],
  forwardInvitation: ["quote_forward"],
  // The currency lab's own actionable section: a purchasable need, a paid job to deliver, a unit of
  // raw work to buy. The informational section is deliberately absent — it never wakes.
  labActionText: [
    "request_quote",
    "issue_quote",
    "pay",
    "pay_with_claim",
    "transfer_claim",
    "settle_split",
    "settle_split_held",
    "settle_escrow",
    "deliver_job",
  ],
};

/**
 * One board, two strings: what the agent is SHOWN, and what WAKES it.
 *
 * They were the same string until 2026-10-02, fused deliberately by §4.6ac so the prompt and the
 * wake gate could not disagree about whether there was anything to act on. Run 16 showed what
 * that fusion costs: **anything worth telling an agent had to wake it too**, so the only options
 * were silence or the idle burn — and a holder, for whom no actionable section exists after it
 * presents a claim, got silence. It waited through its own undelivered work and never learned
 * (spec §4.6ae).
 *
 * Splitting them keeps §4.6ac's guarantee and removes the false choice: informational text may
 * change freely without spending a turn, while `wakeKey` stays the strict subset that affords an
 * action, checked against `WAKE_SECTION_TOOLS`.
 */
export function composeBoard(
  s: BoardSections,
  /**
   * The woken agent's own grant. §4.6ac is enforced here rather than asserted elsewhere: a
   * section whose tools this agent does not hold is still SHOWN — it may well be worth knowing —
   * but it cannot spend the agent's turn.
   *
   * This is not hypothetical. WORKER-EXTRACT can hold and redeem a claim and holds no purchase
   * tool at all, so a served FAIL is real news it can do nothing about; waking it would be the
   * forced choice returning, on the agent whose claim already went unredeemable twice (§4.6p).
   */
  availableTools: readonly ToolName[],
): { shown: string; wakeKey: string; wakeKeyNext: string } {
  const holds = (section: keyof typeof WAKE_SECTION_TOOLS): boolean =>
    WAKE_SECTION_TOOLS[section].some((t) => availableTools.includes(t));

  // `wakes` is per SECTION, not per string value: comparing by text would blank any other
  // section that happened to render identically, and every section here is empty most turns.
  //
  // `oneShot` marks a section the loop SUPPRESSES once it has genuinely been shown — the
  // overdue and lapsing warnings, a gate defeat the author has now seen, a forward invitation
  // already extended. These need `wakeKeyNext`; see below.
  const sections: { text: string; wakes: boolean; oneShot?: boolean }[] = [
    { text: s.marketBoardText, wakes: holds("marketBoardText") },
    { text: s.redemptionText, wakes: holds("redemptionText") },
    { text: s.transferText, wakes: holds("transferText") },
    { text: s.deliveryOwedText, wakes: holds("deliveryOwedText") },
    { text: s.settleableText, wakes: holds("settleableText") },
    // The one section shown but not woken on for its own sake: a holder that got what it paid
    // for has nothing new to do, and waking it would be exactly the turn-burn §4.6ac exists to
    // end. A FAIL is different — the rest of the window is its only chance to buy again, and
    // only for an agent that can actually buy.
    { text: s.servedText, wakes: s.servedWasFailure && holds("servedText") },
    { text: s.unservedText, wakes: holds("unservedText"), oneShot: true },
    { text: s.lapsingText, wakes: holds("lapsingText"), oneShot: true },
    { text: s.deliveredGateText, wakes: holds("deliveredGateText") },
    { text: s.gateDefeatedText, wakes: holds("gateDefeatedText"), oneShot: true },
    { text: s.forwardInvitation, wakes: holds("forwardInvitation"), oneShot: true },
    { text: s.labInfoText ?? "", wakes: false },
    { text: s.labActionText ?? "", wakes: holds("labActionText") },
  ];
  const join = (keep: (x: (typeof sections)[number]) => boolean): string =>
    sections
      .filter(keep)
      .map((x) => x.text)
      .filter(Boolean)
      .join("\n\n");
  return {
    shown: join(() => true),
    wakeKey: join((x) => x.wakes),
    // What the wake key will be on the NEXT evaluation, once every one-shot section shown this
    // turn has been suppressed. An agent that waits must be parked against THIS, never against
    // `wakeKey` — see spec §4.6ah. Storing the key as shown means the suppression itself
    // changes it, and a changed key is a wake, so the agent is woken once by the fact arriving
    // and once more by it disappearing. Observed in both windows of run 17, 22s and 68s after
    // the warning it had just been given.
    //
    // The general rule: a wake key must be a function of state the agent will still see next
    // turn, never of state the act of showing it destroys.
    wakeKeyNext: join((x) => x.wakes && x.oneShot !== true),
  };
}

/**
 * What an agent is told about claims an earlier window left unsettled.
 *
 * Extracted and exported so it can be tested, which is the whole lesson of run 17: this text
 * promised, unconditionally, that settling "defaults against its own issuer's bond, paying the
 * holder". That is true only of a claim that was PRESENTED. For one that never was,
 * `settleWindowClose` burns it, hands the issuer its capacity back and emits `Expired`, paying
 * nobody — and WORKER-EXTRACT, reading this text, destroyed another agent's 10,000 mSIU
 * position "as instructed" (fsiu-design.md §4.3a).
 *
 * A claim whose history this run cannot see says so, rather than defaulting to either claim.
 */
export function renderSettleableText(
  claims: readonly OutstandingClaim[],
  canSettle: boolean,
): string {
  if (claims.length === 0 || !canSettle) return "";
  // A settlement closes one HOLDER's position in a token, and a claim passed on in part leaves
  // several. Only where a token id is shared does the call need to say whose.
  const holdersOf = new Map<string, number>();
  for (const c of claims) holdersOf.set(c.tokenId, (holdersOf.get(c.tokenId) ?? 0) + 1);
  const settleArgs = (c: OutstandingClaim): string =>
    (holdersOf.get(c.tokenId) ?? 0) > 1
      ? `{"tokenId": "${c.tokenId}", "holder": "${c.holderAgentId ?? c.holder}"}`
      : `{"tokenId": "${c.tokenId}"}`;
  return (
    `CLAIMS LEFT UNSETTLED BY AN EARLIER WINDOW\n` +
    `  Their delivery windows have closed, so none of them can still be redeemed for work.\n` +
    `  Settling is permissionless: anyone may trigger it, including you. What settling PAYS\n` +
    `  depends on whether the claim was ever presented, and the two are not alike —\n` +
    `    presented and then not served: it defaults, and the issuer's bond pays its holder.\n` +
    `    never presented: it simply expires. The claim is burned, the issuer's capacity goes\n` +
    `      back to the issuer, and NOBODY is paid.\n` +
    claims
      .map(
        (c) =>
          `  tokenId ${c.tokenId} — minted in window ${c.mintedInWindow}` +
          (c.quantityMilliSiu ? `, ${c.quantityMilliSiu} mSIU` : "") +
          (c.issuerAgentId ? `, issued by ${c.issuerAgentId}` : "") +
          (c.holderAgentId ? `, held by ${c.holderAgentId}` : "") +
          (c.everPresented === undefined
            ? ", and this run cannot tell whether it was presented"
            : c.everPresented
              ? " — PRESENTED, so settling it draws on the bond and pays its holder"
              : " — NEVER PRESENTED, so settling it pays nobody and returns the capacity") +
          `\n    settle it with {"tool": "settle_window_close", "args": ${settleArgs(c)}}`,
      )
      .join("\n")
  );
}

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

export async function runFullRunWindow(
  options: FullRunWindowOptions,
): Promise<FullRunWindowResult> {
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
  const board = options.board ?? new QuoteBoard();
  const forwardBook = options.forwardBook ?? new ForwardQuoteBook();
  const windowIndex = options.windowIndex ?? 1;
  const windowCount = options.windowCount ?? 1;
  const redemption = new RedemptionTracker();
  const claimLedger = new ClaimLedger();
  for (const c of options.openingClaims ?? []) {
    redemption.recordMint(c.tokenId, c.issuerAgentId, c.quantityMilliSiu, c.agentId);
    claimLedger.mint(c.agentId, c.tokenId, BigInt(c.quantityMilliSiu));
  }
  const paymentMoments: PaymentMoment[] = [];
  // What a turn carries beyond its log: where it fell in the run's one order of turns, and any reasoning the provider returned. Attached to the
  // turn's log when the window ends, so the sites that write a log need not each know about either.
  const turnExtras = new Map<string, { seq: number; thinking?: string; sent?: TurnLog["sent"] }>();
  let turnSeq = 0;
  const usdcSettlements: UsdcSettlement[] = [];
  const testingPurchaseRequired = options.requireTestingPurchase === true;
  // Whoever can attack is who testing is bought FROM. Derived from the roster's own grants, so
  // adding or moving the adversary needs no edit here.
  const attackerSellerIds = options.roster
    .filter((a) => a.availableTools.includes("submit_attack"))
    .map((a) => a.erc8004Id);
  const testingIsEngaged = (): boolean =>
    testingEngaged(board, attackerSellerIds, options.requiredQuoteSiu);
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

  const agentAddressByAgentId = addressDirectory(options.roster, options.lab?.aliases);

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
        // Structural enforcement of the one rule a brief alone could not hold. A holder does not
        // owe its claim's delivery — the routed issuer does, and redemption grades that issuer's
        // own work (WorkClaim.sol's own top doc comment). WORKER-CODE's brief said exactly this,
        // in capitals, and it authored the gate anyway in all three windows of the 2026-09-28
        // run, after the same thing had already happened on 2026-09-26. Every one of those
        // windows then reported passed: true off work nobody had bought, which is how a scarcity
        // result came to be printed as the instrument succeeding.
        //
        // Deliberately keyed on holding rather than on identity: an agent that holds no claim
        // may author freely, and the routed issuer may always author — it is the one being
        // graded. Refused only for the agent currently standing on a live claim for this job.
        toolGuard: (toolName) =>
          submitJobRefusalFor(toolName, agent.agentId, redemption.viewFor(agent.agentId)) ??
          submitAttackRefusalFor(toolName, testingPurchaseRequired, testingIsEngaged()),
      }),
    ]),
  );

  const turnsByAgent: Record<string, number> = {};
  const haltedReason: FullRunWindowResult["haltedReason"] = {};
  const turnLogsByAgent: Record<string, TurnLog[]> = {};
  let infrastructureFailure: FullRunWindowResult["infrastructureFailure"];
  let totalRealizedUsd = 0;
  const realizedUsdByProvider: Record<string, number> = {};
  const attacks: AttackRecord[] = [];
  const forwardInvitations: { agentId: AgentId; turn: number }[] = [];
  const capacityEvents: CapacityEvent[] = [];
  /** Currency lab only: failures of the lab's own bookkeeping, which are the harness's, not an agent's. */
  const labErrors: { agentId: AgentId; turn: number; tool: string; message: string }[] = [];
  /**
   * Calls an agent made that FAILED — refused for their arguments, refused by a guard, or reverted — kept
   * so the agent is told. The history an agent reads is built from `runner.toolCallRecords()`, which holds
   * only calls that succeeded, so before this a failed call left no trace in the next prompt: the agent saw
   * "no turns yet" or a history with a gap, and could only retry blind. The comment on the args-error path
   * said it "sees this in its tool-call history exactly like any other tool error"; it did not, and no
   * agent in any run ever has. The sentence is the one the plain-error table already produced for the log.
   */
  const failedCallsByAgent = new Map<AgentId, ToolCallRecord[]>();
  /**
   * Currency lab only: what each agent actually called, by the name and arguments it used, keyed by agent and turn.
   * The loop runs the internal tool; the agent's history shows the call it made, so a renamed tool is never
   * called by two names in one prompt.
   */
  const callsAsMade = new Map<string, { name: string; args: unknown }>();
  const callKey = (agentId: AgentId, turn: number): string => `${agentId}#${turn}`;
  const recordFailedCall = (agentId: AgentId, turn: number, tool: string, args: unknown, sentence: string, rewrite = true): void => {
    const list = failedCallsByAgent.get(agentId) ?? [];
    const made = callsAsMade.get(callKey(agentId, turn));
    list.push({
      turn,
      jobId: options.job.jobId,
      toolName: made?.name ?? tool,
      args: made?.args ?? args,
      // A sentence about a tool the agent was not given names the loop's own tool on purpose, so it is not rewritten.
      result: { error: (rewrite ? options.lab?.rewriteText?.(sentence) : undefined) ?? sentence },
    });
    failedCallsByAgent.set(agentId, list);
  };
  /** The agent's successful and failed calls together, in the order they were made. */
  const historyFor = (agentId: AgentId, successes: readonly ToolCallRecord[]): ToolCallRecord[] =>
    [
      ...successes.map((r) => {
        const made = callsAsMade.get(callKey(agentId, r.turn));
        return made === undefined ? r : { ...r, toolName: made.name, args: made.args };
      }),
      ...(failedCallsByAgent.get(agentId) ?? []),
    ].sort((a, b) => a.turn - b.turn);

  /**
   * Everything this issuer owes, or may come to owe, from the three places the loop keeps it.
   *
   * Assembled here rather than in `buildToolArgs` because `capacityEvents` and `redemption` are
   * local to this window's closure. Spec §4.6x is why an issuer needs to be able to ask at all —
   * fifteen entries across seven runs saying it had no way to list what was presented or routed
   * to it. §4.6y is why it is a correctness fix rather than a convenience: of ten claims minted
   * and never served, not one was an issuer declining to deliver, so until an issuer can see its
   * own obligations a fulfilment measurement measures sight rather than reliability.
   */
  const buildObligationsFor = (agentId: AgentId): IssuerObligation[] => {
    const out: IssuerObligation[] = [];
    const mine = options.roster.find((r) => r.agentId === agentId)?.address?.toLowerCase();

    // Carried from an earlier window and never settled — these default against the bond.
    for (const c of options.outstandingClaims ?? []) {
      if (c.issuerAgentId !== agentId) continue;
      out.push({
        tokenId: c.tokenId,
        state: "carried_unsettled",
        ...(c.quantityMilliSiu !== undefined ? { quantityMilliSiu: c.quantityMilliSiu } : {}),
        holder: c.holderAgentId ?? c.holder,
        mintedInWindow: c.mintedInWindow,
      });
    }

    // Presented against this issuer in THIS window. Read from the tracker's own state rather
    // than parsed back out of its rendered prompt text, which was the first draft here and is
    // exactly the kind of second source of truth that drifts.
    const presentedTokenIds = new Set<string>();
    for (const presented of redemption.presentedAgainst(agentId)) {
      presentedTokenIds.add(presented.tokenId);
      out.push({
        tokenId: presented.tokenId,
        // Graded means the issuer owes only the serve_redemption report; ungraded means it still
        // owes the work. An issuer acts differently on each, so the states are kept apart.
        state: presented.graded ? "presented_graded_awaiting_service" : "presented_awaiting_delivery",
        quantityMilliSiu: presented.quantity,
        holder: presented.holder,
        mintedInWindow: windowIndex,
      });
    }

    // Minted against this issuer's bond this window and NOT presented. This is the state that
    // was invisible: headroom consumed, by a holder the issuer could not name, for work it could
    // not see. Matched on issuer ADDRESS, which is what the mint events carry.
    const concluded = new Set(
      capacityEvents
        .filter((e) => e.kind === "serve_redemption" || e.kind === "settle_window_close")
        .map((e) => e.tokenId)
        .filter((t): t is string => t !== undefined),
    );
    for (const e of capacityEvents) {
      if (e.kind !== "mint_claim" && e.kind !== "pay_with_claim") continue;
      if (e.tokenId === undefined || e.issuer === undefined || mine === undefined) continue;
      if (e.issuer.toLowerCase() !== mine) continue;
      if (presentedTokenIds.has(e.tokenId) || concluded.has(e.tokenId)) continue;
      if (out.some((o) => o.tokenId === e.tokenId)) continue;
      out.push({
        tokenId: e.tokenId,
        state: "minted_not_presented",
        ...(e.quantityMilliSiu !== undefined ? { quantityMilliSiu: e.quantityMilliSiu } : {}),
        mintedInWindow: windowIndex,
      });
    }
    return out;
  };

  /**
   * The holder's side of the same question: for each claim this agent holds or has presented,
   * has the issuer actually served it?
   *
   * WORKER-CODE asked for exactly this in run 13 and had no way to (spec §4.6w). It is the
   * mirror of `buildObligationsFor`, from the same tracker state, and exists for the same
   * reason: the loop knew and the agent could not ask.
   */
  const buildDeliveryFor = (agentId: AgentId): DeliveryStatus[] => redemption.deliveryFor(agentId);
  /** Agents that have completed at least one successful tool call this window — the "buyer" wake
   * gate's own definition of having acted. A call that threw does not count, so a buyer whose
   * purchase reverted is still awake to deal with it. */
  const actedSuccessfully = new Set<AgentId>();
  /**
   * Buyers that have actually BOUGHT something this window — not merely acted.
   *
   * The "buyer" wake gate used to key on `actedSuccessfully`, which is set by any successful
   * tool call. That was accidentally right for ORCHESTRATOR, whose first call is normally its
   * purchase, and wrong the moment a second buyer existed: WORKER-CODE opens with
   * `get_balances`, which would have retired it from the window before it could buy anything.
   * A buyer is idle when it has bought, not when it has called something.
   */
  const hasPurchased = new Set<AgentId>();
  /** Forward offers each agent has actually been shown in its own prompt, so an offer wakes a
   * buyer once rather than every round for as long as it stays open. */
  const shownForwardOffers = new Map<AgentId, Set<string>>();
  /** How many times each `<agentId>:<tool>` pair has been refused this window. A grant is static
   * for a window, so a third attempt at a tool already refused twice cannot succeed — see the
   * refusal counter at the tool-error branch. */
  /**
   * Gate defeats an author has not yet been told about — the feedback edge that closes the
   * hardening loop. Run 9 produced five false accepts and no revision, because nothing carried
   * an attack outcome back to the gate's author: `attackedVersions` was read only to wake the
   * adversary and to hold the window open. A gate that is never told it failed cannot revise,
   * and a false accept CLOSED BY A REVISION is the artefact; a false accept alone is half of it.
   */
  const gateDefeats: {
    attackIndex: number;
    gateVersion: number;
    author: AgentId;
    shape?: { length: number; min: number; max: number; hasDuplicates: boolean };
  }[] = [];
  const shownGateDefeats = new Map<AgentId, Set<number>>();
  /** Defeats `agentId` authored and has not been shown. Used by BOTH the prompt and the stall
   * check, deliberately through one function: a wake reason suppressed in one place and counted
   * in the other is exactly what deadlocked the 17:06 run. */
  const unseenDefeatsFor = (agentId: AgentId) =>
    gateDefeats.filter(
      (d) => d.author === agentId && !(shownGateDefeats.get(agentId)?.has(d.attackIndex) ?? false),
    );

  const refusedToolCalls = new Map<string, number>();
  /** Has `<agentId>:<tool>` already been refused twice this window? Hoisted out of the turn body
   * (2026-09-29) because the stall check below has to ask this about OTHER agents, not only the
   * one taking the turn. Suppressing an agent's own wake text while still counting that same text
   * as proof the window is live is a deadlock: the suppressed agent is gated out on its own turn,
   * every other agent sees it as able to act and skips, nothing awaits, and `turnLoop` spins at
   * 100% CPU forever. Found in a real run, not a test — see the stall guard at the loop head. */
  /**
   * Agents that have said they are waiting, and the actionable state they saw when they said it.
   *
   * An entry means "do not ask again until `boardSectionText` differs from this". Cleared the
   * moment it does, so a wait costs exactly the one turn it was declared on. See `WaitIntent`.
   */
  const waitingOn = new Map<AgentId, string>();

  const refusedTwiceFor = (agentId: AgentId, tool: ToolName): boolean =>
    (refusedToolCalls.get(`${agentId}:${tool}`) ?? 0) >= 2;

  /**
   * Whether this agent still has a forward quote worth waking it for.
   *
   * ONE definition, used by the wake gate and by the `someoneCanAct` stall check, for the reason
   * `refusedTwiceFor` above exists: a `continue` is synchronous, so any disagreement between
   * "this agent has nothing to do" and "some other agent can act" is not a stall but an unbounded
   * busy loop. These two were previously written out twice.
   *
   * Three conditions, and the last two are each a defect found on 2026-09-30/10-01:
   *
   * - It must hold the tool at all.
   * - **It must not have been invited already this window** (spec §4.6s). The invitation used to
   *   clear only once the issuer actually quoted, so an issuer exercising the permission the
   *   prompt explicitly grants it — "or you may choose not to" — was re-asked every turn for the
   *   rest of the window. Declining was not a state the loop could represent, and the only move
   *   that stopped the asking was the move being asked for. Run 13 window 1: ISSUER-A woke four
   *   times, ISSUER-B six, each stopping on the exact turn it gave in. Asked once, an issuer that
   *   says no is left alone — which is what window 3 already demonstrated, where the invitation
   *   was never built and the idle issuer slept correctly through every cursor.
   * - **There must be a later window to quote for.** `buildToolArgs` throws for any
   *   `forWindow <= windowIndex`, so in the final window every call fails. Until now the two
   *   agreed only because the roster happens to drop `quote_forward` when `isLastWindow` — two
   *   invariants held together by coincidence, which is the §4.6o shape. Granting the tool in a
   *   final window, a one-line roster change nobody would question, would have had the loop
   *   invite an issuer every turn to call a tool that cannot succeed. The rule belongs here,
   *   beside the invitation, not only in the roster that feeds it.
   */
  const mayStillQuoteForwardFor = (
    agentId: AgentId,
    availableTools: readonly ToolName[],
  ): boolean =>
    availableTools.includes("quote_forward") &&
    windowIndex < windowCount &&
    !forwardInvitations.some((i) => i.agentId === agentId) &&
    forwardBook.quotesBy(agentId).every((q) => q.statedInWindow !== windowIndex);
  const attackContext: AttackContext = {
    gateVersions: [],
    attackedVersions: new Set<number>(),
    oracleSeed: options.oracleSeed ?? F1_ORACLE_TRIAL_SEED,
  };

  /**
   * Whether a `submit_attack` could actually succeed right now.
   *
   * The same three conditions `buildToolArgs` enforces, in ONE place, so nothing that spends a
   * turn can disagree with the tool about whether there is anything to do. Before 2026-10-01
   * the wake gate asked only "does any gate exist?", the stall check asked the same, and
   * `untestedGate` asked "is any version unattacked?" — none of them consulted
   * `MAX_ATTACK_ROUNDS`, which is the thing that decides.
   *
   * Run 13 window 2 is what that cost: WORKER-EXTRACT took ten turns, every one a distinct
   * attack, and four were scored. Versions 1-3 had filled the cap, so the moment ISSUER-B
   * delivered a v4 every later call threw — six turns and $0.185 spent hitting a cap whose own
   * comment says it exists so the adversary "cannot spend the whole run's budget on itself"
   * (spec §4.6v).
   *
   * Re-testing a version already attacked stays allowed, because the tool allows it: that is how
   * attacks 1 and 2 both landed on v1.
   */
  const canAttackNow = (): boolean => {
    // Testing that has not been paid for cannot happen, so it is not something anyone can act on
    // and must not wake the adversary or hold the window open — the same blindness as the cap.
    if (testingPurchaseRequired && !testingIsEngaged()) return false;
    const latest = attackContext.gateVersions.at(-1);
    if (latest === undefined) return false;
    if (attackContext.attackedVersions.has(latest.version)) return true;
    return attackContext.attackedVersions.size < MAX_ATTACK_ROUNDS;
  };
  let passed = false;
  let passedBy: AgentId | typeof PRE_AUTHORED | undefined;

  for (const agent of options.roster) {
    turnsByAgent[agent.agentId] = 0;
    turnLogsByAgent[agent.agentId] = [];
  }

  /**
   * The pinned gate, graded for real before the first turn (`--debug` only).
   *
   * Everything downstream behaves as though a gate had been delivered on turn 0: the adversary
   * wakes because a version exists, attacks score against it normally, and the window can pass.
   * What is skipped is a model writing it — which is where a debugging run's money goes — not
   * the grading of it, which runs through the same `runGateHardeningChecks` on the same job
   * inputs as any submitted gate.
   *
   * Attributed to `PRE_AUTHORED`, never to an agent, so nothing downstream can credit a seat
   * with work it did not do.
   */
  if (options.preAuthoredGateSource !== undefined) {
    const inputs = {
      taskClass: options.job.taskClass,
      originalGate: options.job.originalGate,
      hardenedGate: { taskClass: options.job.taskClass, source: options.preAuthoredGateSource },
      referenceInstance: options.job.referenceInstance,
      knownGoodSubmission: options.job.knownGoodSubmission,
      adversarialSubmissions: options.job.adversarialSubmissions,
      heldOutInstances: options.job.heldOutInstances,
    } as unknown as GateHardeningJobInputs;
    const graded = await options.deps.runGateHardeningChecks(inputs);
    attackContext.gateVersions.push({
      version: 1,
      source: options.preAuthoredGateSource,
      submittedBy: PRE_AUTHORED,
      turn: 0,
    });
    if (graded.passed) {
      passed = true;
      passedBy = PRE_AUTHORED;
    }
    options.onPreAuthoredGate?.(graded.passed, summarizeGateResult(graded));
  }

  const activeAgents = new Set(options.roster.map((a) => a.agentId));

  /** Cursor positions burned since anything last changed — see the stall guard below. */
  let cursorsSinceProgress = 0;
  let lastActiveSize = activeAgents.size;

  /**
   * The chain clock, refreshed once per pass over the roster rather than per agent.
   *
   * Its only consumer is the holder's unserved warning, which compares against a midpoint
   * typically minutes away, so a figure at most one round old is ample. Per-agent would add an
   * RPC to every skipped cursor, including the quiet rounds where nobody acts at all. The chain
   * clock and not `Date.now()` for the same reason `time_to_expiry` uses it: a devnet advances
   * its own clock, and a wall-clock comparison against a chain-measured expiry is two different
   * timelines.
   */
  let chainNowSeconds = Number(nowSeconds);

  turnLoop: for (let turnCursor = 0; ; turnCursor++) {
    if (activeAgents.size === 0) break;
    if (turnCursor % options.roster.length === 0 && turnCursor > 0) {
      chainNowSeconds = Number(await options.deps.chainReader.currentBlockTimestamp());
    }

    // A round-robin skip is synchronous: `continue` awaits nothing and changes nothing. So any
    // disagreement between "this agent has nothing to act on" and "some other agent can act"
    // is not a stall, it is an unbounded busy loop — no output, no turns, no end, 100% CPU.
    // That happened for real on 2026-09-29 (run 17:06, 39 minutes of CPU, all three window
    // spans lost) when the retry cap blanked an issuer's wake text without blanking the same
    // text in the stall check. That specific disagreement is fixed at its source above; this
    // guard exists so the NEXT one costs a clean stop and a recorded reason instead of a run.
    // Two full passes over the roster with nothing changing is conclusive: the set of active
    // agents is fixed, so a third pass reads exactly the same state as the second.
    if (activeAgents.size !== lastActiveSize) {
      lastActiveSize = activeAgents.size;
      cursorsSinceProgress = 0;
    }
    if (++cursorsSinceProgress > options.roster.length * 2) {
      if (options.lab !== undefined && (await options.lab.advanceRound())) {
        cursorsSinceProgress = 0;
        continue;
      }
      for (const waiting of activeAgents) {
        haltedReason[waiting] ??= "nothing_to_act_on";
      }
      break turnLoop;
    }

    if (options.windowSpanEndsAtUnixSeconds !== undefined) {
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      if (nowSeconds >= options.windowSpanEndsAtUnixSeconds) {
        for (const waiting of activeAgents) {
          haltedReason[waiting] ??= "window_span_elapsed";
        }
        break turnLoop;
      }
    }

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

    const context = assembleContext(
      agent.agentId,
      agent.skillPackText,
      historyFor(agent.agentId, runner.toolCallRecords()),
    );
    recorder.recordContext(agent.agentId, turn, context);

    try {
      validateAgentContext(context, options.assetDescription);
      recorder.recordValidatorVerdict(agent.agentId, turn, null);
    } catch (err) {
      if (err instanceof ContextValidationError)
        recorder.recordValidatorVerdict(agent.agentId, turn, err);
      haltedReason[agent.agentId] = "validation_failed";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const marketBoardText = board.renderFor(agent.agentId, agent.erc8004Id);
    // A prompt that tells an agent to call a tool it has now been refused twice is an instruction
    // it cannot follow, and repeating it is what burned ISSUER-A to its cost ceiling in all three
    // windows of run 8. Two attempts is enough to establish the grant is not there. The claim
    // itself is unaffected — it stays outstanding, still defaults, and its holder or anyone else
    // can still settle it; only this agent stops being told to do the impossible.
    const refusedTwice = (tool: ToolName): boolean => refusedTwiceFor(agent.agentId, tool);
    // The claim-presentation notices tell a holder to "call redeem_claim" and an issuer to "call
    // submit_job" / "serve_redemption". A currency-lab trader holds none of those tools, so in a lab
    // run they are not shown at all: a notice that names an action the system will refuse is the
    // defect §4.6-RULE exists to prevent. The lab's own board text carries what a trader needs.
    const redemptionText =
      options.lab !== undefined || refusedTwice("serve_redemption")
        ? ""
        : redemption.renderFor(agent.agentId);
    const transferText =
      options.lab !== undefined ? "" : redemption.renderForHolder(agent.agentId, chainNowSeconds);
    // Held, never presented, window closing — the stage before `unservedText`, and the costlier
    // one: an unpresented claim expires paying nothing (fsiu-design.md §4.3a).
    const lapsingText =
      options.lab !== undefined
        ? ""
        : redemption.renderUnpresentedLapsingForHolder(agent.agentId, chainNowSeconds);
    const deliveryOwedText =
      options.lab !== undefined || refusedTwice("submit_job")
        ? ""
        : redemption.renderForIssuerAwaitingDelivery(agent.agentId);
    const canQuoteForward = agent.availableTools.includes("quote_forward");
    // An issuer's own standing offers are NOT an inbox item: they are not an arrival, and an
    // issuer whose only reason to wake is its own earlier quote would spin turns re-reading it.
    const forwardText = forwardBook.renderFor(agent.agentId, windowIndex, canQuoteForward);
    // The one exception, and the reason it is separate: an issuer that has not yet stated terms
    // for a later window genuinely does have something to do before anything is routed to it —
    // and gating that on an inbox would mean it could only ever quote *after* being minted
    // against, which is exactly when a forward offer stops being forward.
    const mayStillQuoteForward = mayStillQuoteForwardFor(agent.agentId, agent.availableTools);
    // An unsettled claim from an earlier window is a real inbox item for whoever can settle it —
    // and unlike the forward invitation it genuinely is an arrival, so it belongs in the
    // wait-gate's own definition of "something to act on". Shown only to agents that actually
    // hold the tool.
    // Filtered against what has ALREADY happened in this window, not just what was true when the
    // window opened. `options.outstandingClaims` is a snapshot the caller builds between windows;
    // until 2026-09-29 it was read unchanged on every turn, so a claim settled or served mid-
    // window went on being advertised as settleable for the rest of it. Found live in P5 run 3:
    // ISSUER-B settled a claim on its turn 3, and WORKER-CODE — correctly acting on a board that
    // still listed it — then spent turns 5 through 10 calling settle_window_close on it, every
    // one reverting, and did the same again the next window. Roughly a fifth of that run's real
    // inference spend went on calls that could not have succeeded. The board must not advertise a
    // terminal claim as actionable.
    const concludedThisWindow = new Set(
      capacityEvents
        .filter((e) => e.kind === "settle_window_close" || e.kind === "serve_redemption")
        .map((e) => e.tokenId)
        .filter((id): id is string => id !== undefined),
    );
    const outstandingClaims = (options.outstandingClaims ?? []).filter(
      (c) => !concludedThisWindow.has(c.tokenId),
    );
    const settleableText = renderSettleableText(
      outstandingClaims,
      agent.availableTools.includes("settle_window_close"),
    );

    // What the adversary is actually able to attack, said out loud in its own prompt.
    //
    // Found live, 2026-09-29 run 8 window 1: ISSUER-A authored a gate that passed G1-G6 — the
    // first valid gate in the project's history — and WORKER-EXTRACT, woken on the very next turn
    // BECAUSE that gate existed, reported "nothing has been delivered yet" and left the window.
    // It was right. `attackContext.gateVersions` drove the wake gate and chose which gate
    // `submit_attack` targets, and appeared in no prompt anywhere: the loop knew, the adversary
    // did not. Exactly the shape of every other affordance defect found today — the system holds
    // the fact and never tells the agent.
    //
    // Shown only to agents that can actually attack, and the source is deliberately NOT included:
    // the adversary's job is to find what a gate fails to check by probing it, not to read it.
    const attackableGates =
      agent.availableTools.includes("submit_attack") &&
      (!testingPurchaseRequired || testingIsEngaged())
        ? attackContext.gateVersions.filter((g) => !attackContext.attackedVersions.has(g.version))
        : [];
    const deliveredGateText =
      attackableGates.length > 0
        ? `A GATE HAS BEEN DELIVERED AND YOU HAVE NOT TESTED IT\n` +
          attackableGates
            .map(
              (g) =>
                `  version ${g.version}, submitted by ${g.submittedBy} on turn ${g.turn}. ` +
                `submit_attack tests the latest delivered version; you do not choose one and you ` +
                `do not see its source.`,
            )
            .join("\n")
        : "";

    // What the author is told: that its gate was defeated, how many times, and the SHAPE of the
    // input that did it — never the attack's source. The adversary's job is to probe by
    // behaviour and the author's is to widen its own tests; handing over the submission would
    // collapse both into copying. Rendered into boardSectionText below so the wake gate and the
    // prompt cannot disagree about whether there is something here to act on.
    const unseenDefeats = unseenDefeatsFor(agent.agentId);
    const gateDefeatedText =
      unseenDefeats.length > 0
        ? `YOUR GATE WAS DEFEATED\n` +
          unseenDefeats
            .map((d) => {
              const where = d.shape
                ? `an input of length ${d.shape.length}, values ${d.shape.min}..${d.shape.max}` +
                  `${d.shape.hasDuplicates ? ", containing duplicates" : ", all distinct"}`
                : "an input whose shape was not recorded";
              return (
                `  version ${d.gateVersion} accepted a submission the independent oracle rejects. ` +
                `It fails on ${where}. You do not see the submission.`
              );
            })
            .join("\n") +
          `\n  Your gate accepted work that is wrong. If its tests do not reach inputs like that, ` +
          `widen them and submit a revised gate with submit_job.`
        : "";

    const forwardInvitation = mayStillQuoteForward
      ? `FORWARD TERMS\n  You have not stated terms for a later window of this run yet. You may (quote_forward), ` +
        `or you may choose not to — nothing here suggests a price, a quantity, or whether to quote at all.`
      : "";
    // The holder's own two sections (spec §4.6ae). `servedText` is informational on a PASS and
    // actionable on a FAIL; `unservedText` fires once, when the holder has waited longer than it
    // has left. Both are built only from facts the holder's own `redeem_claim` result returned.
    const servedText = options.lab !== undefined ? "" : redemption.renderServedForHolder(agent.agentId);
    const unservedText =
      options.lab !== undefined ? "" : redemption.renderUnservedForHolder(agent.agentId, chainNowSeconds);
    const labInfoText = (await options.lab?.infoTextFor(agent.agentId)) ?? "";
    const labActionText = options.lab?.actionTextFor(agent.agentId) ?? "";

    const { shown: boardSectionText, wakeKey, wakeKeyNext } = composeBoard({
      marketBoardText,
      redemptionText,
      transferText,
      deliveryOwedText,
      settleableText,
      servedText,
      servedWasFailure: redemption.servedFailureFor(agent.agentId),
      unservedText,
      lapsingText,
      deliveredGateText,
      gateDefeatedText,
      forwardInvitation,
      labInfoText,
      labActionText,
    }, agent.availableTools);

    // Skipped before the model is called and before the turn counter moves, so waiting costs
    // nothing. Guarded against a stall: if every remaining agent is waiting, nothing will ever
    // arrive to wake them, so the window ends rather than spinning.
    // A forward offer this agent has not been shown yet is a real arrival for anyone who could
    // act on one. Bounded to once per offer per agent rather than "while any offer is open", so
    // a standing offer nobody takes wakes a buyer exactly once instead of every round — the same
    // idle-burn this whole gate exists to stop.
    const unseenForwardOffer =
      agent.availableTools.includes("take_forward") &&
      forwardBook
        .all()
        .some(
          (q) =>
            q.takenInWindow === null &&
            q.forWindow >= windowIndex &&
            q.issuer !== agent.agentId &&
            !(shownForwardOffers.get(agent.agentId)?.has(q.quoteId) ?? false),
        );
    const buyerIdle =
      agent.waitsFor === "buyer" &&
      hasPurchased.has(agent.agentId) &&
      wakeKey === "" &&
      !unseenForwardOffer;
    if (
      // "gate" waits for a gate to exist AND for its own inbox to be empty. The adversary is also
      // a seller: a buyer may request a quote for attack testing before any gate has been
      // authored, and gating purely on the gate meant that request could never be answered — the
      // second of a window's two purchases was structurally unreachable (found while enabling it,
      // 2026-09-29).
      (agent.waitsFor === "gate" && !canAttackNow() && wakeKey === "") ||
      (agent.waitsFor === "inbox" && wakeKey === "") ||
      // A wait the agent declared itself, honoured until what it can act on actually changes.
      // Checked here with the other wake conditions so one `continue` covers every way of
      // having nothing to do.
      waitingOn.get(agent.agentId) === wakeKey ||
      buyerIdle
    ) {
      const someoneCanAct = [...activeAgents].some((id) => {
        const other = options.roster.find((r) => r.agentId === id);
        if (!other?.waitsFor) return true;
        if (other.waitsFor === "gate" && canAttackNow()) return true;
        if (other.waitsFor === "buyer" && !hasPurchased.has(other.agentId)) return true;
        return (
          (options.lab?.actionTextFor(other.agentId) ?? "") !== "" ||
          board.renderFor(other.agentId, other.erc8004Id) !== "" ||
          // Both of these are gated by the same retry cap that blanks the agent's own wake text
          // above. Asking the unsuppressed renderer here is what deadlocked the 17:06 run: a
          // claim pending against an issuer already refused `serve_redemption` twice counted as
          // "someone can act" on every other agent's turn, while that issuer had nothing to act
          // on when its own turn came round.
          (!refusedTwiceFor(other.agentId, "serve_redemption") &&
            redemption.renderFor(other.agentId) !== "") ||
          redemption.renderForHolder(other.agentId) !== "" ||
          (!refusedTwiceFor(other.agentId, "submit_job") &&
            redemption.renderForIssuerAwaitingDelivery(other.agentId) !== "") ||
          // A settleable claim is something to act on for whoever holds the tool — it was
          // missing from this guard, so a window whose only remaining business was an unsettled
          // claim could be declared stalled while that claim sat there.
          unseenDefeatsFor(other.agentId).length > 0 ||
          (other.availableTools.includes("settle_window_close") && outstandingClaims.length > 0) ||
          (other.availableTools.includes("take_forward") &&
            forwardBook
              .all()
              .some(
                (q) =>
                  q.takenInWindow === null &&
                  q.forWindow >= windowIndex &&
                  q.issuer !== other.agentId &&
                  !(shownForwardOffers.get(other.agentId)?.has(q.quoteId) ?? false),
              )) ||
          mayStillQuoteForwardFor(other.agentId, other.availableTools)
        );
      });
      if (someoneCanAct) continue;
      // Nobody can act. In a lab run that is the end of a ROUND, not of the window: open the next one
      // and let everyone be re-evaluated against its text.
      if (options.lab !== undefined && (await options.lab.advanceRound())) {
        cursorsSinceProgress = 0;
        continue;
      }
      for (const waiting of activeAgents) {
        if (options.roster.find((r) => r.agentId === waiting)?.waitsFor) {
          haltedReason[waiting] = "nothing_to_act_on";
        }
      }
      break turnLoop;
    }

    // Past the wake gate: this agent is really taking a turn, so the loop is making progress.
    cursorsSinceProgress = 0;

    // Marked here, not where the notice is built: an agent gated out before its adapter is
    // called never actually saw it, and treating that as "told" is the same conflation the
    // forward-invitation record already avoids.
    if (unseenDefeats.length > 0) {
      const shown = shownGateDefeats.get(agent.agentId) ?? new Set<number>();
      for (const d of unseenDefeats) shown.add(d.attackIndex);
      shownGateDefeats.set(agent.agentId, shown);
    }

    // Recorded here, not where the invitation text is built: an agent that is gated out before
    // its adapter is called never actually saw it, and counting that as "prompted" is exactly the
    // conflation this record exists to prevent.
    if (forwardInvitation !== "") forwardInvitations.push({ agentId: agent.agentId, turn });

    // Marked here for the same reason forwardInvitations is: past the wait-gate, this agent's
    // prompt genuinely carries `forwardText`, so these offers have now actually been seen. Doing
    // it earlier would record an offer as shown to an agent that never got a turn.
    if (forwardText !== "") {
      let seen = shownForwardOffers.get(agent.agentId);
      if (seen === undefined) {
        seen = new Set<string>();
        shownForwardOffers.set(agent.agentId, seen);
      }
      for (const q of forwardBook.all()) seen.add(q.quoteId);
    }

    // Same discipline, same reason (spec §4.6ae): the holder's unserved warning is marked shown
    // only once it is genuinely in a prompt an agent received. Marking it when the text is built
    // would burn the one showing on an agent the wait-gate then skipped, and the holder would
    // never hear about its own undelivered claim at all.
    if (unservedText !== "") redemption.markUnservedWarningShown(agent.agentId);
    if (lapsingText !== "") redemption.markLapsingWarningShown(agent.agentId);

    const prompt = buildTurnPrompt(
      context,
      toolOrderByAgent[agent.agentId],
      [boardSectionText, forwardText].filter(Boolean).join("\n\n"),
      options.lab?.toolDescription?.bind(options.lab),
    );
    const projectedUsd = projectedTurnCostUsd(
      Math.ceil(prompt.length / 4),
      agent.projectedOutputTokens ?? agent.maxOutputTokens,
      agent.prices,
    );

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
    //
    // A function because a turn can now make this call twice (an empty completion at the token
    // budget is retried once, below); everything one call involves — the failure guard, the cost
    // it incurred, its record on disk — happens identically both times.
    const callModel = async (
      attempt: number,
      firstAttempt?: NonNullable<TurnLog["infrastructureRetry"]>["firstAttempt"],
    ): Promise<{ result: AdapterResult; realizedUsd: string } | "provider_failure"> => {
      let result: AdapterResult;
      try {
        result = await agent.adapter(agent.modelString, prompt, adapterParams);
      } catch (err) {
        const category = classifyFailure(err);
        const message = err instanceof Error ? err.message : String(err);
        const log: TurnLog = {
          turn,
          promptChars: prompt.length,
          projectedUsd,
          realizedUsd: "0",
          marketBoardText: marketBoardText || undefined,
          latencyMs: 0,
          parsed: `${category}: ${message}`,
          providerFailure: { category, message },
          ...(firstAttempt !== undefined
            ? { infrastructureRetry: { outcome: "retry_failed" as const, firstAttempt } }
            : {}),
        };
        turnExtras.set(`${agent.agentId}#${turn}`, { seq: ++turnSeq });
        turnLogsByAgent[agent.agentId].push(log);
        options.onTurn?.(agent.agentId, log);
        haltedReason[agent.agentId] =
          category === "policy_refusal" ? "policy_refusal" : "adapter_error";
        activeAgents.delete(agent.agentId);
        await friction.append(
          buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null, {
            attempted: "model call",
            outcome: `provider ${category}: ${message}`,
          }),
        );
        return "provider_failure";
      }

      const callUsd = realizedTurnCostUsd(result.usage.input, result.usage.output, agent.prices);
      totalRealizedUsd += Number(callUsd);
      realizedUsdByProvider[agent.provider] =
        (realizedUsdByProvider[agent.provider] ?? 0) + Number(callUsd);
      // Recorded for the ledger and every report; gates nothing, since the call has already
      // happened. The pre-call projection above is what the caps are enforced against.
      options.budget.recordRealizedInferenceSpend(callUsd);

      // Written here, before any branch inspects the response and before parsing is attempted, so
      // that a turn which then fails to parse is recorded exactly as fully as one that succeeds. A
      // parse failure re-writes this same file below with `parseError` filled in; if the process
      // dies in between, the call itself is already on disk. See ModelCallRecord.
      const thinking = extractThinking(result.raw);
      turnExtras.set(`${agent.agentId}#${turn}`, {
        seq: ++turnSeq,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(result.sent !== undefined ? { sent: result.sent } : {}),
      });
      recorder.recordMessage(agent.agentId, turn, {
        prompt,
        rawText: result.text,
        stopReason: result.stopReason,
        usage: result.usage,
        contentBlockTypes: result.contentBlockTypes,
        latencyMs: result.latency_ms,
        ...(thinking !== undefined ? { thinking } : {}),
        ...(result.sent !== undefined ? { sent: result.sent } : {}),
        ...(result.deviations.length > 0 ? { deviations: result.deviations } : {}),
        ...(attempt > 1 ? { attempt } : {}),
      });
      return { result, realizedUsd: callUsd };
    };

    const firstCall = await callModel(1);
    if (firstCall === "provider_failure") continue;
    let adapterResult = firstCall.result;
    let realizedUsd = firstCall.realizedUsd;
    // The turn's attempt number for anything written about it from here on: 1 unless retried.
    let attemptNumber = 1;
    let infrastructureRetry: TurnLog["infrastructureRetry"];

    // An empty completion at the token budget is the harness's failure, not a decision (see
    // loop/empty-completion.ts). The same prompt is sent once more, with the same parameters —
    // widening the budget here would change what the agent was asked to do, and the adapters
    // already make their own reasoning-budget accommodation before a result gets this far. Both
    // calls are costed and written to disk; the discarded one is described on the turn's log.
    if (isEmptyAtTokenBudget(adapterResult)) {
      const firstAttempt = {
        stopReason: adapterResult.stopReason,
        contentBlockTypes: adapterResult.contentBlockTypes,
        usage: adapterResult.usage,
        realizedUsd,
        latencyMs: adapterResult.latency_ms,
      };
      recorder.recordMessage(agent.agentId, turn, {
        prompt,
        rawText: adapterResult.text,
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
        latencyMs: adapterResult.latency_ms,
        attempt: 1,
      });
      try {
        options.budget.recordInferenceSpend(agent.agentId, options.windowId, projectedUsd);
      } catch (err) {
        if (err instanceof ExperimentCapExceededError) {
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
      const retried = await callModel(2, firstAttempt);
      if (retried === "provider_failure") continue;
      adapterResult = retried.result;
      realizedUsd = retried.realizedUsd;
      attemptNumber = 2;

      if (isEmptyAtTokenBudget(adapterResult)) {
        const detail =
          `agent ${agent.agentId}, turn ${turn}: two consecutive completions ended at the token ` +
          `budget (stop reason "${adapterResult.stopReason}") with no text`;
        const log: TurnLog = {
          turn,
          promptChars: prompt.length,
          projectedUsd,
          realizedUsd,
          marketBoardText: marketBoardText || undefined,
          rawText: adapterResult.text,
          promptText: prompt,
          settleableText: settleableText || undefined,
          forwardText: forwardText || undefined,
          latencyMs: adapterResult.latency_ms,
          stopReason: adapterResult.stopReason,
          usage: adapterResult.usage,
          contentBlockTypes: adapterResult.contentBlockTypes,
          parsed: `infrastructure_failure: ${detail}`,
          infrastructureRetry: { outcome: "recurred", firstAttempt },
        };
        turnLogsByAgent[agent.agentId].push(log);
        options.onTurn?.(agent.agentId, log);
        infrastructureFailure = {
          agentId: agent.agentId,
          turn,
          attempts: 2,
          stopReason: adapterResult.stopReason,
          detail,
        };
        await friction.append(
          buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null, {
            attempted: "model call",
            outcome: `infrastructure failure: ${detail}`,
          }),
        );
        // The run is excluded whatever happens next, so nothing further is worth buying: every
        // agent still in is stopped, this one included.
        for (const other of activeAgents) haltedReason[other] = "run_infrastructure_failed";
        break turnLoop;
      }
      infrastructureRetry = { outcome: "recovered", firstAttempt };
    }

    // Every log written from here on describes the surviving call; when that call was a retry,
    // the log says so, so a reader of metrics.json never meets a turn that cost twice without
    // being told why.
    const pushLog = (log: TurnLog): void => {
      if (infrastructureRetry !== undefined && log.infrastructureRetry === undefined) {
        log.infrastructureRetry = infrastructureRetry;
      }
      turnLogsByAgent[agent.agentId].push(log);
    };

    // A refusal that arrives on a 200 — the commoner shape, reported via the provider's own stop
    // reason. Caught before parsing, so it is never recorded as unparseable output.
    if (isPolicyRefusalStopReason(adapterResult.stopReason)) {
      const log: TurnLog = {
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        marketBoardText: marketBoardText || undefined,
        rawText: adapterResult.text,
        promptText: prompt,
        settleableText: settleableText || undefined,
        forwardText: forwardText || undefined,
        latencyMs: adapterResult.latency_ms,
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
        parsed: `policy_refusal: provider returned stop reason "${adapterResult.stopReason}"`,
        providerFailure: {
          category: "policy_refusal",
          message: `stop reason "${adapterResult.stopReason}"`,
        },
      };
      pushLog(log);
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
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        marketBoardText: marketBoardText || undefined,
        rawText: adapterResult.text,
        promptText: prompt,
        settleableText: settleableText || undefined,
        forwardText: forwardText || undefined,
        latencyMs: adapterResult.latency_ms,
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
        parsed: err instanceof Error ? err.message : String(err),
      };
      pushLog(log);
      options.onTurn?.(agent.agentId, log);
      recorder.recordMessage(agent.agentId, turn, {
        prompt,
        rawText: adapterResult.text,
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
        latencyMs: adapterResult.latency_ms,
        parseError: err instanceof Error ? err.message : String(err),
        ...(attemptNumber > 1 ? { attempt: attemptNumber } : {}),
      });
      if (err instanceof ModelResponseParseError) {
        // A response that contains no text block at all is not a model that emitted bad JSON —
        // it is a model that never got as far as emitting anything. Found live, 2026-09-29 (P5
        // run 3): WORKER-CODE/claude-sonnet-5 spent 22,500 output tokens, 21,782 of them
        // reasoning, returned `contentBlockTypes: ["thinking"]` and no text, and was recorded as
        // a parse failure indistinguishable from two genuine mid-JSON truncations — which is
        // exactly what made the run's four failures look like one cause instead of three. The
        // turn still ends here; only the label is different, because conflating the two is what
        // cost the diagnosis. The adapter's own reasoning-accommodation retry (adapters/
        // types.ts's REASONING_BUDGET_MULTIPLE) has already happened by this point and did not
        // help.
        const emittedNoText =
          adapterResult.text.trim() === "" ||
          (adapterResult.contentBlockTypes !== undefined &&
            adapterResult.contentBlockTypes.length > 0 &&
            adapterResult.contentBlockTypes.every((t) => t === "thinking"));
        haltedReason[agent.agentId] = emittedNoText ? "no_text_emitted" : "parse_error";
        activeAgents.delete(agent.agentId);
        await friction.append(
          buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null),
        );
        continue;
      }
      throw err;
    }

    if ("wait" in intent) {
      const log: TurnLog = {
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        marketBoardText: marketBoardText || undefined,
        rawText: adapterResult.text,
        promptText: prompt,
        settleableText: settleableText || undefined,
        forwardText: forwardText || undefined,
        latencyMs: adapterResult.latency_ms,
        parsed: JSON.stringify(intent),
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
      };
      pushLog(log);
      options.onTurn?.(agent.agentId, log);
      // NOT removed from activeAgents — the whole difference from `done`. The agent stays in
      // the window and is woken the moment its own actionable state differs from what it saw
      // when it said it was waiting. `wakeKey` is that state — the subset of the board text
      // that affords a NEW action, so a wait is woken by exactly the arrivals a non-waiting
      // agent would have been woken by, and by nothing else. Being woken with an already-paid
      // quote still on the board — which happened to ORCHESTRATOR once — would put the agent
      // straight back into the forced choice this exists to end.
      //
      // Keyed on `wakeKey` and NOT on `boardSectionText` since 2026-10-02 (spec §4.6ae). They
      // were the same string, and the cost was that a holder could not be told anything without
      // also being woken — so it was told nothing, and run 16's holder slept through its own
      // undelivered claim. Informational text may now change freely without spending a turn.
      // `wakeKeyNext`, never `wakeKey`: the one-shot sections in this turn's prompt are
      // suppressed the moment it is built, so parking the agent against the key it was SHOWN
      // means the suppression itself wakes it again on the next pass with an empty board
      // (spec §4.6ah, observed twice in run 17).
      waitingOn.set(agent.agentId, wakeKeyNext);
      haltedReason[agent.agentId] = "waiting";
      await friction.append(
        buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null, {
          ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        }),
      );
      continue;
    }

    if ("done" in intent) {
      const log: TurnLog = {
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        marketBoardText: marketBoardText || undefined,
        rawText: adapterResult.text,
        promptText: prompt,
        settleableText: settleableText || undefined,
        forwardText: forwardText || undefined,
        latencyMs: adapterResult.latency_ms,
        parsed: JSON.stringify(intent),
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
      };
      pushLog(log);
      options.onTurn?.(agent.agentId, log);
      haltedReason[agent.agentId] = "voluntary_stop";
      activeAgents.delete(agent.agentId);
      await friction.append(
        buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null, {
          ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        }),
      );
      continue;
    }

    // Currency lab: the agent calls a tool by the name it was shown. Resolve it to the tool the loop runs, and remember
    // the call as the agent made it, for its history. A renamed tool called by its old internal name is refused.
    if (options.lab?.resolveCall !== undefined) {
      const resolved = options.lab.resolveCall(agent.agentId, intent.tool, intent.args);
      if (resolved !== undefined) {
        callsAsMade.set(callKey(agent.agentId, turn), { name: intent.tool, args: intent.args });
        if ("refuse" in resolved) {
          const log: TurnLog = {
            turn,
            promptChars: prompt.length,
            projectedUsd,
            realizedUsd,
            marketBoardText: marketBoardText || undefined,
            rawText: adapterResult.text,
            promptText: prompt,
            settleableText: settleableText || undefined,
            forwardText: forwardText || undefined,
            latencyMs: adapterResult.latency_ms,
            stopReason: adapterResult.stopReason,
            usage: adapterResult.usage,
            contentBlockTypes: adapterResult.contentBlockTypes,
            parsed: `${JSON.stringify(intent)} -> tool call error: ${resolved.refuse}`,
          };
          recordFailedCall(agent.agentId, turn, intent.tool, intent.args, resolved.refuse, false);
          pushLog(log);
          options.onTurn?.(agent.agentId, log);
          await friction.append(
            buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null, {
              ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
            }),
          );
          continue;
        }
        intent = { ...intent, tool: resolved.tool, args: resolved.args };
      }
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
        outstandingClaims: options.outstandingClaims,
        obligationsFor: buildObligationsFor,
        deliveryFor: buildDeliveryFor,
        caller: { agentId: agent.agentId, erc8004Id: agent.erc8004Id },
        requiredQuoteSiu: options.requiredQuoteSiu,
        ...(options.deps.directSettlement === true ? { directSettlement: true } : {}),
        ...(options.lab?.printForQuote !== undefined ? { printForQuote: (id: string) => options.lab!.printForQuote!(id) } : {}),
        ...(options.lab?.claimForQuote !== undefined ? { claimForQuote: (id: string) => options.lab!.claimForQuote!(id) } : {}),
        ...(options.lab !== undefined
          ? { labGuard: (t: ToolName, a: unknown) => options.lab!.guard(agent.agentId, t, a) }
          : {}),
      });
    } catch (err) {
      // A real, disclosed failure (an unknown requestId, a missing address) — not a crash. The
      // model's own next turn sees this in its tool-call history exactly like any other tool
      // error, since Runner.callTool would have surfaced the same shape for a real revert.
      const log: TurnLog = {
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        marketBoardText: marketBoardText || undefined,
        rawText: adapterResult.text,
        promptText: prompt,
        settleableText: settleableText || undefined,
        forwardText: forwardText || undefined,
        latencyMs: adapterResult.latency_ms,
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
        parsed: `${JSON.stringify(intent)} -> args error: ${err instanceof Error ? err.message : String(err)}`,
      };
      recordFailedCall(agent.agentId, turn, intent.tool, intent.args, err instanceof Error ? err.message : String(err));
      pushLog(log);
      options.onTurn?.(agent.agentId, log);
      await friction.append(
        buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null, {
          ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        }),
      );
      continue;
    }

    try {
      // Always the real, recorded call — allowlist-checked and ceiling-charged exactly once via
      // Runner, regardless of which tool this is. The determinism check (below) is an *extra*
      // verification alongside this, never a substitute for it — bypassing Runner to "check
      // twice instead of calling for real" would skip the allowlist check for this specific tool.
      const record = await runner.callTool(intent.tool, args, { turn, jobId: options.job.jobId });
      // The call returned rather than throwing, so this agent has genuinely acted this window —
      // see `actedSuccessfully` and the "buyer" wake gate.
      actedSuccessfully.add(agent.agentId);
      if (settlesQuote(intent.tool) || intent.tool === "mint_claim") {
        hasPurchased.add(agent.agentId);
      }
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
        // The same real figure, handed to the tracker so the holder can be told its own
        // deadline. No extra RPC: this is the read above, reused. See fsiu-design.md §4.3a —
        // the loop has held this number all along and the arrival notice never carried it.
        if (fields.tokenId !== undefined && timeToExpirySeconds !== undefined) {
          redemption.recordExpiry(
            fields.tokenId,
            chainNowSeconds + timeToExpirySeconds,
            chainNowSeconds,
          );
        }
        const recorded: CapacityEvent = {
          agentId: agent.agentId,
          turn,
          kind,
          ...(timeToExpirySeconds === undefined ? {} : { timeToExpirySeconds }),
          ...fields,
        };
        capacityEvents.push(recorded);
        claimLedger.apply(recorded, (address) => agentIdByAddress[address.toLowerCase()]);
      };

      let postedRequestId: string | undefined;
      let settledRequestIdForLab: string | undefined;
      if (intent.tool === "request_quote") {
        postedRequestId = board.postRequest(agent.agentId, record.result as QuoteBody).requestId;
      }
      if (intent.tool === "issue_quote") {
        const requestId = (intent.args as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === "string") {
          board.postIssuedQuote(requestId, record.result as TouchstoneQuote);
        }
      }

      // Payment is the one event both sides of a dollar deal must be woken by: it is the buyer's
      // resolution and the seller's obligation. Recorded from the real tool result, so the board
      // can stop advertising a paid quote to its buyer and start telling its seller it owes work.
      //
      // ALL THREE settlement routes mark the quote paid, not just the dollar one. Until
      // 2026-09-30 only `pay` did, which meant an fSIU payment could not settle a quote at all:
      // the seller saw a claim arrive while its quote stayed open on the board, so it was never
      // told it owed the work. `settle_split` shipped with the same gap earlier the same day.
      // That is the shape of failure that cost run 4's window 1 — an escrow with no settle leg —
      // and it is why WORKER-CODE could not have paid a quote in claims before this.
      if (settlesQuote(intent.tool)) {
        const requestId = (intent.args as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === "string") board.recordPaid(requestId, assetSettledBy(intent.tool));
        // BEFORE this payment's own capacity event reaches the ledger (that happens below, in
        // `recordCapacityEvent`), so a claim being passed on still counts as held while it is.
        const settledQuote =
          typeof requestId === "string" ? board.issuedQuoteById(requestId) : undefined;
        paymentMoments.push({
          agentId: agent.agentId,
          turn,
          tool: intent.tool,
          asset: assetSettledBy(intent.tool),
          ...(typeof requestId === "string" ? { requestId } : {}),
          heldReceivedMilliSiu: claimLedger.heldReceived(agent.agentId).toString(),
          heldTotalMilliSiu: claimLedger.heldTotal(agent.agentId).toString(),
          ...(settledQuote !== undefined
            ? {
                quotedSiu: settledQuote.siu,
                quoteRateUsdPerSiu: settledQuote.rate_usd_per_siu,
                quotedUsdMax: settledQuote.amount_usd_max,
              }
            : {}),
        });
      }

      const settlesRequestId =
        typeof (intent.args as { requestId?: unknown } | undefined)?.requestId === "string"
          ? ((intent.args as { requestId: string }).requestId)
          : undefined;

      if (intent.tool === "mint_claim") {
        const mintResult = record.result as {
          tokenId: string;
          issuer: string;
          txHash?: string;
          mintCostMinorUnits?: string;
        };
        const issuerAgentId = agentIdByAddress[mintResult.issuer.toLowerCase()];
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        if (issuerAgentId && typeof quantity === "string") {
          redemption.recordMint(mintResult.tokenId, issuerAgentId, quantity, agent.agentId);
        }
        await recordCapacityEvent("mint_claim", {
          tokenId: mintResult.tokenId,
          issuer: mintResult.issuer,
          ...(typeof quantity === "string" ? { quantityMilliSiu: quantity } : {}),
          ...(mintResult.txHash ? { txHash: mintResult.txHash } : {}),
          ...(mintResult.mintCostMinorUnits !== undefined
            ? { mintCostMinorUnits: mintResult.mintCostMinorUnits }
            : {}),
          forwardDated: isForwardDated(args, windowTo),
        });
      }

      if (intent.tool === "transfer_claim") {
        const to = (args as { to?: unknown } | undefined)?.to;
        const movedTokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        const movedQuantity = (args as { quantity?: unknown } | undefined)?.quantity;
        if (typeof to === "string") {
          // Exact: this much of this token left THIS agent's position for the recipient's. A
          // recipient that is not an agent is still a holder — it is recorded by address, so the
          // claim is not lost from view the moment it leaves the roster.
          redemption.recordTransfer(
            agentIdByAddress[to.toLowerCase()] ?? to.toLowerCase(),
            (args as { memo?: unknown } | undefined)?.memo as string | undefined,
            (intent.args as { requestId?: unknown } | undefined)?.requestId as string | undefined,
            typeof movedTokenId === "string" && typeof movedQuantity === "string"
              ? { tokenId: movedTokenId, quantity: movedQuantity, from: agent.agentId }
              : undefined,
          );
        }
        const transferred = record.result as { txHash?: string };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        await recordCapacityEvent("transfer_claim", {
          ...(typeof tokenId === "string" ? { tokenId } : {}),
          ...(typeof quantity === "string" ? { quantityMilliSiu: quantity } : {}),
          ...(typeof to === "string" ? { counterparty: to } : {}),
          ...(settlesRequestId !== undefined ? { settlesRequestId } : {}),
          ...(transferred.txHash ? { txHash: transferred.txHash } : {}),
        });
      }

      // One call, but the same two real events mint_claim + transfer_claim would have produced —
      // so the redemption tracker sees an fSIU payment identically whichever tool made it.
      if (intent.tool === "settle_split") {
        const split = record.result as {
          claimMintCostMinorUnits?: string;
          claimTokenId: string;
          claimIssuer: string;
          claimQuantityMilliSiu: string;
          claimShare: string;
          claimMintTxHash?: string;
        };
        const issuerAgentId = agentIdByAddress[split.claimIssuer.toLowerCase()];
        if (issuerAgentId) {
          redemption.recordMint(split.claimTokenId, issuerAgentId, split.claimQuantityMilliSiu);
        }
        const to = (args as { to?: unknown } | undefined)?.to;
        if (typeof to === "string") {
          redemption.recordTransfer(
            agentIdByAddress[to.toLowerCase()] ?? to.toLowerCase(),
            (args as { memo?: unknown } | undefined)?.memo as string | undefined,
            (intent.args as { requestId?: unknown } | undefined)?.requestId as string | undefined,
            { tokenId: split.claimTokenId, quantity: split.claimQuantityMilliSiu },
          );
        }
        await recordCapacityEvent("settle_split", {
          tokenId: split.claimTokenId,
          issuer: split.claimIssuer,
          quantityMilliSiu: split.claimQuantityMilliSiu,
          claimShare: split.claimShare,
          // The claim leg goes to the quote's seller. Without this the event named a claim and
          // nobody it went to, so a split could not be followed into anyone's holdings.
          ...(typeof to === "string" ? { counterparty: to } : {}),
          ...(split.claimMintCostMinorUnits !== undefined
            ? { mintCostMinorUnits: split.claimMintCostMinorUnits }
            : {}),
          ...(settlesRequestId !== undefined ? { settlesRequestId } : {}),
          ...(split.claimMintTxHash ? { txHash: split.claimMintTxHash } : {}),
        });
      }

      // The held split (D32): two transfers, of which the claim part is exactly what `transfer_claim` would have moved, so
      // it is recorded as that — the tracker and the ledger see a held claim passed on, whichever tool did it.
      if (intent.tool === "settle_split_held") {
        const split = record.result as {
          tokenId: string;
          claimQuantityMilliSiu: string;
          claimShare: string;
          claimTxHash?: string;
        };
        const to = (args as { to?: unknown } | undefined)?.to;
        if (typeof to === "string") {
          redemption.recordTransfer(
            agentIdByAddress[to.toLowerCase()] ?? to.toLowerCase(),
            (args as { memo?: unknown } | undefined)?.memo as string | undefined,
            settlesRequestId,
            { tokenId: split.tokenId, quantity: split.claimQuantityMilliSiu, from: agent.agentId },
          );
        }
        await recordCapacityEvent("transfer_claim", {
          tokenId: split.tokenId,
          quantityMilliSiu: split.claimQuantityMilliSiu,
          claimShare: split.claimShare,
          ...(typeof to === "string" ? { counterparty: to } : {}),
          ...(settlesRequestId !== undefined ? { settlesRequestId } : {}),
          ...(split.claimTxHash ? { txHash: split.claimTxHash } : {}),
        });
      }

      if (intent.tool === "pay_with_claim") {
        const paid = record.result as {
          mintCostMinorUnits?: string;
          tokenId: string;
          issuer: string;
          quantity: string;
          mintTxHash?: string;
          transferTxHash?: string;
        };
        const issuerAgentId = agentIdByAddress[paid.issuer.toLowerCase()];
        if (issuerAgentId) redemption.recordMint(paid.tokenId, issuerAgentId, paid.quantity);
        const to = (args as { to?: unknown } | undefined)?.to;
        if (typeof to === "string") {
          redemption.recordTransfer(
            agentIdByAddress[to.toLowerCase()] ?? to.toLowerCase(),
            (args as { memo?: unknown } | undefined)?.memo as string | undefined,
            (intent.args as { requestId?: unknown } | undefined)?.requestId as string | undefined,
            { tokenId: paid.tokenId, quantity: paid.quantity },
          );
        }
        // One tool call, two real transactions — both hashes kept, since a run record must never
        // show a payment that half-occurred as if it had completed.
        await recordCapacityEvent("pay_with_claim", {
          tokenId: paid.tokenId,
          issuer: paid.issuer,
          quantityMilliSiu: paid.quantity,
          forwardDated: isForwardDated(args, windowTo),
          ...(typeof to === "string" ? { counterparty: to } : {}),
          ...(paid.mintCostMinorUnits !== undefined ? { mintCostMinorUnits: paid.mintCostMinorUnits } : {}),
          ...(settlesRequestId !== undefined ? { settlesRequestId } : {}),
          ...(paid.mintTxHash
            ? { txHash: `${paid.mintTxHash} (mint) / ${paid.transferTxHash ?? "?"} (transfer)` }
            : {}),
        });
      }

      if (intent.tool === "reserve_for_work") {
        const reserved = record.result as {
          txHash: string;
          quoteHash: string;
          issuer: string;
          quantity: string;
          deadline: string;
        };
        await recordCapacityEvent("reserve_for_work", {
          quoteHash: reserved.quoteHash,
          issuer: reserved.issuer,
          quantityMilliSiu: reserved.quantity,
          txHash: reserved.txHash,
        });
      }

      if (intent.tool === "settle_escrow") {
        const settled = record.result as {
          txHash: string;
          releaseTxHash?: string;
          settledMinorUnits?: string;
        };
        if (settled.releaseTxHash) {
          await recordCapacityEvent("release_on_settle", { txHash: settled.releaseTxHash });
        }
        // The obligation is discharged, so the board stops telling this seller it owes the work —
        // matching the same quote `buildToolArgs` actually settled.
        const settledQuote = (args as { quote?: { seller_id?: string } } | undefined)?.quote;
        if (settledQuote !== undefined) {
          const mine = board.issuedQuotesBySeller(agent.erc8004Id);
          const match = mine.find((i) => i.quote === settledQuote) ?? mine.at(-1);
          if (match) {
            board.recordSettled(match.requestId);
            settledRequestIdForLab = match.requestId;
            // What was actually SETTLED, which can be less than the quote's ceiling: a seller may
            // claim less and the rest returns to the payer. A cost built from the ceiling would
            // overstate the dollar route.
            if (settled.settledMinorUnits !== undefined) {
              usdcSettlements.push({
                sellerAgentId: agent.agentId,
                turn,
                requestId: match.requestId,
                settledMinorUnits: settled.settledMinorUnits,
                quotedMinorUnits: match.quote.settlement[0].amount_max,
              });
            }
          }
        }
      }

      if (intent.tool === "serve_redemption") {
        const served = record.result as { txHash?: string };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        const passed = (args as { passed?: unknown } | undefined)?.passed;
        const holderAddress = (args as { holder?: unknown } | undefined)?.holder;
        if (passed === true) {
          await recordCapacityEvent("serve_redemption", {
            ...(typeof tokenId === "string" ? { tokenId } : {}),
            ...(typeof quantity === "string" ? { quantityMilliSiu: quantity } : {}),
            // Whose claim was burned. Without it a redemption could not be followed into anyone's
            // holdings, so "did this agent redeem what it received" had no answer.
            ...(typeof holderAddress === "string" ? { counterparty: holderAddress } : {}),
            ...(served.txHash ? { txHash: served.txHash } : {}),
          });
        }
      }

      if (intent.tool === "settle_window_close") {
        const settled = record.result as {
          txHash?: string;
          outcome?: "Defaulted" | "Expired";
          bondPaidMinorUnits?: string;
        };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        const settledHolder = (args as { holder?: unknown } | undefined)?.holder;
        await recordCapacityEvent("settle_window_close", {
          ...(typeof tokenId === "string" ? { tokenId } : {}),
          // Whose position this closed: a settlement closes one holder's, never the whole token's.
          ...(typeof settledHolder === "string" ? { counterparty: settledHolder } : {}),
          ...(settled.txHash ? { txHash: settled.txHash } : {}),
          ...(settled.outcome !== undefined ? { settlementOutcome: settled.outcome } : {}),
          ...(settled.bondPaidMinorUnits !== undefined
            ? { bondPaidMinorUnits: settled.bondPaidMinorUnits }
            : {}),
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
        // The spec travels with the redemption — see RedemptionState.taskSpecText. The holder is
        // presenting the job it holds a claim against, so the spec comes from the job itself,
        // exactly as `buildToolArgs` already sources every other job-owned field.
        const presented = record.result as { txHash?: string; timeToExpirySeconds?: number };
        const tokenId = (args as { tokenId?: unknown } | undefined)?.tokenId;
        redemption.recordPresented(
          agent.agentId,
          options.taskSpecText,
          // Only when `redeem_claim` genuinely returned an expiry. Without it the holder simply
          // gets no timed warning, which is better than one anchored to an invented instant.
          typeof presented.timeToExpirySeconds === "number"
            ? {
                atChainSeconds: chainNowSeconds,
                secondsToExpiry: presented.timeToExpirySeconds,
              }
            : undefined,
          typeof tokenId === "string" ? tokenId : undefined,
        );
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
        // The issuer's own reported verdict, read from the args it actually sent rather than
        // from the grading result the loop observed — they can differ, and which one the HOLDER
        // is told about is the one that was reported on chain.
        const servedArgs = args as
          | { tokenId?: unknown; holder?: unknown; quantity?: unknown; passed?: unknown }
          | undefined;
        redemption.recordServed(servedArgs?.passed !== false, {
          ...(typeof servedArgs?.tokenId === "string" ? { tokenId: servedArgs.tokenId } : {}),
          ...(typeof servedArgs?.holder === "string"
            ? { holder: agentIdByAddress[servedArgs.holder.toLowerCase()] ?? servedArgs.holder.toLowerCase() }
            : {}),
          ...(typeof servedArgs?.quantity === "string" ? { quantity: servedArgs.quantity } : {}),
        });
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
          countsAsApparatusAttack: attackOutcome.countsAsApparatusAttack,
          oracleErrorCause: attackOutcome.oracle.cause,
          gateAccepted: attackOutcome.gate.accept,
          oracleAccepted: attackOutcome.oracle.accept,
          gateReason: attackOutcome.gate.reason ?? attackOutcome.gate.error,
          oracleReason: attackOutcome.oracle.reason ?? attackOutcome.oracle.error,
          oracleTrialsRun: attackOutcome.oracle.trialsRun,
          submissionSource: (args as { submissionSource: string }).submissionSource,
        });
        // Only a false accept is a defeat worth reporting. A correct_reject is the gate working,
        // and telling an author its gate held would cost it a turn to learn nothing.
        // `attackOutcome` is a `let`, so its narrowing does not survive into the closure below.
        const outcome = attackOutcome;
        if (outcome.countsAsAdversaryYield) {
          const author = attackContext.gateVersions.find(
            (g) => g.version === outcome.gateVersion,
          )?.submittedBy;
          // A pinned gate has no author to tell, and nobody could act on the telling: the
          // defeat is still recorded as an attack and still counts as adversary yield, it just
          // notifies no one. Telling an agent to widen tests it did not write would be an
          // instruction it cannot follow — the §4.6s shape.
          if (author !== undefined && author !== PRE_AUTHORED) {
            gateDefeats.push({
              attackIndex: attacks.length - 1,
              gateVersion: outcome.gateVersion,
              author,
              shape: outcome.firstMismatchShape,
            });
          }
        }
      }

      const gateResult =
        intent.tool === "submit_job" && !quarantined
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
      if (gateResult && redemption.isIssuerOfAny(agent.agentId)) {
        redemption.recordGraded(
          gateResult.passed,
          keccak256(stringToBytes(`receipt:${options.job.jobId}`)),
          agent.agentId,
        );
      }

      // The currency lab learns what the call did. Operator-side, so a failure here is the harness's and
      // never the agent's: it is recorded and the run goes on, not shown to the agent as its error.
      if (options.lab !== undefined) {
        try {
          await options.lab.afterToolCall({
            agentId: agent.agentId,
            turn,
            tool: intent.tool,
            intentArgs: intent.args,
            builtArgs: args,
            result: record.result,
            ...(postedRequestId !== undefined ? { requestId: postedRequestId } : {}),
            ...(settledRequestIdForLab !== undefined ? { settledRequestId: settledRequestIdForLab } : {}),
          });
        } catch (labErr) {
          labErrors.push({
            agentId: agent.agentId,
            turn,
            tool: intent.tool,
            message: labErr instanceof Error ? labErr.message : String(labErr),
          });
        }
      }

      const log: TurnLog = {
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        marketBoardText: marketBoardText || undefined,
        rawText: adapterResult.text,
        promptText: prompt,
        settleableText: settleableText || undefined,
        forwardText: forwardText || undefined,
        latencyMs: adapterResult.latency_ms,
        parsed: JSON.stringify(intent),
        toolCall: { name: intent.tool, ok: true },
        quarantinedNonDeterministicGate: quarantined || undefined,
        stopReason: adapterResult.stopReason,
        usage: adapterResult.usage,
        contentBlockTypes: adapterResult.contentBlockTypes,
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
      pushLog(log);
      options.onTurn?.(agent.agentId, log);

      const timeToExpiry = await holdTimeToExpiry(options.deps, null);
      await friction.append(
        buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, timeToExpiry, {
          ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        }),
      );

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
        const claimOutstanding = redemption.anyUnserved();
        // A carried-forward default keeps the window open too. A claim cannot be settled inside
        // its own window — `settleWindowClose` reverts `WindowNotClosedYet` — so the only turns
        // anyone ever gets to settle window N's default are in window N+1. Breaking the moment a
        // gate passes would take those turns away and make the holder's failure to act
        // indistinguishable from never having been given the chance, which is precisely the
        // finding this run is trying to produce.
        const settledThisWindow = new Set(
          capacityEvents.filter((e) => e.kind === "settle_window_close").map((e) => e.tokenId),
        );
        const carriedStillUnsettled = (options.outstandingClaims ?? []).some(
          (c) => !settledThisWindow.has(c.tokenId),
        );
        // An untested gate keeps the window open too, for exactly the reason the carried-forward
        // default does. A gate nobody has tried to defeat is the whole point of the adversary
        // arm, and it can only be attacked AFTER it exists — so breaking the instant it passes
        // takes away the only turns in which an attack was ever possible, and makes "the
        // adversary did not attack" indistinguishable from "it was never given the chance".
        //
        // Found by the test written for the visibility fix, 2026-09-29, not by a run: run 8 paid
        // in fSIU every time, so `claimOutstanding` happened to hold every window open and this
        // never bit. On the dollar route there is no claim, and a passing gate would have ended
        // the window instantly with the adversary never having had a turn — so the attack arm
        // was unreachable on that route no matter what any prompt said.
        const someoneCanAttack = [...activeAgents].some((id) =>
          options.roster.find((r) => r.agentId === id)?.availableTools.includes("submit_attack"),
        );
        // `canAttackNow` and not merely "some version is unattacked": with the cap reached, a
        // newest version nobody may test is unattacked forever, so the old form held the window
        // open for work that could never happen — the same cap blindness as the wake gate.
        const untestedGate = someoneCanAttack && canAttackNow();
        // Testing for sale and not yet bought holds the window open too, for the same reason an
        // untested gate does: the buyer can only buy AFTER a gate exists, so breaking the instant
        // one passes would end the window before the one agent able to buy had a turn, and
        // "declined" would be indistinguishable from "never asked" (§4.6y, on the buyer's side).
        // It ends when the buyer buys, declares it is done, or the stall guard finds nobody left
        // who can act — all of which are recorded, none of which is silent.
        const testingStillForSale =
          testingPurchaseRequired && someoneCanAttack && !testingIsEngaged();
        if (!claimOutstanding && !carriedStillUnsettled && !untestedGate && !testingStillForSale) {
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
          turn,
          promptChars: prompt.length,
          projectedUsd,
          realizedUsd,
          marketBoardText: marketBoardText || undefined,
          rawText: adapterResult.text,
          promptText: prompt,
          settleableText: settleableText || undefined,
          forwardText: forwardText || undefined,
          latencyMs: adapterResult.latency_ms,
          stopReason: adapterResult.stopReason,
          usage: adapterResult.usage,
          contentBlockTypes: adapterResult.contentBlockTypes,
          parsed: `${JSON.stringify(intent)} -> tool args validation error: ${err.message}`,
        };
        pushLog(log);
        options.onTurn?.(agent.agentId, log);
        await friction.append(
          buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null, {
          ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        }),
        );
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
        // An agent that has now been refused the same tool twice is not going to succeed at it on
        // the third attempt: the grant is static for the window. Found live, run 8 (2026-09-29):
        // ISSUER-A, whose serve_redemption is withheld by construction, authored a passing gate in
        // every window and then spent five to eight turns per window trying to report it —
        // burning to its cost ceiling in all three, roughly a third of the run's inference, on an
        // agent that could not succeed. Its own friction named the cause correctly every single
        // time, which is what makes the retries waste rather than exploration.
        //
        // Counted, not prevented: the call is still made and still refused and still recorded, so
        // "it kept trying" stays visible in the record. What changes is that after the second
        // refusal this agent stops being WOKEN for that tool's own prompt (see refusedTwice
        // below), so the budget goes to agents that can act.
        const refusalKey = `${agent.agentId}:${intent.tool}`;
        refusedToolCalls.set(refusalKey, (refusedToolCalls.get(refusalKey) ?? 0) + 1);
        const log: TurnLog = {
          turn,
          promptChars: prompt.length,
          projectedUsd,
          realizedUsd,
          marketBoardText: marketBoardText || undefined,
          rawText: adapterResult.text,
          promptText: prompt,
          settleableText: settleableText || undefined,
          forwardText: forwardText || undefined,
          latencyMs: adapterResult.latency_ms,
          stopReason: adapterResult.stopReason,
          usage: adapterResult.usage,
          contentBlockTypes: adapterResult.contentBlockTypes,
          // A chain revert is said in a sentence; the call dump and the selector never reach the agent.
          parsed: `${JSON.stringify(intent)} -> tool call error: ${explainToolError(err)}`,
          toolCall: { name: intent.tool, ok: false },
        };
        recordFailedCall(agent.agentId, turn, intent.tool, intent.args, explainToolError(err));
        pushLog(log);
        options.onTurn?.(agent.agentId, log);
        await friction.append(
          buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null, {
          ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        }),
        );
        continue;
      }
    }
  }

  const completion = windowCompletion({
    required: testingPurchaseRequired,
    gateDelivered: passed,
    engaged: testingIsEngaged(),
    attacked: attacks.length > 0,
  });
  // A run the harness failed has no verdict about its agents. Whatever the completion rule would
  // say — `no_gate`, `testing_never_purchased` — it would be blaming a decision for a missing one.
  const verdict =
    infrastructureFailure !== undefined ? { passed: false } : completion;
  const result: FullRunWindowResult = {
    passed: verdict.passed,
    gateDelivered: passed,
    claimPositions: redemption.positions(),
    labErrors,
    paymentMoments,
    usdcSettlements,
    claimFlows: Object.fromEntries(
      options.roster.map((a) => [a.agentId, claimLedger.flows(a.agentId)]),
    ),
    testingEngaged: testingIsEngaged(),
    ...("incompleteBecause" in verdict && verdict.incompleteBecause !== undefined
      ? { incompleteBecause: verdict.incompleteBecause }
      : {}),
    ...(infrastructureFailure !== undefined ? { infrastructureFailure } : {}),
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
    toolOrderByAgent,
  };
  for (const [agentId, logs] of Object.entries(turnLogsByAgent)) {
    for (const log of logs) Object.assign(log, turnExtras.get(`${agentId}#${log.turn}`));
  }
  recorder.finalizeMetrics(result);
  return result;
}

function buildFrictionEntry(
  agentId: AgentId,
  turn: number,
  jobId: string,
  report: FrictionReport | undefined,
  timeToExpirySeconds: number | null,
  overrides?: { attempted?: string; outcome?: string; rationale?: string },
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
    // Spread rather than always set, so "no rationale" stays absent from the JSON rather than
    // becoming `null` — the same encoding friction's own optional fields use.
    ...(overrides?.rationale !== undefined ? { rationale: overrides.rationale } : {}),
  };
}

/**
 * Every name a call's own arguments may use for an address: the seats, and any alias the run gives them.
 * An alias is not an `AgentId` — the lab's trader labels are shown to agents and never exist as seats —
 * which is why the key type is widened here, in one place, rather than at each lookup.
 */
export function addressDirectory(
  roster: readonly { agentId: AgentId; address: string }[],
  aliases: Readonly<Record<string, AgentId>> = {},
): Partial<Record<AgentId, string>> {
  const bySeat = new Map(roster.map((a) => [a.agentId, a.address]));
  const entries: Array<[string, string]> = roster.map((a) => [a.agentId, a.address]);
  for (const [alias, seat] of Object.entries(aliases)) {
    const address = bySeat.get(seat);
    if (address !== undefined) entries.push([alias, address]);
  }
  return Object.fromEntries(entries) as Partial<Record<AgentId, string>>;
}

export interface BuildToolArgsContext {
  job: JobEnvelope;
  board: QuoteBoard;
  /** Currency lab only: vets a call's own arguments (price, size, which need) and returns a true
   *  sentence to refuse it with, or null. See `LabHooks.guard`. */
  labGuard?: (tool: ToolName, rawArgs: unknown) => string | null | Promise<string | null>;
  agentAddressByAgentId: Partial<Record<AgentId, string>>;
  deployment: RunnerDeps["deployment"];
  windowFrom: bigint;
  windowTo: bigint;
  /** Who is taking this turn. Needed to resolve "my own escrows" and "the quote I signed" from
   * the board without the model naming them — the same splice discipline `pay` already uses for
   * the quote object itself. */
  caller?: { agentId: AgentId; erc8004Id: string };
  mintContext?: MintContext;
  /** Payments settle by direct transfer (`RunnerDeps.directSettlement`): no escrow exists to look up. */
  directSettlement?: boolean;
  /** Currency lab only: the print a quote was asked for at, when it is not the mint context's (`LabHooks.printForQuote`). */
  printForQuote?: (requestId: string) => bigint | undefined;
  /** Currency lab only: the claim that pays a quote in full when the quote is priced in SIU (`LabHooks.claimForQuote`). */
  claimForQuote?: (requestId: string) => bigint | undefined;
  /** See `FullRunWindowOptions.requiredQuoteSiu`. */
  requiredQuoteSiu?: Readonly<Record<string, string>>;
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
  /** See `FullRunWindowOptions.outstandingClaims`. */
  outstandingClaims?: readonly OutstandingClaim[];
  /**
   * What an issuer owes, assembled by the loop because only the loop holds all of it: this
   * window's mints (from `capacityEvents`), the live redemption tracker, and claims carried
   * unsettled from earlier windows. Spliced into `list_obligations`, which the agent calls with
   * no arguments of its own — see tools/list-obligations.ts and spec §4.6x/§4.6y.
   */
  obligationsFor?: (agentId: AgentId) => IssuerObligation[];
  /** The holder's mirror of `obligationsFor` — see tools/check-delivery.ts and spec §4.6w. */
  deliveryFor?: (agentId: AgentId) => DeliveryStatus[];
}

/**
 * Tools that can settle a quote, so the board stops advertising it to the buyer and starts
 * telling the seller it owes work.
 *
 * Until 2026-09-30 this was `pay` alone, and the consequence was invisible because the fSIU
 * route never involved a quote: the orchestrator's Option B is a bare `pay_with_claim` while
 * Option A is the full request/issue/pay/settle cycle. §4.6f logs that difference as a turn-count
 * asymmetry; an fSIU payment being unable to settle a quote at all is the same difference wearing
 * another face. A payment the seller does not recognise leaves the buyer out of pocket and the
 * job undone — the failure that cost run 4's window 1.
 *
 * `transfer_claim` belongs here and is the one that matters. `pay_with_claim` MINTS a fresh claim
 * — new issuance, new headroom consumed — which is not circulation. Paying with a claim you
 * ALREADY HOLD is the different act: the payer gives up an existing asset rather than creating
 * one. That is what fSIU circulating means, no run has ever shown it, and without a quote link
 * it was not expressible.
 */
/**
 * What a settlement tool settles IN, which decides what the seller is told (see
 * `QuoteBoard.recordPaid`). `transfer_claim` pays a quote with a claim already held, so it is a
 * claim payment like `pay_with_claim`; `settle_split` opens a real escrow for its dollar leg.
 */
export function assetSettledBy(tool: ToolName): PaidAsset {
  if (tool === "pay_with_claim" || tool === "transfer_claim") return "fsiu";
  if (tool === "settle_split" || tool === "settle_split_held") return "split";
  return "usdc";
}

export function settlesQuote(tool: ToolName): boolean {
  return (
    tool === "pay" ||
    tool === "pay_with_claim" ||
    tool === "settle_split" ||
    tool === "settle_split_held" ||
    tool === "transfer_claim"
  );
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

/** A gate the run did not buy: pinned, graded for real, injected at window start under
 *  `--debug`. A distinct value rather than an agent id, so every reader that prints an author
 *  has to confront the fact that no agent wrote this one. */
export const PRE_AUTHORED = "PRE-AUTHORED" as const;

export interface DeliveredGate {
  version: number;
  source: string;
  submittedBy: AgentId | typeof PRE_AUTHORED;
  turn: number;
}

export interface AttackContext {
  gateVersions: DeliveredGate[];
  attackedVersions: Set<number>;
  oracleSeed: number;
}

/**
 * Whether a mint's own spliced `windowTo` lies beyond the window it was minted in — the only
 * thing that makes a claim forward cover rather than payment for the job in front of the buyer.
 * Read from the real args `buildToolArgs` resolved (`resolveTargetWindow`), never from what a
 * model said it intended.
 */
function isForwardDated(args: unknown, currentWindowTo: bigint): boolean {
  const windowTo = (args as { windowTo?: unknown } | undefined)?.windowTo;
  return typeof windowTo === "number" && BigInt(windowTo) > currentWindowTo;
}

/** Re-exported from `tools/class-id.ts`, which is now the single definition — the same module
 * the tool boundary itself hashes with, so a class id the loop splices and one an agent names by
 * plain string can never resolve differently. */
export { classIdFor };

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
/**
 * Structural enforcement of the one rule a brief alone could not hold: a holder does not owe its
 * claim's delivery — the routed issuer does, and redemption grades that issuer's own work
 * (WorkClaim.sol's own top doc comment). WORKER-CODE's brief said exactly this, in capitals, and
 * it authored the gate anyway in all three windows of the 2026-09-28 run, after the same thing had
 * already happened on 2026-09-26. Every one of those windows then reported `passed: true` off work
 * nobody had bought, which is how a scarcity result came to be printed as the instrument
 * succeeding.
 *
 * Keyed on holding, never on identity. Two exemptions matter and both are deliberate:
 *   - An agent holding no claim for this job may author freely — that is the USDC route, where the
 *     seller genuinely was paid for its own labour.
 *   - **The routed issuer may always author, even if it somehow also holds the claim.** It is the
 *     party being graded, so refusing it would leave nobody able to deliver at all. That exemption
 *     became load-bearing on 2026-09-29, when the issuer finally started receiving the task spec
 *     with the redemption and could author for the first time.
 *
 * Extracted from the loop's own `toolGuard` closure so the rule is testable directly rather than
 * only through a full window.
 */
export function submitJobRefusalFor(
  toolName: ToolName,
  agentId: AgentId,
  state: Readonly<RedemptionState>,
): string | null {
  if (toolName !== "submit_job") return null;
  if (state.served) return null;
  const holdsIt = state.transferredTo === agentId || state.holder === agentId;
  if (!holdsIt) return null;
  if (state.issuerAgentId === agentId) return null;
  return (
    `you hold a work claim (tokenId ${state.tokenId ?? "unknown"}) for this job, so its ` +
    `routed issuer ${state.issuerAgentId ?? "(unknown)"} owes the delivery, not you. ` +
    "Redemption grades that issuer's own work; authoring it yourself would be doing the " +
    "issuer's job with no way for anyone to attribute it correctly. Present the claim " +
    "and wait, or transfer it on."
  );
}

export async function buildToolArgs(
  tool: ToolName,
  rawArgs: unknown,
  ctx: BuildToolArgsContext,
): Promise<unknown> {
  const labRefusal = (await ctx.labGuard?.(tool, rawArgs)) ?? null;
  if (labRefusal !== null) throw new Error(labRefusal);
  if (tool === "submit_job") {
    const rawSource = (rawArgs as { source?: unknown } | undefined)?.source;
    // Found live, 2026-09-29 (P5 run 3): this used to substitute `""` for a missing/non-string
    // `source`, so a caller that supplied the wrong fields entirely got an empty gate module and
    // a G1 "gate spec does not export a gate() function" six checks later — a confusing, remote
    // symptom of a boundary problem. Both issuers hit exactly that, having filled in the seven
    // parameters the tool description used to advertise (none of which is read here) and left
    // `source` unset. Failing here, naming what actually arrived, is the whole point: the caller
    // sees it in its own tool-call history on the very next turn.
    if (typeof rawSource !== "string" || rawSource.trim() === "") {
      const received = rawArgs !== null && typeof rawArgs === "object" ? Object.keys(rawArgs) : [];
      throw new Error(
        `submit_job expects a single argument "source": a JavaScript ES module (as a string) ` +
          `exporting gate({ referenceDir, submissionDir }) and returning { accept, reason }. ` +
          (received.length > 0
            ? `Received keys: ${received.join(", ")} — none of these is read; the original gate, ` +
              `reference instance, submissions and held-out instances are supplied for you.`
            : `Received no arguments.`),
      );
    }
    return {
      taskClass: ctx.job.taskClass,
      originalGate: ctx.job.originalGate,
      hardenedGate: {
        taskClass: ctx.job.taskClass,
        source: rawSource,
      },
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
      throw new Error(
        `${tool}: "forWindow" must be a whole window number, got ${JSON.stringify(raw.forWindow)}.`,
      );
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
      throw new Error(
        "mint_claim: this window has no mintContext — no agent should have this tool.",
      );
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
    // With direct settlement there is no escrow to read, and reading one for every quote the agent is party to would put
    // "escrows" of status None into its history for payments that never opened one.
    const escrowQuoteHashes = ctx.directSettlement === true ? [] : [...new Set(mine.map((i) => quoteHashHex(i.quote)))];
    return {
      account:
        typeof raw.account === "string"
          ? raw.account
          : ((ctx.caller && ctx.agentAddressByAgentId[ctx.caller.agentId]) ?? ""),
      tokenIds: Array.isArray(raw.tokenIds) ? raw.tokenIds.map((t) => asDecimalString(t)) : [],
      // Left out entirely with direct settlement, so the call an agent's history shows names no escrow.
      ...(ctx.directSettlement === true ? {} : { escrowQuoteHashes }),
    };
  }

  if (tool === "settle_escrow") {
    const erc8004Id = ctx.caller?.erc8004Id;
    if (!erc8004Id) {
      throw new Error("settle_escrow: no caller identity on this turn.");
    }
    // The seller's own signed quote — never reconstructed by the model, for the same reason
    // `pay` takes the real object: a hand-copied quote hashes to a different, and nonexistent,
    // escrow.
    //
    // The PAID-and-unsettled one, not simply the newest. While a seller could only ever hold one
    // quote per window "newest" happened to coincide with "the one with an escrow"; once a buyer
    // makes two independent purchases in a window (gate authoring and attack testing) it does
    // not, and settling the newest would reach for an escrow that does not exist while the real
    // one stayed open. Falls back to the newest only when nothing is recorded as paid, so an
    // unpaid caller still gets the honest "no escrow to settle" error below.
    const paidUnsettled = ctx.board.paidUnsettledFor(erc8004Id);
    const mine = ctx.board.issuedQuotesBySeller(erc8004Id);
    // A seller with several paid quotes at once (the currency lab: every trader both sells and buys)
    // names which to settle with `requestId`; without it the first paid one is settled, as before.
    const wanted = (rawArgs as { requestId?: unknown } | undefined)?.requestId;
    if (typeof wanted === "string" && !paidUnsettled.some((i) => i.requestId === wanted)) {
      throw new Error(
        `settle_escrow: ${wanted} is not one of your paid, unsettled quotes` +
          (paidUnsettled.length > 0 ? ` (they are: ${paidUnsettled.map((i) => i.requestId).join(", ")}).` : "."),
      );
    }
    const latest =
      (typeof wanted === "string" ? paidUnsettled.find((i) => i.requestId === wanted) : undefined) ??
      paidUnsettled.at(0) ??
      mine.at(-1);
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

  if (tool === "settle_window_close") {
    if (!ctx.mintContext) {
      throw new Error(
        "settle_window_close: this window has no mintContext, so no attestation can be signed.",
      );
    }
    const raw = (rawArgs ?? {}) as { tokenId?: unknown; holder?: unknown };
    const outstanding = ctx.outstandingClaims ?? [];
    // A model names which claim by its tokenId, exactly as it appears in the outstanding list it
    // was shown; everything else — the holder whose balance pays out, and the whole rate
    // attestation — is resolved or signed here. A model cannot produce a real publisher
    // signature, which is precisely why this tool was unreachable before.
    const named = typeof raw.tokenId === "string" ? raw.tokenId : undefined;
    // A token can have several holders outstanding — a claim passed on in part — and a settlement
    // closes one holder's position. The holder is named by agent id or by address; it is only
    // required where the token id alone would not say which.
    const namedHolder = typeof raw.holder === "string" ? raw.holder : undefined;
    const sameToken = named ? outstanding.filter((c) => c.tokenId === named) : [];
    const isHolder = (c: OutstandingClaim, who: string): boolean =>
      c.holderAgentId === who || c.holder.toLowerCase() === who.toLowerCase();
    if (named && namedHolder !== undefined && sameToken.length > 0 && !sameToken.some((c) => isHolder(c, namedHolder))) {
      throw new Error(
        `settle_window_close: no outstanding position of token ${named} is held by "${namedHolder}" — held by: ` +
          `${sameToken.map((c) => c.holderAgentId ?? c.holder).join(", ")}.`,
      );
    }
    if (named && namedHolder === undefined && sameToken.length > 1) {
      throw new Error(
        `settle_window_close: token ${named} has more than one holder outstanding — name which with ` +
          `{"tokenId": "${named}", "holder": "<agent or address>"}: ` +
          `${sameToken.map((c) => c.holderAgentId ?? c.holder).join(", ")}.`,
      );
    }
    const claim = named
      ? namedHolder !== undefined
        ? sameToken.find((c) => isHolder(c, namedHolder))
        : sameToken[0]
      : outstanding.length === 1
        ? outstanding[0]
        : undefined;
    if (!claim) {
      throw new Error(
        outstanding.length === 0
          ? "settle_window_close: no claim from an earlier window is outstanding — there is nothing to settle."
          : `settle_window_close: name which claim to settle with {"tokenId": "..."} — outstanding: ${outstanding.map((c) => c.tokenId).join(", ")}.`,
      );
    }

    const validUntil = BigInt(Math.floor(Date.now() / 1000)) + ctx.mintContext.validitySeconds;
    // The print's own real date, never bent to match the claim. If the print this run prices
    // against is not dated the day the claim's window closed, the contract refuses the Default
    // with `StalePrintDate` and that refusal is correct — attesting a date a print does not have
    // to make a settlement go through would be falsifying the thing being settled against.
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
    return {
      tokenId: claim.tokenId,
      holder: claim.holder,
      printId: ctx.mintContext.printId,
      series: ctx.mintContext.series,
      printDate: ctx.mintContext.printDate.toString(),
      nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu.toString(),
      validUntil: validUntil.toString(),
      signature,
    };
  }

  if (tool === "whoami") {
    const address = ctx.caller ? ctx.agentAddressByAgentId[ctx.caller.agentId] : undefined;
    if (!address) {
      throw new Error("whoami: no caller identity on this turn.");
    }
    // The whole point of the tool is that an agent should not have to know, guess, or derive
    // this — so it is spliced from the roster, never read from what the model supplied.
    return { address };
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
    const raw = (rawArgs ?? {}) as {
      forWindow?: unknown;
      rateUsdPerSiu?: unknown;
      maxQuantityMilliSiu?: unknown;
    };
    const forWindow =
      typeof raw.forWindow === "number" ? raw.forWindow : Number(asDecimalString(raw.forWindow));
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

  if (tool === "check_delivery") {
    const caller = ctx.caller?.agentId;
    return {
      claims: caller !== undefined ? (ctx.deliveryFor?.(caller) ?? []) : [],
      ...(ctx.windowIndex !== undefined ? { windowLabel: `window ${ctx.windowIndex}` } : {}),
    };
  }

  if (tool === "list_obligations") {
    const caller = ctx.caller?.agentId;
    // No caller means no "own" obligations to speak of. Returning an empty list rather than
    // throwing: an issuer asking what it owes and being told "nothing" is a correct answer, and
    // a tool that can only succeed is one an agent can rely on.
    return {
      obligations: caller !== undefined ? (ctx.obligationsFor?.(caller) ?? []) : [],
      ...(ctx.windowIndex !== undefined ? { windowLabel: `window ${ctx.windowIndex}` } : {}),
    };
  }

  if (tool === "submit_attack") {
    const attackCtx = ctx.attackContext;
    if (!attackCtx) {
      throw new Error(
        "submit_attack: this window has no attack context — no agent should have this tool.",
      );
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
      throw new Error(
        "submit_attack: no gate has been delivered yet — there is nothing to test yet.",
      );
    }
    if (
      !attackCtx.attackedVersions.has(latest.version) &&
      attackCtx.attackedVersions.size >= MAX_ATTACK_ROUNDS
    ) {
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
      throw new Error(
        "pay_with_claim: this window has no mintContext — no agent should have this tool.",
      );
    }
    // Settles a QUOTE, exactly as `pay` and `settle_split` do (spec §6.1: both assets settle
    // against the same quote). It used to take a recipient and a quantity directly, which made
    // fSIU one call and dollars three — request_quote, wait for the seller, then pay — and the
    // buyer's turn count showed it: 1.56 per fSIU window against 2.25 per USDC window across
    // every recorded run. An agent choosing the shorter path is choosing the shorter path
    // (§4.6f). The recipient and the size now come from the seller's own signed quote, so a model
    // can neither redirect a payment nor resize it.
    const raw =
      (rawArgs as { requestId?: unknown; memo?: unknown } | undefined) ?? {};
    if (typeof raw.requestId !== "string") {
      throw new Error(
        'pay_with_claim: expected a string "requestId". It settles a quote the seller issued, ' +
          "like pay and settle_split do, and no longer takes a recipient and a quantity: the " +
          "quote names both. Ask for a quote with request_quote first.",
      );
    }
    const quote = ctx.board.issuedQuoteById(raw.requestId);
    if (!quote) {
      throw new Error(`pay_with_claim: no issued quote found for request "${raw.requestId}".`);
    }
    const to = quote.seller_id.replace(/^erc8004:/, "");
    // Sized from the quote's PRICE at the print in force, not from its SIU count — see parity.ts.
    // The two are the same dollars only when the buyer happened to quote at the print.
    const quantity = claimMilliSiuForQuote(quote, {
      printId: ctx.mintContext.printId,
      nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu,
    }).toString();
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
      // Passed through rather than dropped. This builder constructs an explicit object, so a
      // field the model supplies and the builder does not name simply vanishes — which is how
      // the memo would have been accepted by the schema, reported as sent, and never arrived.
      ...(typeof raw.memo === "string" && raw.memo.trim() !== "" ? { memo: raw.memo.trim() } : {}),
    };
  }

  if (tool === "transfer_claim") {
    const raw = rawArgs as
      | { to?: unknown; agentId?: unknown; tokenId?: unknown; quantity?: unknown; memo?: unknown }
      | undefined;
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
    // A transfer that NAMES a quote settles it. It used to mark the quote paid for any quantity to
    // any recipient — one milli-SIU to nobody counted — so a transfer that names a quote is now
    // held to what a payment is: it goes to the quote's seller, in the amount worth the quote's
    // price at the print (parity.ts). Which claim to spend stays the holder's choice.
    const named = (rawArgs as { requestId?: unknown } | undefined)?.requestId;
    let quantity = asDecimalString(raw?.quantity);
    if (typeof named === "string") {
      const quote = ctx.board.issuedQuoteById(named);
      if (!quote) {
        throw new Error(`transfer_claim: no issued quote found for request "${named}".`);
      }
      if (!ctx.mintContext) {
        throw new Error(
          "transfer_claim: this window has no mintContext, so a claim cannot be sized from a quote.",
        );
      }
      const seller = quote.seller_id.replace(/^erc8004:/, "");
      if (typeof to !== "string" || to.toLowerCase() !== seller.toLowerCase()) {
        throw new Error(
          `transfer_claim: quote ${named} is payable to ${seller}, not ${String(to)}. A transfer ` +
            "that names a quote must go to that quote's seller.",
        );
      }
      // A run whose print moves (the currency lab's, D41) sizes the claim at the print the quote was asked for at, which the quote
      // itself names; every other run sizes it at the print in force, and refuses a quote from another print, as always.
      // A quote priced in SIU (the lab's, D50) is paid in claims by its price in SIU, whatever the print.
      const inSiu = ctx.claimForQuote?.(named);
      const askedAt = ctx.printForQuote?.(named);
      quantity =
        inSiu !== undefined
          ? inSiu.toString()
          : claimMilliSiuForQuote(
              quote,
              askedAt !== undefined
                ? { printId: quote.print_id, nanoUsdPerSiu: askedAt }
                : { printId: ctx.mintContext.printId, nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu },
            ).toString();
    }
    return {
      to,
      tokenId: asDecimalString(raw?.tokenId),
      quantity,
      ...(typeof raw?.memo === "string" && raw.memo.trim() !== ""
        ? { memo: raw.memo.trim() }
        : {}),
    };
  }

  if (tool === "settle_split") {
    // Both halves of a split, built from the two existing builders' own logic: the quote comes
    // from the board by requestId exactly as `pay` resolves it (a model never reconstructs a
    // seller-signed object), and the claim leg's mint arguments are built exactly as
    // `pay_with_claim` builds them. The claim's recipient is the quote's own seller — a split
    // pays one counterparty in two assets, not two counterparties.
    if (!ctx.mintContext) {
      throw new Error(
        "settle_split: this window has no mintContext — no agent should have this tool.",
      );
    }
    const raw = rawArgs as
      | { requestId?: unknown; settler?: unknown; claimQuantityMilliSiu?: unknown }
      | undefined;
    if (typeof raw?.requestId !== "string") {
      throw new Error('settle_split: expected a string "requestId" naming the quote being paid.');
    }
    const quote = ctx.board.issuedQuoteById(raw.requestId);
    if (!quote) {
      throw new Error(`settle_split: no issued quote found for request "${raw.requestId}".`);
    }
    const claimQuantityMilliSiu = asDecimalString(raw.claimQuantityMilliSiu);
    if (typeof claimQuantityMilliSiu !== "string") {
      throw new Error(
        'settle_split: expected a string "claimQuantityMilliSiu" — how much of this quote to ' +
          "settle in claims. The dollar leg is the remainder.",
      );
    }
    const seller = quote.seller_id.replace(/^erc8004:/, "");
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
      quote,
      settler: raw.settler,
      claimQuantityMilliSiu,
      to: seller,
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

  if (tool === "settle_split_held") {
    // Paying a quote partly from a held claim and partly in USDC (D32). The quote is the board's own, as everywhere; the
    // claim goes to its seller; the claim part is valued at the print in force, which only the mint context carries.
    if (!ctx.mintContext) {
      throw new Error("settle_split_held: this window has no mintContext, so a claim cannot be valued at the print.");
    }
    const raw = rawArgs as { requestId?: unknown; claimQuantityMilliSiu?: unknown; tokenId?: unknown; memo?: unknown } | undefined;
    if (typeof raw?.requestId !== "string") {
      throw new Error('settle_split_held: expected a string "requestId" naming the quote being paid.');
    }
    const quote = ctx.board.issuedQuoteById(raw.requestId);
    if (!quote) {
      throw new Error(`settle_split_held: no issued quote found for request "${raw.requestId}".`);
    }
    const claimQuantityMilliSiu = asDecimalString(raw.claimQuantityMilliSiu);
    if (typeof claimQuantityMilliSiu !== "string") {
      throw new Error(
        'settle_split_held: expected a string "claimQuantityMilliSiu" — how much of this quote to pay from a held claim. ' +
          "The rest is paid in USDC.",
      );
    }
    return {
      quote,
      to: quote.seller_id.replace(/^erc8004:/, ""),
      tokenId: asDecimalString(raw.tokenId),
      claimQuantityMilliSiu,
      // Valued at the print the quote was asked for at when the run's print moves (D41), else the print in force.
      nanoUsdPerSiu: (ctx.printForQuote?.(raw.requestId) ?? ctx.mintContext.nanoUsdPerSiu).toString(),
      ...(typeof raw.memo === "string" && raw.memo.trim() !== "" ? { memo: raw.memo.trim() } : {}),
    };
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
      | {
          holder?: unknown;
          agentId?: unknown;
          tokenId?: unknown;
          quantity?: unknown;
          passed?: unknown;
          receiptRef?: unknown;
        }
      | undefined;
    let holder = raw?.holder;
    const symbolicId =
      typeof raw?.agentId === "string"
        ? raw.agentId
        : typeof holder === "string"
          ? holder
          : undefined;
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

  if (tool === "request_quote") {
    // The buyer proposes the rate; the quantity belongs to the job. Refused here, when the buyer
    // asks, so a quote of the wrong size never exists to be signed or paid.
    const asked = rawArgs as { sellerId?: unknown; siu?: unknown } | undefined;
    if (typeof asked?.sellerId === "string") {
      const refusal = quoteSizeRefusalFor(asked.sellerId, String(asked.siu ?? ""), ctx.requiredQuoteSiu);
      if (refusal !== null) throw new Error(refusal);
    }
    return rawArgs;
  }

  if (tool === "issue_quote") {
    // The seller answers a specific open request by id — the actual signed body is the board's
    // own stored QuoteBody from that request, never whatever the model reconstructs by hand, so a
    // seller can't accidentally (or otherwise) sign something other than what was really asked.
    const requestId = (rawArgs as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== "string") {
      throw new Error(
        'issue_quote: expected a string "requestId" naming the request being answered.',
      );
    }
    const request = ctx.board.requestById(requestId);
    if (!request) {
      throw new Error(`issue_quote: no open request "${requestId}" on the board.`);
    }
    return request.body;
  }

  return rawArgs;
}
