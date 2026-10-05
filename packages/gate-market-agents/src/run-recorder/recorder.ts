import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { FrictionLogWriter } from "../friction/log.js";
import type { AgentContext } from "../context/assemble.js";
import type { GateMarketReceipt } from "../receipt/types.js";
import type { ContextValidationError, ValidationFailureKind } from "../pack/validate.js";
import type { AgentId } from "../identity/resolve.js";

/**
 * One model call as it actually happened, persisted by `RunRecorder.recordMessage` before any
 * parsing is attempted. Every field is real and provider-reported — nothing here is derived from
 * what the model appeared to mean. `parseError` is set exactly when the response could not be
 * parsed into a tool call, which is the case this record exists to make diagnosable.
 */
export interface ModelCallRecord {
  prompt: string;
  rawText: string;
  stopReason?: string;
  usage?: { input: number; output: number; cached_input: number; reasoning: number };
  contentBlockTypes?: string[];
  latencyMs: number;
  parseError?: string;
  /** Present only when the turn was retried after an empty completion at the token budget (see
   *  loop/empty-completion.ts): which call of the turn this record is. The first call stays in
   *  `<turn>.json` and the retry in `<turn>.attempt-2.json`, so neither overwrites the other. */
  attempt?: number;
}

/** Spec §14.4: "bench version, pack version, agent configs, seeds." `agentConfigs` is left as
 * `Record<string, unknown>` deliberately — WP-7 defines the real per-agent config shape when it
 * wires the six agents; this package only needs to persist and diff it, never interpret it. */
export interface RunManifest {
  benchVersion: string;
  packVersion: string;
  agentConfigs: Record<string, unknown>;
  /** This run's own label — what distinguishes one F1 run from the next. Not a determinism
   * control: the deciding agents run at temperature 0.7, and of the four providers in this
   * roster only OpenAI honours a seed parameter, which this loop does not pass. */
  seed: string;
  /** The oracle's trial-set seed, pinned across every F1 run so attack yields are comparable
   * between them — recorded here so a reader can confirm two runs were scored the same way
   * rather than having to trust it. See `loop/full-run.ts`'s `F1_ORACLE_TRIAL_SEED`. */
  oracleTrialSeed?: number;
  /** The real, per-agent tool-description order each agent's own prompt actually used this run —
   * see `loop/full-run.ts`'s `shuffledToolOrder`. Optional: only `runFullRunWindow` populates it;
   * older/other loops that build a `RunManifest` directly are unaffected. */
  toolOrderByAgent?: Record<string, readonly string[]>;
  /** Multi-window runs only. How many windows the run has, and how much capacity a simulated
   * external buyer is scheduled to take after each one, keyed by the window it follows. Both are
   * fixed in the runner's own source before the run starts and recorded here so that a reading of
   * the result can confirm the depletion was not tuned to it. */
  windowCount?: number;
  /** Changes to what the instrument IS rather than what a run did, so a run can never be pooled
   *  with one that predates them. Each entry is dated and says what moved. */
  instrumentChanges?: string[];
  /** Which instrument the run measured — a deployment record's id and, where it has one, its
   *  per-window topology. Runs on different instruments are never pooled. */
  /** The escrow fee the dollar route charges the seller and the claim route does not — recorded
   *  either way; see `SellerFeeAsymmetry` in cli/instrument-report.ts. */
  sellerFeeAsymmetry?: {
    usdcRouteEscrowFeeBps: number;
    fsiuRouteFeeBps: number;
    chargedTo: "seller";
    sellersCanSteerAssetOfAQuote: boolean;
    note: string;
  };
  instrument?: {
    id: string;
    description: string;
    deploymentFile: string;
    topology?: Record<string, unknown>;
  };
  /**
   * The run's shape, when it was not the canonical one. Present only on a run that cannot be
   * quoted — a pinned gate, substituted models, or a non-canonical window count — so that the
   * manifest beside the raw turns says so without anyone having to cross-reference the report.
   * `cli/debug-mode.ts` builds it and `assertCountableForF1` reads the same fields.
   */
  debugMode?: {
    enabled: boolean;
    windows: number;
    canonicalWindows: number;
    preAuthoredGate: boolean;
    gateProvenance?: string;
    cheapNonDeciders: boolean;
    cheapModel?: string;
    countsTowardF1: boolean;
    disqualifiedBecause: string | null;
    /**
     * Which providers this run actually called, and which the model substitution removed.
     *
     * Substituting the non-decider seats collapses a four-provider roster onto two. That makes
     * a debug run harder to kill — it cannot be stopped by a provider it never calls — and it
     * also makes model-specific failures invisible: grok truncating mid-JSON at a token
     * ceiling, gemini returning only reasoning tokens. Both have ended real runs here.
     *
     * `validatesTheBlocksRoster` is the field to read before treating a clean run as evidence
     * that the roster is sound. A green debug run proves the loop works, not the roster.
     */
    providersExercised: string[];
    providersNotExercised: string[];
    validatesTheBlocksRoster: boolean;
    /**
     * Whether this run could exercise time-gated behaviour at all.
     *
     * False whenever a saving shortens the span over which agents take turns — a pinned gate
     * means nobody authors, cheaper agents finish sooner — because anything firing on elapsed
     * time may never become eligible before the stall guard ends the window. Independent of
     * the roster collapse, and the second reason a full-cost run is required.
     */
    exercisesTimeGatedBehaviour: boolean;
    /** Every seat followed a fixed script and no model was called (`cli/scripted-policy.ts`). */
    scripted: boolean;
    /** Seconds per window; production is 2400. Anything else is not comparable. */
    windowSeconds: number;
  };
  externalDepletionMilliSiu?: Record<number, number>;
  /** Every window's real, fixed span (Unix seconds), computed from the chain clock before the
   * first turn of the run. Recorded because a claim minted for a later window names that window's
   * bounds, so the bounds are part of what the run means, not an implementation detail. */
  windowBounds?: Record<number, { from: number; to: number }>;
  /** Per window, whether a default could actually be settled at all — `settleWindowClose`'s
   * Defaulted branch requires the attested printDate to equal the claim's own window-close day,
   * so a window closing on a day this run's print is not dated for cannot draw a bond however
   * badly its issuer behaves. Recorded so that a run with no settled defaults can be told apart
   * from a run where settling one was impossible. */
  defaultReachableByWindow?: Record<number, boolean>;
  /** An issuer deliberately given no way to serve, so its claims default and the enforcement path
   * is exercised rather than hoped for. Fixed in source before the run, like the external
   * depletion schedule, so it cannot have been chosen to fit a result. */
  nonServingIssuer?: string | null;
}

