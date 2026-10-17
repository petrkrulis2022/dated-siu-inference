/**
 * Each day's seed is committed before the run and revealed after (D80), so anyone can check the day's questions were not chosen to suit the answers.
 *
 *  - `commit`: draws 32 random bytes, keeps the seed PRIVATELY (`data/private/blockworks/seeds/<date>.seed`) and publishes only its commitment, `sha256("cr-seed-v1:<date>:<seed>")`, in
 *    `data/lab/cr/seeds/<date>.json` (committed to git, so the commitment has a time). It never draws a second seed for the same day.
 *  - `reveal`: after the run, writes the seed into that file; anyone can then recompute the commitment and the draw.
 * The seed drives `SeedStream`, a deterministic stream of integers from sha256 in counter mode, used to shuffle the candidates into the day's instances.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CR_PUBLIC_DIR, pathWithin, privatePath } from "../paths.js";
import { assertWindowAndTag } from "../data-desk/snapshots.js";

export const seedCommitment = (window: string, seed: string): string =>
  createHash("sha256").update(`cr-seed-v1:${window}:${seed}`).digest("hex");

export interface SeedRecord {
  window: string;
  commitment: string;
  committedAt: string;
  seed?: string;
  revealedAt?: string;
}

export class SeedBook {
  readonly #publicDir: string;
  readonly #privateDir: string;
  readonly #now: () => Date;
  readonly #newSeed: () => string;

  constructor(
    opts: {
      publicDir?: string;
      privateDir?: string;
      now?: () => Date;
      /** where a new day's seed comes from; random in real use, fixed in tests so a test never depends on which questions a seed happens to draw */
      newSeed?: () => string;
    } = {},
  ) {
    this.#publicDir = opts.publicDir ?? join(CR_PUBLIC_DIR, "seeds");
    this.#privateDir = opts.privateDir ?? privatePath("seeds");
    this.#now = opts.now ?? (() => new Date());
    this.#newSeed = opts.newSeed ?? (() => randomBytes(32).toString("hex"));
  }

  #publicFile(window: string): string {
    assertWindowAndTag(window, "daily");
    return pathWithin(this.#publicDir, `${window}.json`);
  }
  #privateFile(window: string): string {
    assertWindowAndTag(window, "daily");
    return pathWithin(this.#privateDir, `${window}.seed`);
  }

  record(window: string): SeedRecord | undefined {
    const f = this.#publicFile(window);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf-8")) as SeedRecord) : undefined;
  }

  /** Commits the day's seed, once. A second call returns the existing record and draws nothing. */
  commit(window: string): SeedRecord {
    const existing = this.record(window);
    if (existing !== undefined) return existing;
    const seed = this.#newSeed();
    mkdirSync(dirname(this.#privateFile(window)), { recursive: true });
    writeFileSync(this.#privateFile(window), `${seed}\n`, { mode: 0o600 });
    const rec: SeedRecord = {
      window,
      commitment: seedCommitment(window, seed),
      committedAt: this.#now().toISOString(),
    };
    mkdirSync(dirname(this.#publicFile(window)), { recursive: true });
    writeFileSync(this.#publicFile(window), `${JSON.stringify(rec, null, 2)}\n`);
    return rec;
  }

  /** The day's seed, for drawing instances. Throws if the day has no commitment: nothing may be drawn before the seed is committed. */
  seedFor(window: string): string {
    if (this.record(window) === undefined)
      throw new Error(
        `no seed is committed for ${window}: commit it before drawing the day's instances`,
      );
    const f = this.#privateFile(window);
    if (!existsSync(f))
      throw new Error(`the seed for ${window} is committed but its private file is missing`);
    const seed = readFileSync(f, "utf-8").trim();
    const rec = this.record(window) as SeedRecord;
    if (seedCommitment(window, seed) !== rec.commitment)
      throw new Error(`the private seed for ${window} does not match its published commitment`);
    return seed;
  }

  /** Publishes the seed, after the run. Idempotent. */
  reveal(window: string): SeedRecord {
    const rec = this.record(window);
    if (rec === undefined) throw new Error(`no seed is committed for ${window}`);
    if (rec.seed !== undefined) return rec;
    const revealed: SeedRecord = {
      ...rec,
      seed: this.seedFor(window),
      revealedAt: this.#now().toISOString(),
    };
    writeFileSync(this.#publicFile(window), `${JSON.stringify(revealed, null, 2)}\n`);
    return revealed;
  }
}

/** True if a published record is self-consistent: a revealed seed hashes to the commitment. A record with no seed yet is consistent. */
export function verifyRecord(rec: SeedRecord): boolean {
  return rec.seed === undefined || seedCommitment(rec.window, rec.seed) === rec.commitment;
}

/** A deterministic stream of integers from sha256 in counter mode. The same seed and label always give the same stream. */
export class SeedStream {
  readonly #seed: string;
  readonly #label: string;
  #counter = 0;
  #buf: Buffer = Buffer.alloc(0);

  constructor(seed: string, label: string) {
    this.#seed = seed;
    this.#label = label;
  }

  #u32(): number {
    if (this.#buf.length < 4) {
      this.#buf = createHash("sha256")
        .update(`${this.#seed}:${this.#label}:${this.#counter++}`)
        .digest();
    }
    const v = this.#buf.readUInt32BE(0);
    this.#buf = this.#buf.subarray(4);
    return v;
  }

  /** An integer in [0, n), without modulo bias. */
  next(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0x1_0000_0000)
      throw new RangeError(`n must be an integer from 1 to 2^32, got ${n}`);
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (;;) {
      const v = this.#u32();
      if (v < limit) return v % n;
    }
  }
}

/** A Fisher-Yates shuffle of a copy of `xs`, driven by the stream. */
export function shuffle<T>(xs: readonly T[], stream: SeedStream): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = stream.next(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
