/**
 * Figures in free text (D107): finding them, saying how precise they are, and checking whether a figure an agent states is one it was shown. Two uses share this file so they cannot
 * disagree about what a figure is: the monitoring flag "states a figure found in no tool result", and the masking on the tagging page, which hides the figures that come from Blockworks'
 * licensed data and leaves the agent's own units and scale words in place.
 *
 * A figure is a number token: digits with optional thousands commas, a decimal part and an exponent, plus the scale word the agent put after it ("billion", "million", "thousand", k, m, bn, b)
 * when there is one. Its precision is its significant digits (leading zeros, and trailing zeros of a round number, do not count): `12,345` has five, `1.234` four, `1000` and `12 million` one
 * and two, `0.0012` two. A round figure carries almost no information, and an agent writing "a thousand times too big" is reasoning about scale, not quoting data, so the round ones are never
 * masked and never flagged. A year (a four-digit integer from 1900 to 2100) is not a figure. All comparison is in exact decimals (invariant 4): no float is made.
 *
 * "Grounded" means the figure, read at its OWN precision, equals some number in the text the agent was shown: the data returned by the tools and the prompt. 12.35 billion is grounded by
 * 12,347,000,000 and not by 12,380,000,000. A figure the agent computed (a sum, a share) is, by this rule, in no tool result, so the flag is for a person to read: it says "computed or
 * invented", not "invented".
 */
import { D, type DecimalValue } from "@touchstone/sdk";

export interface Figure {
  /** the number token as written, e.g. "12,345.6" */
  token: string;
  /** where the token sits in the text (the scale word, if any, is outside it) */
  start: number;
  end: number;
  /** the figure's value with its scale word applied, exact */
  value: DecimalValue;
  /** significant digits of the token as written */
  sig: number;
  /** the scale word that followed, if any, as written */
  scale?: string;
}

const NUMBER = /(?<![\w.])-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const SCALES: readonly [RegExp, number][] = [
  [/^\s*(?:trillions?|tn)\b/i, 12],
  [/^\s*(?:billions?|bn)\b/i, 9],
  [/^\s*(?:millions?|mm)\b/i, 6],
  [/^\s*(?:thousands?)\b/i, 3],
  [/^\s*t(?![a-z0-9])/i, 12],
  [/^\s*b(?![a-z0-9])/i, 9],
  [/^\s*m(?![a-z0-9])/i, 6],
  [/^\s*k(?![a-z0-9])/i, 3],
];

/** Significant digits of a number token as written. */
export function significantDigits(token: string): number {
  const mantissa = (
    token
      .replace(/[,\-+]/g, "")
      .toLowerCase()
      .split("e")[0] ?? ""
  ).replace(".", "");
  const digits = mantissa.replace(/^0+/, "").replace(/0+$/, "");
  return digits.length;
}

const isYear = (token: string): boolean =>
  /^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2100;

/** Every figure in `text`, in order of appearance. */
export function findFigures(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const token = m[0];
    if (isYear(token)) continue;
    const start = m.index ?? 0;
    const end = start + token.length;
    // the 0 of a hex literal (0x1234abcd) is a prefix, not a figure
    if (token === "0" && /^[xX][0-9a-fA-F]/.test(text.slice(end))) continue;
    let value: DecimalValue;
    try {
      value = new D(token.replace(/,/g, ""));
    } catch {
      continue;
    }
    let scale: string | undefined;
    const rest = text.slice(end, end + 14);
    for (const [pattern, exp] of SCALES) {
      const hit = pattern.exec(rest);
      if (hit !== null) {
        scale = hit[0].trim();
        value = value.times(new D(10).pow(exp));
        break;
      }
    }
    out.push({
      token,
      start,
      end,
      value,
      sig: significantDigits(token),
      ...(scale !== undefined ? { scale } : {}),
    });
  }
  return out;
}

/** The set of values in some texts, read at `sig` significant digits, as exact decimal strings. Built once per precision. */
export class DataFigures {
  readonly #figures: Figure[];
  readonly #bySig = new Map<number, Set<string>>();

  constructor(texts: readonly string[]) {
    this.#figures = texts.flatMap((t) => findFigures(t));
  }

  get size(): number {
    return this.#figures.length;
  }

  /** Is `figure` (read at its own precision) equal to some number in the texts? */
  has(figure: Figure): boolean {
    const sig = Math.max(1, figure.sig);
    let set = this.#bySig.get(sig);
    if (set === undefined) {
      set = new Set(this.#figures.map((f) => f.value.toSignificantDigits(sig).toString()));
      this.#bySig.set(sig, set);
    }
    return set.has(figure.value.toSignificantDigits(sig).toString());
  }
}

/** Figures precise enough to carry information: four significant digits or more. Round numbers are scale reasoning, not data. */
export const MIN_SIG_FOR_FLAG = 4;

/** Figures in `text` that are precise and are in none of the texts the agent was shown. */
export function ungroundedFigures(text: string, shown: DataFigures): Figure[] {
  return findFigures(text).filter((f) => f.sig >= MIN_SIG_FOR_FLAG && !shown.has(f));
}

/**
 * Hides the figures that come from the data: every figure of five significant digits or more, and every figure of three or four that is in the texts the agent was shown. The mask replaces
 * only the number token, so a currency sign before it and the units and scale words after it ("billion", "USD", "minor units", "per day") stay, which is what lets a reader see a unit or
 * scale mistake without seeing the licensed figure.
 */
export const MASK = "[figure]";
export function maskFigures(text: string, shown?: DataFigures): string {
  let out = "";
  let at = 0;
  for (const f of findFigures(text)) {
    const mask = f.sig >= 5 || (f.sig >= 3 && shown !== undefined && shown.has(f));
    if (!mask) continue;
    out += text.slice(at, f.start) + MASK;
    at = f.end;
  }
  return out + text.slice(at);
}
