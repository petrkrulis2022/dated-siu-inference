/**
 * The lab's arithmetic. Integers only: nano-USD (1e-9 USD), USDC minor units (1e-6 USD) and mSIU
 * (1e-3 SIU), as `bigint`s, with decimal strings at the edges. No floats anywhere (CLAUDE.md invariant 4);
 * rounding is stated at each function.
 */
import { buildQuoteBody } from "@touchstone/sdk";
import type { LabParams } from "./economy.js";

const BPS = 10_000n;

/** Parse a non-negative decimal string into an integer with `places` decimals. Exact; refuses excess precision. */
export function decimalToUnits(value: string, places: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${JSON.stringify(value)}`);
  const fraction = m[2] ?? "";
  if (fraction.length > places) throw new Error(`${JSON.stringify(value)} has more than ${places} decimal places`);
  return BigInt(m[1] + fraction.padEnd(places, "0"));
}

/** An integer count of 10^-places as a decimal string, trailing zeros trimmed (`1724400n, 9` → "0.0017244"). */
export function unitsToDecimal(units: bigint, places: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The print in nano-USD per SIU from its decimal string, e.g. "0.001437" → 1,437,000n. */
export const printNano = (rateUsdPerSiu: string): bigint => decimalToUnits(rateUsdPerSiu, 9);

/** The trade price per SIU, in nano-USD: the print times the multiple, rounded down. */
export const tradeRateNano = (p: bigint, params: LabParams): bigint => (p * BigInt(params.tradeMultiplierBps)) / BPS;

/** The decimal string a buyer must put in `rateUsdPerSiu` to ask for a job at the trade price. */
export const tradeRateUsdPerSiu = (p: bigint, params: LabParams): string => unitsToDecimal(tradeRateNano(p, params), 9);

/** The decimal string for a raw-work unit: exactly the print. */
export const rawWorkRateUsdPerSiu = (p: bigint): string => unitsToDecimal(p, 9);

/** SIU size of a job and of a raw-work unit as the decimal SIU string `request_quote` takes ("1"). */
export const jobSiu = (params: LabParams): string => unitsToDecimal(BigInt(params.jobMilliSiu), 3);

/**
 * The claim, in mSIU, worth `amountUsd` at the print, rounded up — the loop's own sizing for a payment in
 * claims (`loop/parity.ts`), restated over a decimal amount so a report can be read without a quote object.
 */
export const claimForUsd = (amountUsd: string, p: bigint): bigint => (decimalToUnits(amountUsd, 6) * 1_000_000n + p - 1n) / p;

/** What a trader gains for each need met, in nano-USD: the print times the multiple, per job. */
export const creditNano = (p: bigint, params: LabParams): bigint =>
  (((p * BigInt(params.creditMultiplierBps)) / BPS) * BigInt(params.jobMilliSiu)) / 1000n;

/** What the seller earns on a sale, in nano-USD: the trade price less one raw-work unit at the print. */
export const sellerMarginNano = (p: bigint, params: LabParams): bigint =>
  ((tradeRateNano(p, params) - p) * BigInt(params.jobMilliSiu)) / 1000n;

const maxOf = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => (a > b ? a : b));

/** The claim, in mSIU, that pays one job's quote asked for at print `p`, and one unit of raw work's. */
export const jobClaimAt = (p: bigint, params: LabParams): bigint =>
  claimForUsd(quotedPrice(jobSiu(params), tradeRateUsdPerSiu(p, params)).usd, p);
export const rawClaimAt = (p: bigint, params: LabParams): bigint =>
  claimForUsd(quotedPrice(jobSiu(params), rawWorkRateUsdPerSiu(p)).usd, p);

/**
 * What each trader opens with in fSIU, sized so that fSIU ALONE could meet every need however the print moves (D31, D41): the
 * claim for each job it buys and for each unit of raw work it must buy to deliver the jobs it sells. `buildEconomy` makes
 * every trader buy `needsPerTrader` jobs and sell `needsPerTrader` jobs, so each trader needs that many of each. A claim is
 * sized as the loop sizes a payment, the quote's price at the print it was asked for at, rounded up (`claimForUsd`). That is
 * very nearly the same number of mSIU at every print, since the quote's price follows the print, so the sizing takes the
 * largest claim any reachable print asks for. `prints` is every print the walk can reach (`reachablePrints`); with one
 * print in it this is v4's figure.
 */
export function openingMilliSiuPerTrader(prints: readonly bigint[], params: LabParams): bigint {
  return BigInt(params.needsPerTrader) * (maxOf(prints.map((p) => jobClaimAt(p, params))) + maxOf(prints.map((p) => rawClaimAt(p, params))));
}

/**
 * Opening USDC in minor units: the opening fSIU's value at the HIGHEST print the walk can reach, rounded UP. USDC is paid at
 * the quote's price, which follows the print, so this is the amount that is enough, alone, for every quote at the ceiling and
 * so at every print below it (the claims round up, so the value is never less than the quotes' prices).
 */
export const openingUsdcMinor = (prints: readonly bigint[], params: LabParams): bigint =>
  ceilDiv(openingMilliSiuPerTrader(prints, params) * maxOf(prints), 1_000_000n);

/** What every quote a trader must pay comes to in USDC minor units at the highest reachable print: its jobs and its raw work. */
export function usdcNeededPerTrader(prints: readonly bigint[], params: LabParams): bigint {
  const p = maxOf(prints);
  const size = jobSiu(params);
  return (
    BigInt(params.needsPerTrader) *
    (quotedPrice(size, tradeRateUsdPerSiu(p, params)).minorUnits + quotedPrice(size, rawWorkRateUsdPerSiu(p)).minorUnits)
  );
}

/** fSIU valued at the print, in nano-USD, rounded down. */
export const fsiuValueNano = (milliSiu: bigint, p: bigint): bigint => (milliSiu * p) / 1000n;

/** USDC minor units in nano-USD. */
export const usdcValueNano = (minorUnits: bigint): bigint => minorUnits * 1000n;

export interface Holdings {
  usdcMinor: bigint;
  fsiuMilliSiu: bigint;
  needsMet: number;
}

/** A trader's result, in nano-USD: its USDC, plus its fSIU at the print, plus the credit for needs met. */
export function resultNano(h: Holdings, p: bigint, params: LabParams): bigint {
  return usdcValueNano(h.usdcMinor) + fsiuValueNano(h.fsiuMilliSiu, p) + BigInt(h.needsMet) * creditNano(p, params);
}

/**
 * What a quote for `siu` SIU at `rateUsdPerSiu` actually carries: the SDK's own builder rounds the amount
 * half-up to four decimals ($0.0001), so the figure a buyer pays is not siu × rate exactly. Taken from
 * `buildQuoteBody` itself, not re-derived, so the board states what the quote says and cannot drift from it.
 */
export function quotedPrice(siu: string, rateUsdPerSiu: string): { usd: string; minorUnits: bigint } {
  const body = buildQuoteBody({
    siu,
    model: "lab",
    rateUsdPerSiu,
    indexVersion: "SIU-2026a",
    printId: "lab",
    printHash: "0x00",
    sellerId: "erc8004:0x0",
    chain: "base-sepolia",
    expiresInSeconds: 1,
    pattern: "fixed",
  });
  return { usd: body.amount_usd_max, minorUnits: BigInt(body.settlement[0].amount_max) };
}
