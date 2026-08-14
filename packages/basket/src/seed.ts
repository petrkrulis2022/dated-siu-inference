/**
 * Deterministic instance generation, per build1-spec.md §3: the same seed must always
 * produce the same instances, so that publishing the seed after a print lets anyone
 * reproduce it. mulberry32 is hand-rolled rather than an npm dependency deliberately —
 * reproducibility is the entire point, so the exact algorithm needs to stay small,
 * auditable, and immune to a transitive dependency bump silently changing its output.
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a — a simple, deterministic 32-bit string hash, used to turn any seed material into a PRNG seed. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function toSeed(seedMaterial: string | number): number {
  return typeof seedMaterial === "number" ? seedMaterial >>> 0 : fnv1a32(seedMaterial);
}

/** Derives a new, deterministic child seed from a parent seed and identifying parts. */
export function deriveSeed(parentSeed: number, ...parts: (string | number)[]): number {
  return fnv1a32(`${parentSeed}:${parts.join(":")}`);
}

export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randChoice<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, 0, items.length - 1)];
}

export function randHex(rng: Rng, length: number): string {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += randChoice(rng, chars.split(""));
  }
  return out;
}

/** Fisher-Yates, deterministic under the given rng. Does not mutate the input. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