/** Spec §12.4: "every validator verdict... including passes." */
export interface ValidatorVerdictRecord {
  agentId: AgentId;
  turn: number;
  passed: boolean;
  failure?: { kind: ValidationFailureKind; matched: string };
}

/**
 * Spec §14.4's `/runs/<run_id>/` layout. `contexts/<agentId>/<turn>.json` persists the exact
 * `AgentContext` `assembleContext` already produces, written BEFORE the model call — the loop
 * already calls `assembleContext` at the right point in time (see `loop/smoke-pass.ts`); this is
 * what makes that persistence real rather than only ever held in memory. `messages/<agentId>/
 * <turn>.json` holds one `ModelCallRecord` per model call (see `recordMessage`) — the free-text
 * agent channel of spec §13.3 remains explicitly out of scope; this is the model-call record, not
 * that. Synchronous fs calls throughout: this writes a handful of small files per turn, not a
 * hot path, and a synchronous constructor can't await anyway.
 */
export class RunRecorder {
  readonly runDir: string;
  readonly friction: FrictionLogWriter;
  #validatorVerdicts: ValidatorVerdictRecord[] = [];

  constructor(runsRoot: string, runId: string, manifest: RunManifest) {
    this.runDir = join(runsRoot, runId);
    mkdirSync(join(this.runDir, "contexts"), { recursive: true });
    mkdirSync(join(this.runDir, "receipts"), { recursive: true });
    mkdirSync(join(this.runDir, "messages"), { recursive: true });
    this.friction = new FrictionLogWriter(runsRoot, runId);
    writeFileSync(join(this.runDir, "manifest.yaml"), stringify(manifest), "utf-8");
  }

  recordContext(agentId: AgentId, turn: number, context: AgentContext): void {
    const dir = join(this.runDir, "contexts", agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${turn}.json`), JSON.stringify(context, null, 2), "utf-8");
  }

  /**
   * One model call, exactly as it happened: the prompt sent, the untruncated text returned, and
   * the provider's own stop reason, usage and content-block types. Written BEFORE the response is
   * parsed, so a turn that fails to parse is recorded just as fully as one that succeeds — which
   * is the whole reason this exists.
   *
   * Added 2026-09-29. `messages/` was created empty by this constructor from the start and
   * documented as "stays that way" (the free-text agent channel of spec §13.3 is genuinely out of
   * scope, and still is — this is not that). But P5 run 3 lost four unparseable turns to having
   * nowhere to look: the console line slices at 200 characters, and the raw text existed only in
   * memory. This is the model-call record, not an agent-to-agent channel; §13.3's "no agent
   * messages" stays true.
   */
  recordMessage(agentId: AgentId, turn: number, message: ModelCallRecord): void {
    const dir = join(this.runDir, "messages", agentId);
    mkdirSync(dir, { recursive: true });
    const file =
      message.attempt === undefined || message.attempt === 1
        ? `${turn}.json`
        : `${turn}.attempt-${message.attempt}.json`;
    writeFileSync(join(dir, file), JSON.stringify(message, null, 2), "utf-8");
  }

  recordReceipt(receipt: GateMarketReceipt): void {
    writeFileSync(
      join(this.runDir, "receipts", `${receipt.receipt_id}.json`),
      JSON.stringify(receipt, null, 2),
      "utf-8",
    );
  }

  /** Pass `null` for a passing turn — spec §12.4's "including passes" is the point of this
   * method existing at all; a validator that only ever gets logged when it fails can't be
   * distinguished from a validator that was never run. */
  recordValidatorVerdict(
    agentId: AgentId,
    turn: number,
    error: ContextValidationError | null,
  ): void {
    const record: ValidatorVerdictRecord = error
      ? { agentId, turn, passed: false, failure: { kind: error.kind, matched: error.matched } }
      : { agentId, turn, passed: true };
    this.#validatorVerdicts.push(record);
    writeFileSync(
      join(this.runDir, "validator.json"),
      JSON.stringify(this.#validatorVerdicts, null, 2),
      "utf-8",
    );
  }

  /** Left as `unknown`, not `Record<string, unknown>` — every caller's own result shape (a
   * concrete interface like `loop/smoke-pass.ts`'s `SmokePassResult`) is what actually gets
   * passed here, and this is purely a JSON-serialize-and-write sink, not a schema. */
  finalizeMetrics(metrics: unknown): void {
    writeFileSync(join(this.runDir, "metrics.json"), JSON.stringify(metrics, null, 2), "utf-8");
  }
}

/** The agent ids that have a `contexts/<agentId>/` subdirectory in this run — reads the
 * directory rather than importing `AGENT_IDS`, since a real run may not exercise every role. */
export function recordedAgentIds(runDir: string): string[] {
  try {
    return readdirSync(join(runDir, "contexts"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
