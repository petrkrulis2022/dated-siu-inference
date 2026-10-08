/**
 * The lab's arithmetic. Integers only: nano-USD (1e-9 USD), USDC minor units (1e-6 USD) and mSIU
 * (1e-3 SIU), as `bigint`s, with decimal strings at the edges. No floats anywhere (CLAUDE.md invariant 4);
 * rounding is stated at each function.
 */
import { buildQuoteBody, type QuoteAmountPrecision } from "@touchstone/sdk";
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

/** The print as the decimal USD per SIU a quote request names as its rate: exactly the print, every quote, every round. */
export const printRate = (p: bigint): string => unitsToDecimal(p, 9);

/** SIU size of a job and of a raw-work unit as the decimal SIU string `request_quote` takes ("1"). */
export const jobSiu = (params: LabParams): string => unitsToDecimal(BigInt(params.jobMilliSiu), 3);

/**
 * The claim, in mSIU, worth `amountUsd` at the print, rounded up — the loop's own sizing for a payment in
 * claims (`loop/parity.ts`). The lab no longer sizes a claim this way (D50: a quote is priced in SIU, and the claim is that
 * price), but the gate configuration still does, and a report of an older instrument version is read with it.
 */
export const claimForUsd = (amountUsd: string, p: bigint): bigint => (decimalToUnits(amountUsd, 6) * 1_000_000n + p - 1n) / p;

/** What a trader gains for each need met, in nano-USD: the print times the multiple, per job. */
export const creditNano = (p: bigint, params: LabParams): bigint =>
  (((p * BigInt(params.creditMultiplierBps)) / BPS) * BigInt(params.jobMilliSiu)) / 1000n;

/** What the seller earns on a sale, in nano-USD: the trade price less one raw-work unit at the print. */
export const sellerMarginNano = (p: bigint, params: LabParams): bigint =>
  ((tradeRateNano(p, params) - p) * BigInt(params.jobMilliSiu)) / 1000n;

const maxOf = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => (a > b ? a : b));

/** Which of the lab's two sales a quote is: a job from a trader, or a unit of raw work from the issuer. */
export type QuoteKind = "trade" | "rawwork";

/**
 * What a quote asks, in mSIU (D50). A quote is priced in SIU: a job's price is the trade multiple of its size, a unit of
 * raw work's is its size. Both are fixed numbers of SIU in every round and at every print; only the dollars they come to
 * follow the print. Rounded up, so a multiple that does not divide the size never asks for less than it says.
 */
export const priceMilliSiu = (kind: QuoteKind, params: LabParams): bigint =>
  kind === "trade" ? ceilDiv(BigInt(params.jobMilliSiu) * BigInt(params.tradeMultiplierBps), BPS) : BigInt(params.jobMilliSiu);

/** The price as the decimal SIU a quote request names: "1.2" for a job, "1" for a unit of raw work. */
export const priceSiu = (kind: QuoteKind, params: LabParams): string => unitsToDecimal(priceMilliSiu(kind, params), 3);

/**
 * Everything one quote comes to at print `p`: its price in SIU (`siu`, `milliSiu`), the rate it names (the print), and the
 * dollars that is, which the SDK's builder derives (`quotedPrice`), so the board states what the quote says. Paying in
 * claims costs `milliSiu`, whatever the print. Paying in USDC costs `minorUnits`, which follows it.
 */
export interface QuoteTerms {
  siu: string;
  milliSiu: bigint;
  rate: string;
  usd: string;
  minorUnits: bigint;
}

export function quoteTerms(kind: QuoteKind, p: bigint, params: LabParams): QuoteTerms {
  const siu = priceSiu(kind, params);
  const rate = printRate(p);
  return { siu, milliSiu: priceMilliSiu(kind, params), rate, ...quotedPrice(siu, rate) };
}

/**
 * What each trader opens with in fSIU: exactly what it takes to pay, in claims alone, every quote it must pay — the jobs it
 * buys and the units of raw work it must buy to deliver the jobs it sells (D31). `buildEconomy` makes every trader buy
 * `needsPerTrader` jobs and sell `needsPerTrader` jobs, so each needs that many of each. A quote's price in SIU does not move
 * with the print, so neither does this.
 */
