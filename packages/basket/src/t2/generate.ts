import type { TaskInstance } from "../types.js";
import { deriveSeed, mulberry32, randChoice, randHex, randInt, type Rng } from "../seed.js";

export interface T2Expected {
  codes: string[];
}

const SUBJECTS = [
  "The research team",
  "The archive committee",
  "A visiting scholar",
  "The maintenance crew",
  "The cataloguing unit",
  "The regional office",
  "The advisory board",
  "The volunteer group",
  "The facilities manager",
  "A junior archivist",
  "The digitization team",
  "The records custodian",
];

const VERB_PHRASES = [
  "reviewed the quarterly submissions",
  "updated the indexing system",
  "relocated several boxes of records",
  "digitized a set of older files",
  "scheduled a follow-up inspection",
  "compiled a summary report",
  "cross-referenced the citation list",
  "flagged a handful of items for repair",
  "reorganized the shelving layout",
  "logged a batch of new accessions",
  "reconciled the annual inventory count",
  "drafted a note for the next meeting",
  "archived a set of superseded forms",
  "photographed the fragile bindings",
  "requested additional storage space",
];

const CONNECTORS = ["and", "before", "while", "after which"];

const LOCATIONS = [
  "northern",
  "eastern",
  "southern",
  "western",
  "central",
  "lower",
  "upper",
  "coastal",
];

function buildSentence(rng: Rng): string {
  const subject = randChoice(rng, SUBJECTS);
  const verbPhrase = randChoice(rng, VERB_PHRASES);
  if (rng() < 0.3) {
    const connector = randChoice(rng, CONNECTORS);
    const secondVerbPhrase = randChoice(rng, VERB_PHRASES);
    return `${subject} ${verbPhrase} ${connector} ${randChoice(rng, SUBJECTS).toLowerCase()} ${secondVerbPhrase}.`;
  }
  return `${subject} ${verbPhrase}.`;
}

function buildParagraph(rng: Rng, sentenceCount: number): string {
  return Array.from({ length: sentenceCount }, () => buildSentence(rng)).join(" ");
}

const PLANTED_FACT_COUNT = 4;
const PLANTED_DEPTHS = [0.1, 0.35, 0.65, 0.9];
const TOTAL_PARAGRAPHS = 220; // ≈ 25k tokens of filler at ~8 sentences/paragraph, ~12 words/sentence

export function generateT2Instance(parentSeed: number, index: number): TaskInstance<T2Expected> {
  const seed = deriveSeed(parentSeed, "T2", index);
  const rng = mulberry32(seed);

  const codes = Array.from({ length: PLANTED_FACT_COUNT }, () => randHex(rng, 6).toUpperCase());
  const locations = Array.from({ length: PLANTED_FACT_COUNT }, () => randChoice(rng, LOCATIONS));

  const plantAt = PLANTED_DEPTHS.map((depth) => Math.round(depth * TOTAL_PARAGRAPHS));

  const paragraphs: string[] = [];
  let plantedIndex = 0;
  for (let p = 0; p < TOTAL_PARAGRAPHS; p++) {
    if (plantedIndex < plantAt.length && p === plantAt[plantedIndex]) {
      paragraphs.push(
        `Internal note: the archival access code for the ${locations[plantedIndex]} annex is ${codes[plantedIndex]}.`,
      );
      plantedIndex++;
    }
    paragraphs.push(buildParagraph(rng, randInt(rng, 6, 9)));
  }

  const document = paragraphs.join("\n\n");

  const instruction =
    "Read the archive log below in full. It contains several internal notes, each stating an " +
    "archival access code for a named annex. List every access code you find, one per line, in " +
    "the order they appear in the document. Output only the codes, nothing else.\n\n---\n\n" +
    document;

  return {
    task_class: "T2",
    instance_id: `T2-${index.toString().padStart(2, "0")}`,
    seed,
    prompt: instruction,
    params: { temperature: 0, max_tokens: 256, cache_control: "disabled" },
    expected: { codes },
  };
}

export function generateT2Instances(parentSeed: number, count: number): TaskInstance<T2Expected>[] {
  return Array.from({ length: count }, (_, i) => generateT2Instance(parentSeed, i));
}
