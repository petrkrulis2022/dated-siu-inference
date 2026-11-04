/**
 * The ordered log (`docs/part5-build-plan.md` §3.4): one append-only JSONL file per window, in the private directory. Every entry has a gapless `seq`, the window, the round, the actor,
 * the data backend's label and a `kind`. An agent's `reasoning` entry is written before the entries for its action, so who said what to whom and why reads in one place; messages
 * and payments share the sequence.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_KINDS = [
  "reasoning",
  "message",
  "quote",
  "data-purchase",
  "escrow-open",
  "gate",
  "escrow-settle",
  "receipt",
  "create",
  "redeem",
  "roll-sale",
  "roll-buy",
  "roll-cover",
  "roll-carry",
  "buffer",
  "income",
  "participant-sell",
  "participant-buyback",
  "sweep",
  "nav",
  "error",
  // additions the engine needs, each named for what it records
  "setup",
  "notice",
  "claim-mint",
  "claim-present",
  "claim-serve",
  "claim-close",
  "routing",
  "turn",
  "exit",
] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export interface LogEntry {
  seq: number;
  window: string;
  round: number;
  actor: string;
  backend: "snapshot" | "stand-in";
  kind: LogKind;
  [field: string]: unknown;
}

/** bigints are written as decimal strings of base units, so the log is plain JSON and nothing is rounded */
const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

export class EconomyLog {
  readonly entries: LogEntry[] = [];
  #seq = 0;

  constructor(
    readonly backend: "snapshot" | "stand-in",
    readonly file?: string,
  ) {
    if (file !== undefined) mkdirSync(dirname(file), { recursive: true });
  }

  write(
    window: string,
    round: number,
    actor: string,
    kind: LogKind,
    fields: Record<string, unknown> = {},
  ): LogEntry {
    const entry: LogEntry = {
      seq: ++this.#seq,
      window,
      round,
      actor,
      backend: this.backend,
      kind,
      ...fields,
    };
    this.entries.push(entry);
    if (this.file !== undefined)
      appendFileSync(this.file, `${JSON.stringify(entry, replacer)}\n`, { mode: 0o600 });
    return entry;
  }

  of(kind: LogKind): LogEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  /** the whole log as JSONL, the form compared byte for byte in the determinism test */
  text(): string {
    return this.entries.map((e) => JSON.stringify(e, replacer)).join("\n");
  }
}
