import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeedBook, SeedStream, seedCommitment, shuffle, verifyRecord } from "./seeds.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function book(now = () => new Date("2026-10-20T00:05:00Z")) {
  const root = mkdtempSync(join(tmpdir(), "cr-seeds-"));
  dirs.push(root);
  return {
    root,
    book: new SeedBook({ publicDir: join(root, "public"), privateDir: join(root, "private"), now }),
  };
}
const W = "2026-10-20";

describe("SeedBook: commit before the run, reveal after", () => {
  it("commits a 256-bit seed privately and publishes only its commitment", () => {
    const { root, book: b } = book();
    const rec = b.commit(W);
    expect(rec).toEqual({
      window: W,
      commitment: expect.stringMatching(/^[0-9a-f]{64}$/),
      committedAt: "2026-10-20T00:05:00.000Z",
    });
    const seed = b.seedFor(W);
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(seedCommitment(W, seed)).toBe(rec.commitment);
    const published = readFileSync(join(root, "public", `${W}.json`), "utf-8");
    expect(published).not.toContain(seed); // the seed is not in the committed file until it is revealed
  });

  it("never draws a second seed for the same day, whatever happens", () => {
    const { book: b } = book();
    const first = b.commit(W);
    const seed = b.seedFor(W);
    expect(b.commit(W)).toEqual(first);
    expect(b.seedFor(W)).toBe(seed);
  });

  it("gives different days different seeds and commitments", () => {
    const { book: b } = book();
    const [x, y] = [b.commit("2026-10-20"), b.commit("2026-10-21")];
    expect(x.commitment).not.toBe(y.commitment);
    expect(b.seedFor("2026-10-20")).not.toBe(b.seedFor("2026-10-21"));
  });

  it("refuses to hand out a seed for a day with no commitment: nothing may be drawn first", () => {
    const { book: b } = book();
    expect(() => b.seedFor(W)).toThrow(/no seed is committed for 2026-10-20/);
    expect(() => b.reveal(W)).toThrow(/no seed is committed/);
  });

  it("reveals the seed after the run, and a revealed record verifies", () => {
    const t = ["2026-10-20T00:05:00Z", "2026-10-20T09:00:00Z"];
    let i = 0;
    const { book: b } = book(() => new Date(t[Math.min(i++, 1)] as string));
    b.commit(W);
    const revealed = b.reveal(W);
    expect(revealed.seed).toBe(b.seedFor(W));
    expect(revealed.revealedAt).toBe("2026-10-20T09:00:00.000Z");
    expect(verifyRecord(revealed)).toBe(true);
    expect(b.reveal(W)).toEqual(revealed); // idempotent
    expect(b.record(W)).toEqual(revealed);
  });

  it("detects a private seed that no longer matches its published commitment", () => {
    const { root, book: b } = book();
    b.commit(W);
    writeFileSync(join(root, "private", `${W}.seed`), `${"0".repeat(64)}\n`);
    expect(() => b.seedFor(W)).toThrow(/does not match its published commitment/);
    expect(() => b.reveal(W)).toThrow(/does not match/);
  });

  it("detects a revealed seed that does not hash to the commitment", () => {
    const { book: b } = book();
    const rec = b.commit(W);
    expect(verifyRecord({ ...rec, seed: "f".repeat(64) })).toBe(false);
    expect(verifyRecord(rec)).toBe(true); // not yet revealed: consistent
  });

  it("refuses a window that is not a date, so a seed path cannot be steered", () => {
    const { book: b } = book();
    expect(() => b.commit("../../x")).toThrow(TypeError);
    expect(() => b.record("2026-13-40")).toThrow(TypeError);
  });

  it("creates the private seed readable by its owner only", () => {
    const { root, book: b } = book();
    b.commit(W);
    expect(readFileSync(join(root, "private", `${W}.seed`), "utf-8").trim()).toHaveLength(64);
  });
});

describe("SeedStream and shuffle", () => {
  it("gives the same stream for the same seed and label, and different streams for different ones", () => {
    const seq = (seed: string, label: string) => {
      const s = new SeedStream(seed, label);
      return Array.from({ length: 20 }, () => s.next(1000));
    };
    expect(seq("s", "a")).toEqual(seq("s", "a"));
    expect(seq("s", "a")).not.toEqual(seq("s", "b"));
    expect(seq("s", "a")).not.toEqual(seq("t", "a"));
  });

  it("stays in range, and covers a small range evenly enough that no value is starved", () => {
    const s = new SeedStream("seed", "uniform");
    const counts = new Array(6).fill(0) as number[];
    for (let i = 0; i < 6000; i++) {
      const v = s.next(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      counts[v]!++;
    }
    for (const c of counts) expect(c).toBeGreaterThan(850); // expected 1000 each
    for (const c of counts) expect(c).toBeLessThan(1150);
  });

  it("handles n = 1 and rejects a bad range", () => {
    expect(new SeedStream("x", "y").next(1)).toBe(0);
    for (const bad of [0, -1, 1.5, 2 ** 33])
      expect(() => new SeedStream("x", "y").next(bad)).toThrow(RangeError);
  });

  it("shuffles into a permutation of the same items, deterministically, without changing the input", () => {
    const xs = Array.from({ length: 30 }, (_, i) => i);
    const a = shuffle(xs, new SeedStream("seed", "t"));
    expect([...a].sort((p, q) => p - q)).toEqual(xs);
    expect(a).toEqual(shuffle(xs, new SeedStream("seed", "t")));
    expect(a).not.toEqual(xs);
    expect(xs).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(shuffle([], new SeedStream("a", "b"))).toEqual([]);
    expect(shuffle(["only"], new SeedStream("a", "b"))).toEqual(["only"]);
  });

  it("puts each item in each position about equally often", () => {
    const first = new Map<number, number>();
    for (let i = 0; i < 4000; i++) {
      const v = shuffle([0, 1, 2, 3], new SeedStream(`seed-${i}`, "pos"))[0]!;
      first.set(v, (first.get(v) ?? 0) + 1);
    }
    for (const n of [0, 1, 2, 3]) expect(first.get(n)).toBeGreaterThan(850);
    for (const n of [0, 1, 2, 3]) expect(first.get(n)).toBeLessThan(1150);
  });
});
