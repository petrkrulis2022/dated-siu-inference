import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { FrictionLogWriter } from "../friction/log.js";
import type { AgentContext } from "../context/assemble.js";
import type { GateMarketReceipt } from "../receipt/types.js";
import type { ContextValidationError, ValidationFailureKind } from "../pack/validate.js";
import type { AgentId } from "../identity/resolve.js";

/** Spec §14.4: "bench version, pack version, agent configs, seeds." `agentConfigs` is left as
 * `Record<string, unknown>` deliberately — WP-7 defines the real per-agent config shape when it
 * wires the six agents; this package only needs to persist and diff it, never interpret it. */
export interface RunManifest {
  benchVersion: string;
  packVersion: string;
  agentConfigs: Record<string, unknown>;
  seed: string;
  /** The real, per-agent tool-description order each agent's own prompt actually used this run —
   * see `loop/full-run.ts`'s `shuffledToolOrder`. Optional: only `runFullRunWindow` populates it;
   * older/other loops that build a `RunManifest` directly are unaffected. */
  toolOrderByAgent?: Record<string, readonly string[]>;
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
 * what makes that persistence real rather than only ever held in memory. `messages/` is created
 * empty and stays that way — the free-text agent channel (spec §13.3) is explicitly out of scope
 * for WP-9. Synchronous fs calls throughout: this writes a handful of small files per turn, not a
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

  recordReceipt(receipt: GateMarketReceipt): void {
    writeFileSync(join(this.runDir, "receipts", `${receipt.receipt_id}.json`), JSON.stringify(receipt, null, 2), "utf-8");
  }

  /** Pass `null` for a passing turn — spec §12.4's "including passes" is the point of this
   * method existing at all; a validator that only ever gets logged when it fails can't be
   * distinguished from a validator that was never run. */
  recordValidatorVerdict(agentId: AgentId, turn: number, error: ContextValidationError | null): void {
    const record: ValidatorVerdictRecord = error
      ? { agentId, turn, passed: false, failure: { kind: error.kind, matched: error.matched } }
      : { agentId, turn, passed: true };
    this.#validatorVerdicts.push(record);
    writeFileSync(join(this.runDir, "validator.json"), JSON.stringify(this.#validatorVerdicts, null, 2), "utf-8");
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
