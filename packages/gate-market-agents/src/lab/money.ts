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

/** What a trader gains for each need met, in nano-USD: the print times the multiple, per job. */
export const creditNano = (p: bigint, params: LabParams): bigint =>
  (((p * BigInt(params.creditMultiplierBps)) / BPS) * BigInt(params.jobMilliSiu)) / 1000n;

/** What the seller earns on a sale, in nano-USD: the trade price less one raw-work unit at the print. */
export const sellerMarginNano = (p: bigint, params: LabParams): bigint =>
  ((tradeRateNano(p, params) - p) * BigInt(params.jobMilliSiu)) / 1000n;

/** Opening USDC in minor units: the opening fSIU's value at the print, rounded UP so USDC is never worth less. */
export const openingUsdcMinor = (p: bigint, params: LabParams): bigint =>
  ceilDiv(BigInt(params.openingMilliSiu) * p, 1_000_000n);

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
 * What the escrow keeps at settlement — `TouchstoneEscrow.settle`'s own rule, restated so the operator can
 * give it back: nothing on a zero settlement or a zero fee, otherwise the proportional fee rounded down but
 * never below one unit.
 */
export function escrowFeeMinor(settledMinor: bigint, feeBps: number): bigint {
  if (settledMinor === 0n || feeBps === 0) return 0n;
  const raw = (settledMinor * BigInt(feeBps)) / BPS;
  return raw === 0n ? 1n : raw;
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
