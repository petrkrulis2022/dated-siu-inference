/**
 * How the lab writes a quote and a wallet (D50). A quote leads with the work and its price in SIU, which is what the quote
 * format denominates and what does not move; then what settling it costs in each asset at the round's print, which does.
 * The holdings line states both assets and each in the other's terms at the print in force, so an agent need not do the
 * conversion to compare them. Both put the two assets in the run's seeded order (`route-order.ts`).
 *
 * Facts and arithmetic only. Nothing here says which asset to use.
 */
import type { LabBooks, Sale } from "./books.js";
import type { LabParams } from "./economy.js";
import { milliSiuAsUsdcMinor, quoteTerms, usdcMinorAsMilliSiu, unitsToDecimal, type QuoteTerms } from "./money.js";
import { printText } from "./prints.js";
import { inAssetOrder, type RouteOrder } from "./route-order.js";

/** A whole number with thousands separators, as every lab sentence writes one: `1200` → "1,200". */
export const fmt = (n: bigint | number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** What settling a quote costs, in both assets, in the run's order: "0.001725 USD or 1,200 mSIU of fSIU". */
export function settleText(t: QuoteTerms, order: RouteOrder): string {
  const [a, b] = inAssetOrder(order, `${t.usd} USD`, `${fmt(t.milliSiu)} mSIU of fSIU`);
  return `${a} or ${b}`;
}

/**
 * One quote, as a trader reads it: the work, its price in SIU, what settling costs in each asset, and the print the quote was
 * priced at. `type` is the job's type for a job; a unit of raw work has none. The work is one SIU either way.
 */
export function quoteSentence(
  sale: Pick<Sale, "kind">,
  type: string | undefined,
  p: bigint,
  params: LabParams,
  order: RouteOrder,
  /** Who the other party is, written after the work: "from TRADER-2" on a quote received, "asked for by TRADER-1" on a request. */
  party?: string,
): string {
  const t = quoteTerms(sale.kind, p, params);
  const work = sale.kind === "trade" ? `${type ?? "a"} job` : "a unit of raw work";
  const size = unitsToDecimal(BigInt(params.jobMilliSiu), 3);
  return (
    `${work}${party === undefined ? "" : ` ${party}`}, ${size} SIU of work, price ${t.siu} SIU — ` +
    `settle ${settleText(t, order)} (print ${printText(p)} USD/SIU)`
  );
}

/**
 * The quote of a request the lab knows, as a sentence; undefined for a request it does not (the board then writes its own line).
 * `partyOf` names the other party for this sale, and `tail` is what follows the sentence (a quote's expiry).
 */
export function quoteSentenceFor(
  books: LabBooks,
  params: LabParams,
  order: RouteOrder,
  requestId: string,
  partyOf: (sale: Sale) => string,
  tail = "",
  /** The print in force, for a lab whose books carry no print path (a test): a run's books always do, and the sale's own round's print is used. */
  fallbackPrint?: bigint,
): string | undefined {
  const sale = books.sale(requestId);
  const p = books.printForSale(requestId) ?? fallbackPrint;
  if (sale === undefined || p === undefined) return undefined;
  const need = sale.needId === undefined ? undefined : books.economy.needs.find((n) => n.id === sale.needId);
  return `${quoteSentence(sale, need?.type, p, params, order, partyOf(sale))}${tail}`;
}

/**
 * What a trader holds, every turn: each asset in its own unit, and in the other's terms at the print in force. USDC is in
 * minor units, which is how every payment line writes it.
 */
export function holdingsLine(held: { usdcMinor: bigint; fsiuMilliSiu: bigint }, p: bigint, order: RouteOrder): string {
  const usdc = `${fmt(held.usdcMinor)} USDC minor units (= ${fmt(usdcMinorAsMilliSiu(held.usdcMinor, p))} mSIU at this print)`;
  const fsiu = `${fmt(held.fsiuMilliSiu)} mSIU of fSIU (= ${fmt(milliSiuAsUsdcMinor(held.fsiuMilliSiu, p))} USDC minor units at this print)`;
  const [a, b] = inAssetOrder(order, usdc, fsiu);
  return `YOU HOLD: ${a} and ${b}`;
}
