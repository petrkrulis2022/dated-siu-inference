/**
 * The blind draw of reasoning passages for human tagging (D107). `drawPassageSample` takes a seeded draw and returns two things that never meet: the ITEMS, which carry a random id and the
 * masked passage and nothing else, and a KEY from each id back to its passage, kept on disk and not opened until the tags are in. The person tagging never sees the model, the task, the
 * window, the outcome, or what the keyword rules made of a passage.
 *
 * What the person sees is MASKED: figures that come from Blockworks' licensed data are replaced by `[figure]`, and the agent's own units and scale words are left in (`figures.ts`), so a
 * mistake about scale is still visible and the licensed figure is not. The keyword rules code the same masked text the person reads, so the two are compared on the same words.
 * Masked text is still private, and the page is a local file, never an artifact.
 */
import { createHash } from "node:crypto";
import { SeedStream, shuffle } from "../tasks/seeds.js";
import { DataFigures, maskFigures } from "./figures.js";
import type { Passage } from "./passages.js";

/** A passage longer than this is cut for the page, and says so. */
export const PAGE_CUT_CHARS = 1500;

export interface TagItem {
  id: string;
  text: string;
}

export interface KeyEntry {
  passage: string;
  window: string;
  model: string;
  instance: string;
}

export interface DrawnSample {
  items: TagItem[];
  /** From each opaque id to its passage. Kept apart from the page. */
  key: Record<string, KeyEntry>;
  /** sha256 of the items as shown: a tags file records it, so tags are only read against the sample they were made on */
  sampleSha256: string;
  eligible: number;
}

const ID_ALPHABET = "bcdfghjkmnpqrstvwxz23456789";

/** The text a person reads for a passage: figures from the data hidden, long passages cut with a note. */
export function textForPage(p: Passage, shown?: DataFigures): string {
  const masked = maskFigures(p.text.trim(), shown);
  return masked.length <= PAGE_CUT_CHARS
    ? masked
    : `${masked.slice(0, PAGE_CUT_CHARS)} [cut for the page: ${masked.length - PAGE_CUT_CHARS} more characters]`;
}

export function drawPassageSample(
  passages: readonly Passage[],
  n: number,
  seedLabel: string,
  prefix: string,
): DrawnSample {
  if (passages.length < n) throw new Error(`only ${passages.length} passages to draw ${n} from`);
  const seed = createHash("sha256").update(`reasoning-tagging-v1:${seedLabel}`).digest("hex");
  const stream = new SeedStream(seed, "draw");
  // a fixed base order, so the same passages and label always give the same draw
  const pool = [...passages].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const picked = shuffle(pool, stream).slice(0, n);
  const figures = new Map<readonly string[], DataFigures>();
  const used = new Set<string>();
  // ids are random, not a count: an id that counted up would tell a reader where in the draw a passage sits
  const nextId = (): string => {
    for (;;) {
      let tail = "";
      for (let i = 0; i < 4; i++) tail += ID_ALPHABET[stream.next(ID_ALPHABET.length)];
      const id = `${prefix}-${tail}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const items: TagItem[] = [];
  const key: Record<string, KeyEntry> = {};
  for (const p of picked) {
    let shown = figures.get(p.shown);
    if (shown === undefined) figures.set(p.shown, (shown = new DataFigures(p.shown)));
    const id = nextId();
    items.push({ id, text: textForPage(p, shown) });
    key[id] = { passage: p.key, window: p.window, model: p.model, instance: p.instance };
  }
  const sampleSha256 = createHash("sha256").update(JSON.stringify(items)).digest("hex");
  return { items, key, sampleSha256, eligible: passages.length };
}
