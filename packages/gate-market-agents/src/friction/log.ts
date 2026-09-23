import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "../identity/resolve.js";
import { F2_CAVEAT, MECHANISM_CAVEAT } from "../skills/caveat.js";

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
  /** Spec §7.1a's structural fix for F1's expiry-pressure false-negative risk — logged on every
   * turn, `null` when this turn wasn't about a currently-held, in-window claim (most turns), a
   * real number (seconds until the claim's window closes) whenever one was. Pre-WP-7 fix,
   * 2026-09-23: "added afterwards means run one is unanalysable for F1" — this can't be a later
   * addition once a real run has happened, so it's a field from the start, not optional. */
  time_to_expiry_seconds: number | null;
}

/**
 * Appends one JSON-line-per-entry to `data/gate-market/runs/<runId>/friction-log.jsonl` — mirrors
 * this repo's existing `data/runs/` convention for immutable, append-only per-run records.
 *
 * Pre-WP-7 fix, 2026-09-23: also writes `caveat.json` (spec §1.1's `MECHANISM_CAVEAT`/`F2_CAVEAT`,
 * verbatim — `skills/caveat.ts`) into the same run directory, once, the first time this writer is
 * used — colocated with every friction-log line it ever produces, so whoever reads the directory
 * later can't separate the data from the caveat that qualifies it.
 */
export class FrictionLogWriter {
  private readonly filePath: string;
  private readonly caveatPath: string;
  private caveatWritten = false;

  constructor(runsRoot: string, runId: string) {
    const runDir = path.join(runsRoot, runId);
    this.filePath = path.join(runDir, "friction-log.jsonl");
    this.caveatPath = path.join(runDir, "caveat.json");
  }

  async append(entry: FrictionLogEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await this.ensureCaveatWritten();
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  private async ensureCaveatWritten(): Promise<void> {
    if (this.caveatWritten) return;
    await writeFile(
      this.caveatPath,
      JSON.stringify({ mechanism_caveat: MECHANISM_CAVEAT, f2_caveat: F2_CAVEAT }, null, 2),
      "utf-8",
    );
    this.caveatWritten = true;
  }
}
