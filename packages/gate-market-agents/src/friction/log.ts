import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "../identity/resolve.js";

/**
 * Field-for-field `docs/gate-market-spec.md` §8.6's real schema — "appended by every agent every
 * turn... this replaces the discarded 'agents recommend improvements' goal: evidence from an
 * agent that transacted, not opinion from one that read a spec." The three fields the spec calls
 * out as mattering most: `could_not_express`, `forced_conversion` (with its reason), and
 * `missing_information`.
 *
 * `decision_confidence`'s three values aren't pinned by an enum anywhere in the spec text — "low"
 * is the only value the spec's own example uses. `"low" | "medium" | "high"` is this package's
 * own reasonable reading, not a value copied from spec prose; revisit if the spec is ever more
 * explicit.
 */
export interface FrictionLogEntry {
  agent: AgentId;
  turn: number;
  job_id: string;
  attempted: string;
  outcome: string;
  could_not_express: string | null;
  forced_conversion: boolean;
  conversion_reason: string | null;
  missing_information: string | null;
  decision_confidence: "low" | "medium" | "high";
}

/**
 * Appends one JSON-line-per-entry to `data/gate-market/runs/<runId>/friction-log.jsonl` — mirrors
 * this repo's existing `data/runs/` convention for immutable, append-only per-run records.
 */
export class FrictionLogWriter {
  private readonly filePath: string;

  constructor(runsRoot: string, runId: string) {
    this.filePath = path.join(runsRoot, runId, "friction-log.jsonl");
  }

  async append(entry: FrictionLogEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }
}
