import { keccak256, stringToBytes, type Hex } from "viem";
import { ZodError } from "zod";
import type { Adapter, AdapterParams } from "@touchstone/harness";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
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
import { RunRecorder, type RunManifest } from "../run-recorder/recorder.js";
import { FrictionLogWriter, type FrictionLogEntry } from "../friction/log.js";
import { QuoteBoard } from "./quote-board.js";
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
}

/** Real, real-key-signed context for a `mint_claim` splice (see `buildToolArgs`) — absent when a
 * window's roster has no agent that can mint (e.g. P4's solo ORCHESTRATOR pass, which never calls
 * `mint_claim` at all). `nanoUsdPerSiu` is the one real rate every mint in this window attests to
 * — the model chooses *whether* and *how much* to mint, never the rate itself, matching how
 * `submit_job`'s envelope is spliced rather than retyped. */
export interface MintContext {
  publisherPrivateKeyHex: Hex;
  printId: string;
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
  onTurn?: (agentId: AgentId, log: TurnLog) => void;
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
}

export interface FullRunWindowResult {
  passed: boolean;
  passedBy?: AgentId;
  totalRealizedUsd: string;
  turnsByAgent: Record<string, number>;
  haltedReason?: Record<string, "ceiling" | "parse_error" | "max_turns" | "validation_failed" | "voluntary_stop" | "experiment_halt">;
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
  const redemption = new RedemptionTracker();
  const agentIdByAddress = Object.fromEntries(
    options.roster.map((a) => [a.address.toLowerCase(), a.agentId]),
  ) as Record<string, AgentId>;

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
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
    const boardSectionText = [marketBoardText, redemptionText, transferText].filter(Boolean).join("\n\n");
    const prompt = buildTurnPrompt(context, toolOrderByAgent[agent.agentId], boardSectionText);
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

    const adapterParams: AdapterParams = { temperature: 0, max_tokens: agent.maxOutputTokens };
    const adapterResult = await agent.adapter(agent.modelString, prompt, adapterParams);
    const realizedUsd = realizedTurnCostUsd(adapterResult.usage.input, adapterResult.usage.output, agent.prices);
    totalRealizedUsd += Number(realizedUsd);

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
        const mintResult = record.result as { tokenId: string; issuer: string };
        const issuerAgentId = agentIdByAddress[mintResult.issuer.toLowerCase()];
        const quantity = (args as { quantity?: unknown } | undefined)?.quantity;
        if (issuerAgentId && typeof quantity === "string") {
          redemption.recordMint(mintResult.tokenId, issuerAgentId, quantity);
        }
      }

      if (intent.tool === "transfer_claim") {
        const to = (args as { to?: unknown } | undefined)?.to;
        if (typeof to === "string") {
          const recipientAgentId = agentIdByAddress[to.toLowerCase()];
          if (recipientAgentId) redemption.recordTransfer(recipientAgentId);
        }
      }

      if (intent.tool === "redeem_claim") {
        redemption.recordPresented(agent.agentId);
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

      const gateResult = intent.tool === "submit_job" && !quarantined
        ? (record.result as GateHardeningResult)
        : undefined;

      // A real, deterministic receiptRef tied to this job — never invented — so the issuer's
      // eventual serve_redemption call references the same job an on-chain observer could
      // independently recompute. Skipped when quarantined: a non-deterministic gate result is not
      // a trustworthy verdict to route toward a real redemption.
      if (gateResult) {
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
      throw err;
    }
  }

  const result: FullRunWindowResult = {
    passed,
    passedBy,
    totalRealizedUsd: totalRealizedUsd.toFixed(6),
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
): FrictionLogEntry {
  const merged = { ...DEFAULT_FRICTION, ...report };
  return {
    agent: agentId,
    turn,
    job_id: jobId,
    attempted: "turn taken",
    outcome: "recorded",
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
  mintContext?: MintContext;
}

/** The real class ids `WorkClaim`/`CapacityBond` already use — `keccak256(bytes(taskClass))`,
 * matching `devnet/deploy.ts`'s own `CLASS_CODE`/`CLASS_EXTRACT` computation exactly (confirmed
 * independently, not re-derived by guesswork) without importing a devnet-only module into a
 * real-chain loop. */
function classIdFor(taskClass: TaskClass): Hex {
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
      { printId: ctx.mintContext.printId, nanoUsdPerSiu: ctx.mintContext.nanoUsdPerSiu, validUntil },
      ctx.deployment.network.chainId,
      ctx.deployment.workClaim.address as Hex,
      ctx.mintContext.publisherPrivateKeyHex,
    );
    return {
      classId: classIdFor(ctx.job.taskClass),
      quantity,
      windowFrom: Number(ctx.windowFrom),
      windowTo: Number(ctx.windowTo),
      printId: ctx.mintContext.printId,
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
