import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bodyHashHex, validateAgentRunRecord, type AgentRunRecord } from "@touchstone/sdk";

/**
 * Rich, unpublished per-transaction telemetry from the demo buyer/seller agents —
 * agent-run-record.schema.json's own doc comment states why this exists and what it isn't: never
 * a print input, never cited as market evidence (a run by an agent we control is useful for
 * understanding workflow behaviour and useless as evidence about the market — see
 * docs/methodology.md §2's hierarchy of evidence, and data/agent-runs/README.md). Deliberately
 * git-tracked (like data/runs/, unlike data/.cache/'s gitignored convenience caches — see
 * quote-log.ts) precisely because this data cannot be collected retroactively: every real Arc/
 * Base-Sepolia transaction that runs before this exists is unrecoverable.
 */
export function agentRunsDir(): string {
  // pnpm always runs package scripts with cwd = the package directory.
  return resolve(process.cwd(), "../../data/agent-runs");
}

/** keccak256 of the fixed canned task a seller ran — build1-spec.md §11's "trivial paid
 * inference service" has exactly one task per seller process, so this hashes the two things
 * that together define it. Same JCS-canonicalise-then-hash convention as quoteHashHex. */
export function taskSpecHash(prompt: string, maxOutputTokens: number): string {
  return bodyHashHex({ prompt, max_output_tokens: maxOutputTokens });
}

/**
 * Computes `receipt_hash` (this record's own self-hash, the field itself excluded — a hash
 * cannot cover itself, same convention `quoteHashHex` uses for a quote's `sig`) and validates the
 * result against the published schema before it's ever written, then writes it to
 * `data/agent-runs/<run_id>-<role>.json`.
 *
 * Deliberately throws on a schema failure (a malformed record is a real bug worth surfacing loud
 * in whatever calls this) but the caller — every real call site in this package — wraps the call
 * itself in a non-fatal `.catch()`: this is telemetry, not settlement, and a logging failure must
 * never be able to break a real payment. A silently-swallowed write failure would be worse than
 * no logging at all, since it would leave a reader believing data exists that doesn't — see each
 * call site's own comment for how the failure is still surfaced (via the existing `log` callback).
 */
export async function logAgentRun(
  record: Omit<AgentRunRecord, "receipt_hash">,
  dir: string = agentRunsDir(),
): Promise<string> {
  const receipt_hash = bodyHashHex(record);
  const full: AgentRunRecord = { ...record, receipt_hash };

  const validation = validateAgentRunRecord(full);
  if (!validation.valid) {
    throw new Error(
      `Refusing to write an agent-run record that fails its own schema: ${validation.errors.join("; ")}`,
    );
  }

  await mkdir(dir, { recursive: true });
  const path = join(dir, `${full.run_id}-${full.role}.json`);
  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, "utf-8");
  return path;
}
