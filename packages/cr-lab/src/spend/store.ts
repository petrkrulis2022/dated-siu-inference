import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CR_PUBLIC_DIR, privatePath } from "../paths.js";
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

/**
 * The ledger cannot be read: a line that is not a spend entry, in the middle of the file. A run must STOP on this, never record a result: it is not something a model did, and the trial will not
 * spend past a ledger it cannot read (nothing is spent unrecorded). It is distinct from a torn LAST line, which a crash leaves and which `FileLedgerStore` repairs (below).
 */
export class LedgerUnreadable extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    cause: unknown,
  ) {
    super(
      `${path} line ${line} is not a valid spend entry (${cause instanceof Error ? cause.message : String(cause)}); fix or remove it, the trial will not run past a ledger it cannot read`,
      { cause },
    );
    this.name = "LedgerUnreadable";
  }
}

interface Scan {
  entries: SpendEntry[];
  /** bytes up to and including the newline after the last good line; the file is cut back to here to repair it */
  goodBytes: number;
  /** a last line that is not a spend entry, as a count of bytes only (it is what a crash leaves: zeros, or half a line) */
  tornBytes: number;
}

/**
 * The file-backed ledger. Appends are written and synced to disk in one step. A crash or a sleep in the middle of an append leaves the LAST line torn (seen 2026-10-23: 173 NUL bytes after the
 * last good entry, which stopped every later run); that line alone is treated as an interrupted write: it is skipped when reading, and the next append cuts it off, notes it in the repairs and in
 * a private log, and carries on. A bad line anywhere else is real corruption and stops the run (`LedgerUnreadable`). What an interrupted write may have left unrecorded is at most the one call
 * that was being settled, which the repair note says.
 */
export class FileLedgerStore implements LedgerStore {
  /** repairs made by this store, one line each: the caller alerts on them */
  readonly repairs: string[] = [];

  constructor(
    readonly path: string = SPEND_LEDGER_PATH,
    private readonly repairLog: string = privatePath("cr", "logs", "ledger-repairs.log"),
    private readonly now: () => Date = () => new Date(),
  ) {}

  #scan(): Scan {
    if (!existsSync(this.path)) return { entries: [], goodBytes: 0, tornBytes: 0 };
    const buf = readFileSync(this.path);
    // each line with its byte offsets, so the file can be cut back exactly
    const lines: { text: string; start: number; end: number }[] = [];
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        if (i > start || i < buf.length)
          lines.push({ text: buf.subarray(start, i).toString("utf-8"), start, end: i });
        start = i + 1;
      }
    }
    const nonEmpty = lines.map((l, k) => ({ l, k })).filter(({ l }) => l.text.trim() !== "");
    const last = nonEmpty.at(-1)?.k;
    const entries: SpendEntry[] = [];
    let goodBytes = 0;
    let tornBytes = 0;
    for (const { l, k } of nonEmpty) {
      try {
        entries.push(validateEntry(JSON.parse(l.text)));
        goodBytes = Math.min(buf.length, l.end + 1);
      } catch (err) {
        if (k !== last) throw new LedgerUnreadable(this.path, k + 1, err);
        tornBytes = buf.length - l.start;
      }
    }
    return { entries, goodBytes, tornBytes };
  }

  load(): SpendEntry[] {
    return this.#scan().entries;
  }

  /** Cuts off a torn last line if there is one, notes it, and says whether it did. `append` does this first; it can also be run alone, to leave a clean file to commit. */
  repairTornTail(): boolean {
    const scan = this.#scan();
    if (scan.tornBytes === 0) return false;
    const note = `${this.now().toISOString()} the last line of ${this.path} was an interrupted write (${scan.tornBytes} bytes, after ${scan.entries.length} good entries): cut off; what the interrupted write was settling may be unrecorded, at most one call`;
    truncateSync(this.path, scan.goodBytes);
    this.repairs.push(note);
    mkdirSync(dirname(this.repairLog), { recursive: true });
    appendFileSync(this.repairLog, `${note}\n`);
    return true;
  }

  append(entry: SpendEntry): void {
    validateEntry(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    this.repairTornTail();
    // a last line that is whole but has no newline after it (a crash between the two) gets its newline first, so the new entry is a line of its own
    let prefix = "";
    if (existsSync(this.path)) {
      const buf = readFileSync(this.path);
      if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) prefix = "\n";
    }
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, `${prefix}${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
