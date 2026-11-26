import type { Print } from "@touchstone/sdk";
import { D } from "./decimal.js";
import { printBodyHashHex } from "./sign/canonicalise.js";

/**
 * The paid MCP/REST tools' prices in USD, and the same price in SIU at the latest Commodity print.
 *
 * One source for every surface that states these prices: the server's paywall and its 402
 * responses, the MCP tool descriptions, mcp.json, llms.txt and the for-agents page. It lives in
 * this package because the server (packages/mcp-server) and the site both already depend on it,
 * and neither depends on the other.
 *
 * The SIU figure is a comparison price, not a payment amount: buyers pay the USDC amount. It
 * follows the daily print (it is recomputed from whichever Commodity print is latest), and it is
 * omitted, never guessed, when no usable print is available or the latest is older than
 * SIU_PRICE_MAX_AGE_DAYS. Rounding: half-up to a whole mSIU, applied once, at the end.
 */
export const PAID_TOOL_PRICES_USD = {
  get_quote: "0.001",
  convert: "0.001",
  verify_receipt: "0.01",
} as const;

export type PaidTool = keyof typeof PAID_TOOL_PRICES_USD;

/** The grade the SIU price is stated in. */
export const SIU_PRICE_GRADE = "commodity" as const;

/** A Commodity print older than this, in whole days before today's UTC date, carries no SIU price. */
export const SIU_PRICE_MAX_AGE_DAYS = 7;

export interface SiuPrice {
  /** The price in whole mSIU (thousandths of an SIU), half-up. */
  price_msiu: string;
  /** The print's own Dated SIU figure for the grade, exactly as published. */
  rate_usd_per_siu: string;
  grade: typeof SIU_PRICE_GRADE;
  print_id: string;
  print_date: string;
  /** keccak256 of the print's canonical body, so anyone can check the rate against the signed print. */
  print_hash: string;
  /** Exactly as the print carries them. */
  methodology_version: string;
  methodology_revision?: string;
}

const DECIMAL = /^\d+(\.\d+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function positiveDecimal(value: unknown): InstanceType<typeof D> | undefined {
  if (typeof value !== "string" || !DECIMAL.test(value)) return undefined;
  const d = new D(value);
  return d.gt(0) ? d : undefined;
}

/** Whole UTC days from the print's date to `now`'s UTC date; undefined for a malformed date. */
function ageInDays(printDate: string, now: Date): number | undefined {
  const m = ISO_DATE.exec(printDate);
  if (!m) return undefined;
  const printDay = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(printDay).toISOString().slice(0, 10) !== printDate) return undefined; // e.g. 2026-02-30
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - printDay) / DAY_MS);
}

/**
 * `priceUsd` (a decimal string such as "0.001") in whole mSIU at `print`, or undefined when the
 * print is missing, not the Commodity grade, superseded by a correction, malformed, older than
 * SIU_PRICE_MAX_AGE_DAYS, or the result would round to zero. Undefined means "state no SIU
 * price"; it never means zero.
 */
export function siuPriceFor(priceUsd: string, print: Print | undefined, now: Date): SiuPrice | undefined {
  if (!print) return undefined;
  const p = print as Print & { series?: string; superseded_by?: unknown; methodology_revision?: string };
  if (p.series !== SIU_PRICE_GRADE || p.superseded_by) return undefined;
  if (typeof p.methodology_version !== "string" || p.methodology_version === "") return undefined;

  const price = positiveDecimal(priceUsd);
  const rate = positiveDecimal(p.dated_siu);
  if (!price || !rate) return undefined;

  const age = ageInDays(p.date, now);
  if (age === undefined || age > SIU_PRICE_MAX_AGE_DAYS) return undefined;

  const msiu = price.div(rate).times(1000).toFixed(0, D.ROUND_HALF_UP);
  if (msiu === "0") return undefined;

  return {
    price_msiu: msiu,
    rate_usd_per_siu: p.dated_siu,
    grade: SIU_PRICE_GRADE,
    print_id: p.print_id,
    print_date: p.date,
    print_hash: printBodyHashHex(print),
    methodology_version: p.methodology_version,
    ...(p.methodology_revision ? { methodology_revision: p.methodology_revision } : {}),
  };
}

const COMMODITY_ID = /^(\d{4}-\d{2}-\d{2})([b-z]?)-commodity$/;

/**
 * From a list of print ids (data/prints/index.json), the newest date's Commodity print ids, the
 * latest correction first ("…c-commodity" before "…b-commodity" before the original). The caller
 * loads them in order and takes the first that nothing supersedes.
 */
export function commodityPrintCandidates(printIds: readonly string[]): string[] {
  const parsed = printIds
    .map((id) => ({ id, m: COMMODITY_ID.exec(id) }))
    .filter((x): x is { id: string; m: RegExpExecArray } => x.m !== null);
  if (parsed.length === 0) return [];
  const newest = parsed.map((x) => x.m[1] as string).sort().at(-1);
  return parsed
    .filter((x) => x.m[1] === newest)
    .sort((a, b) => ((b.m[2] ?? "") > (a.m[2] ?? "") ? 1 : -1))
    .map((x) => x.id);
}
