import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CR_PUBLIC_DIR } from "../paths.js";
import { PROVIDERS, TRIAL_KEY_NAMES } from "../keys.js";
import { parseUsd } from "./money.js";
import { PARTS, type SpendEntry } from "./types.js";

export interface LedgerStore {
  load(): SpendEntry[];
  append(entry: SpendEntry): void;
}

/** The trial's spend ledger: append-only JSON Lines, committed beside the runs it paid for. It carries no Blockworks data. */
export const SPEND_LEDGER_PATH = join(CR_PUBLIC_DIR, "spend-ledger.jsonl");

/**
 * Throws unless `value` is a well-formed spend. Loading is strict on purpose: a corrupt or hand-edited line would otherwise be skipped and the trial would think
 * it had spent less than it had. The key must be a trial key's name, so a spend paid with the print's key can never be recorded as the trial's.
 */
export function validateEntry(value: unknown): SpendEntry {
  const e = value as Record<string, unknown>;
  if (typeof e !== "object" || e === null) throw new TypeError("a spend entry must be an object");
  if (typeof e.at !== "string" || Number.isNaN(new Date(e.at).getTime()))
    throw new TypeError(`spend entry: "at" is not a date: ${String(e.at)}`);
  if (!PROVIDERS.includes(e.provider as never))
    throw new TypeError(`spend entry: unknown provider ${String(e.provider)}`);
  parseUsd(e.usd, "spend entry usd");
  if (!PARTS.includes(e.part as never))
    throw new TypeError(`spend entry: unknown part ${String(e.part)}`);
  if (typeof e.model !== "string" || e.model === "")
    throw new TypeError("spend entry: model is required");
  if (typeof e.what !== "string") throw new TypeError("spend entry: what must be a string");
  if (e.key !== TRIAL_KEY_NAMES[e.provider as keyof typeof TRIAL_KEY_NAMES]) {
    throw new TypeError(
      `spend entry: key must be ${TRIAL_KEY_NAMES[e.provider as keyof typeof TRIAL_KEY_NAMES]} for ${String(e.provider)}, got ${String(e.key)}`,
    );
  }
  return value as SpendEntry;
}

export class MemoryLedgerStore implements LedgerStore {
  readonly #entries: SpendEntry[];
  constructor(entries: readonly SpendEntry[] = []) {
    this.#entries = entries.map(validateEntry);
  }
  load(): SpendEntry[] {
    return [...this.#entries];
  }
  append(entry: SpendEntry): void {
    this.#entries.push(validateEntry(entry));
  }
}

export class FileLedgerStore implements LedgerStore {
  constructor(readonly path: string = SPEND_LEDGER_PATH) {}

  load(): SpendEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, i) => {
        try {
          return validateEntry(JSON.parse(line));
        } catch (err) {
          throw new Error(
            `${this.path} line ${i + 1} is not a valid spend entry (${err instanceof Error ? err.message : String(err)}); fix or remove it, the trial will not run past a ledger it cannot read`,
            { cause: err },
          );
        }
      });
  }

  append(entry: SpendEntry): void {
    validateEntry(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
}
