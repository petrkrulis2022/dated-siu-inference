/**
 * An automatic check that the figures a reply states are on the scale of the figures on its screen (D65). The practice round turned up a reply that held
 * 6,639 USDC minor units, which is $0.0066, and said it covered "the ~1.653 USD cost" of a $0.001653 unit of raw work: off by a thousand, and still
 * reasoning that it could pay. The earlier comprehension probe asked only about direction and could not have caught it.
 *
 * The check is deliberately narrow and objective. For each dollar figure, USDC-minor-unit figure and mSIU figure a reply states, it asks whether the figure
 * is one of the screen's own figures (within 3%) and, if not, whether it is a power of ten away from one (ten, a hundred, a thousand, up to a million, either
 * way). A figure that is a power of ten off, or a dollar figure far larger than the whole wallet, is flagged. It does not catch an arithmetic slip that
 * lands anywhere else, and it says so. A flagged reply stays in every count; the flags are reported beside them.
 *
 * Integer maths throughout (CLAUDE.md invariant 4): stated figures are read as exact decimals and compared as scaled integers.
 */
import { DEFAULT_PARAMS } from "./economy.js";
import { decimalToUnits, fsiuValueNano, milliSiuAsUsdcMinor, quoteTerms, usdcMinorAsMilliSiu, usdcValueNano } from "./money.js";

/** Stated figures are compared at twelve decimals. */
const SCALE = 12;
const TOLERANCE_PERCENT = 3n;
const POWERS: readonly number[] = [1, 2, 3, 4, 5, 6];
/** A dollar figure above this many times the whole wallet cannot be a price or a holding in this lab. */
const IMPLAUSIBLE_TIMES_WALLET = 100n;

export interface ScreenFigures {
  /** Dollar figures on the screen, scaled to twelve decimals. */
  usd: bigint[];
  minor: bigint[];
  msiu: bigint[];
  /** The whole wallet in dollars at twelve decimals. */
  walletUsd: bigint;
}

export interface CellFacts {
  printByRound: readonly string[];
  round: number;
  heldUsdcMinor: string;
  heldFsiuMilliSiu: string;
}

const toScale = (nano: bigint): bigint => nano * 1000n; // nano-USD (9 decimals) to twelve

/** The figures a trader can read on the screen of a cell: the quotes in both assets, the print, and what it holds in both assets. */
export function screenFigures(cell: CellFacts): ScreenFigures {
  const p = BigInt(cell.printByRound[cell.round - 1]);
  const usdc = BigInt(cell.heldUsdcMinor);
  const fsiu = BigInt(cell.heldFsiuMilliSiu);
  const job = quoteTerms("trade", p, DEFAULT_PARAMS);
  const raw = quoteTerms("rawwork", p, DEFAULT_PARAMS);
  const fsiuMinor = milliSiuAsUsdcMinor(fsiu, p);
  return {
    usd: [decimalToUnits(job.usd, SCALE), decimalToUnits(raw.usd, SCALE), toScale(usdcValueNano(usdc)), toScale(fsiuValueNano(fsiu, p)), toScale(p)],
    minor: [job.minorUnits, raw.minorUnits, usdc, fsiuMinor],
    msiu: [job.milliSiu, raw.milliSiu, fsiu, usdcMinorAsMilliSiu(usdc, p)],
    walletUsd: toScale(usdcValueNano(usdc)) + toScale(fsiuValueNano(fsiu, p)),
  };
}

export type NumericFlagKind = "usd_scale" | "minor_scale" | "msiu_scale" | "usd_implausible";

export interface NumericFlag {
  kind: NumericFlagKind;
  /** The figure as the reply wrote it. */
  stated: string;
  /** The screen figure it is a power of ten away from (as a decimal string), or the wallet for an implausible figure. */
  nearest: string;
  /** The power of ten, as +3 or -3. Absent for an implausible figure. */
  power?: number;
  snippet: string;
}