export const openingMilliSiuPerTrader = (params: LabParams): bigint =>
  BigInt(params.needsPerTrader) * (priceMilliSiu("trade", params) + priceMilliSiu("rawwork", params));

/**
 * Opening USDC in minor units: enough, alone, for every quote at the HIGHEST print the walk can reach, and so at every print
 * below it. That is the opening fSIU's value at that print, rounded up, unless the quotes themselves cost more: each quote's
 * dollars are rounded up to a USDC minor unit, so the quotes together can come to a unit or two more than the value of the
 * claims that pay them.
 */
export const openingUsdcMinor = (prints: readonly bigint[], params: LabParams): bigint => {
  const value = ceilDiv(openingMilliSiuPerTrader(params) * maxOf(prints), 1_000_000n);
  const needed = usdcNeededPerTrader(prints, params);
  return value > needed ? value : needed;
};

/** What every quote a trader must pay comes to in USDC minor units at the highest reachable print: its jobs and its raw work. */
export function usdcNeededPerTrader(prints: readonly bigint[], params: LabParams): bigint {
  const p = maxOf(prints);
  return BigInt(params.needsPerTrader) * (quoteTerms("trade", p, params).minorUnits + quoteTerms("rawwork", p, params).minorUnits);
}

/** USDC minor units expressed in mSIU at the print, rounded to the nearest mSIU — the holdings line's "in the other's terms". */
export const usdcMinorAsMilliSiu = (minorUnits: bigint, p: bigint): bigint => (minorUnits * 1_000_000n + p / 2n) / p;

/** mSIU of fSIU expressed in USDC minor units at the print, rounded to the nearest minor unit. */
export const milliSiuAsUsdcMinor = (milliSiu: bigint, p: bigint): bigint => (milliSiu * p + 500_000n) / 1_000_000n;

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
 * What one claim paying a quote cost under instrument versions before 8 (D41): the quote's dollars at four decimals, half-up, for a
 * job priced at the trade multiple of the print per SIU and a unit of raw work at the print, sized at the print and rounded up. A report
 * made then is read with it; no run since uses it.
 */
export function legacyClaimAt(kind: QuoteKind, p: bigint, params: LabParams): bigint {
  const rate = kind === "trade" ? unitsToDecimal(tradeRateNano(p, params), 9) : printRate(p);
  const body = buildQuoteBody({
    siu: unitsToDecimal(BigInt(params.jobMilliSiu), 3),
    model: "lab",
    rateUsdPerSiu: rate,
    indexVersion: "SIU-2026a",
    printId: "lab",
    printHash: "0x00",
    sellerId: "erc8004:0x0",
    chain: "base-sepolia",
    expiresInSeconds: 1,
    pattern: "fixed",
  });
  return claimForUsd(body.amount_usd_max, p);
}

/**
 * The precision of every dollar amount a lab quote carries (D50): USDC's own six decimals, rounded up to the next minor unit,
 * so a quote priced in SIU is owed in the dollars that price comes to and not in $0.0001 steps. The lab names it to the SDK's
 * builder; the SDK's default is unchanged.
 */
export const LAB_QUOTE_PRECISION: QuoteAmountPrecision = { decimals: 6, rounding: "up" };

/**
 * What a quote for `siu` SIU at `rateUsdPerSiu` actually carries: the dollars that comes to at `LAB_QUOTE_PRECISION`. Taken from
 * `buildQuoteBody` itself, not re-derived, so the board states what the quote says and cannot drift from it.
 */
export function quotedPrice(siu: string, rateUsdPerSiu: string): { usd: string; minorUnits: bigint } {
  const body = buildQuoteBody(
    {
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
    },
    LAB_QUOTE_PRECISION,
  );
  return { usd: body.amount_usd_max, minorUnits: BigInt(body.settlement[0].amount_max) };
}