// Not the tail of a longer token: not after a letter, digit or point, and not the exponent of scientific notation ("1e-6 USD" is not 6 USD).
const NUMBER = String.raw`(?<![\w.]|[eE][-+])(\d[\d,]*(?:\.\d+)?)`;
// "1,653 USD minor units" is a count of minor units written with the wrong unit word, not a dollar figure; the minor-unit pattern reads it.
const USD = new RegExp(String.raw`\$\s?${NUMBER}|${NUMBER}\s*(?:USD|usd|dollars?)\b(?!\s+minor\s+units?)`, "g");
const MINOR = new RegExp(String.raw`${NUMBER}\s*(?:USDC\s+|USD\s+)?minor\s+units?`, "gi");
const MSIU = new RegExp(String.raw`${NUMBER}\s*mSIU`, "gi");

/** A stated figure as an exact scaled integer; undefined for something that is not a plain figure. Digits beyond the twelfth decimal are dropped. */
function scaled(text: string): bigint | undefined {
  const plain = text.replace(/,/g, "");
  const [whole, frac = ""] = plain.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) return undefined;
  return decimalToUnits(`${whole}.${frac.slice(0, SCALE) || "0"}`, SCALE);
}

const near = (x: bigint, y: bigint): boolean => (x > y ? x - y : y - x) * 100n <= TOLERANCE_PERCENT * y;

/** Compares `x` with `k` times a power of ten, either way, without a division. */
function nearPower(x: bigint, k: bigint, power: number): boolean {
  const ten = 10n ** BigInt(Math.abs(power));
  return power > 0 ? near(x, k * ten) : near(x * ten, k);
}

/** The first screen figure `x` is a power of ten away from, when it is none of them; undefined when it is one of them or is not a power of ten off any. */
function powerOff(x: bigint, known: readonly bigint[]): { k: bigint; power: number } | undefined {
  if (x === 0n || known.some((k) => k > 0n && near(x, k))) return undefined;
  for (const k of known) {
    if (k <= 0n) continue;
    for (const power of POWERS) {
      if (nearPower(x, k, power)) return { k, power };
      if (nearPower(x, k, -power)) return { k, power: -power };
    }
  }
  return undefined;
}

const show = (n: bigint, places: number): string => {
  const s = n.toString().padStart(places + 1, "0");
  return `${s.slice(0, s.length - places)}.${s.slice(s.length - places)}`.replace(/\.?0+$/, "");
};

/** Every figure a reply states that is a power of ten away from a figure on its screen, or a dollar figure far larger than the whole wallet. */
export function numericFlags(text: string | undefined, figures: ScreenFigures): NumericFlag[] {
  if (text === undefined || text.trim() === "") return [];
  const flags: NumericFlag[] = [];
  const snippetAt = (index: number, length: number): string => text.slice(Math.max(0, index - 40), index + length + 30).replace(/\s+/g, " ");

  for (const m of text.matchAll(USD)) {
    const stated = m[1] ?? m[2];
    const x = scaled(stated);
    if (x === undefined) continue;
    const off = powerOff(x, figures.usd);
    if (off !== undefined) flags.push({ kind: "usd_scale", stated, nearest: show(off.k, SCALE), power: off.power, snippet: snippetAt(m.index ?? 0, m[0].length) });
    else if (figures.walletUsd > 0n && x > figures.walletUsd * IMPLAUSIBLE_TIMES_WALLET && !figures.usd.some((k) => near(x, k))) {
      flags.push({ kind: "usd_implausible", stated, nearest: show(figures.walletUsd, SCALE), snippet: snippetAt(m.index ?? 0, m[0].length) });
    }
  }
  const unitFlags = (re: RegExp, kind: NumericFlagKind, known: readonly bigint[]): void => {
    for (const m of text.matchAll(re)) {
      const x = scaled(m[1]);
      if (x === undefined) continue;
      // "1 minor unit" (singular) states what a unit is, not a holding or a price.
      if (kind === "minor_scale" && x === 10n ** BigInt(SCALE) && /minor\s+unit(?!s)/i.test(m[0])) continue;
      const off = powerOff(x, known.map((k) => k * 10n ** BigInt(SCALE)));
      if (off !== undefined) flags.push({ kind, stated: m[1], nearest: show(off.k, SCALE), power: off.power, snippet: snippetAt(m.index ?? 0, m[0].length) });
    }
  };
  unitFlags(MINOR, "minor_scale", figures.minor);
  unitFlags(MSIU, "msiu_scale", figures.msiu);
  return flags;
}
