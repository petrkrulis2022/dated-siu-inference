/**
 * The economy's units, all integers (invariant 4: no floats in money maths).
 *
 *  - Face of a work claim: mSIU (a thousandth of a CR-SIU), as `WorkClaim` counts it.
 *  - AGU-lab: base units with 6 decimals. At the first creation 1 mSIU of face is 1,000 base units, so 1 SIU of face is 1 AGU-lab (R1, Q2).
 *  - USDC: base units with 6 decimals (the labelled test USDC on `anvil` and Base Sepolia, never real USDC).
 *  - A rate: nano-USD per SIU, as the CR lab print is published (WP0) and as `RateAttestationVerifier` signs it.
 *
 * Every conversion rounds DOWN, exactly as the contracts do, so the memory ledger and the chain agree to the base unit.
 */
export type MilliSiu = bigint;
export type AguUnits = bigint;
export type UsdcUnits = bigint;
export type NanoUsdPerSiu = bigint;

export const AGU_DECIMALS = 6;
export const USDC_DECIMALS = 6;
/** AGU-lab base units per mSIU of face at the first creation */
export const AGU_PER_MILLI_SIU_AT_START = 1_000n;
export const BPS = 10_000n;

/** `WorkClaim._usdcAmount`: USDC base units for `milli` mSIU at `rate` nano-USD per SIU, truncated in the one final division. */
export const usdcFor = (milli: MilliSiu, rate: NanoUsdPerSiu): UsdcUnits =>
  (milli * rate) / 1_000_000n;

/**
 * v2 (marketplace-redesign-v2.md, items 1-5): a micro-SIU price's USDC value, and the reverse, for a transaction type whose native unit is the OTHER currency choosing to
 * settle in this one. Every conversion rounds against whoever is initiating it (the "small, stated conversion spread" the design note describes) -- never a separate fee
 * account, just never the rounding direction that favours the party asking for the non-native unit: `Ceil` variants are for a PAYER's own owed amount (never pay less than
 * the item is worth), the plain (floor) variant is for a SELLER's later conversion of what it received (it never gets more than the item was actually worth).
 */
export const usdcForMicroSiu = (microSiu: bigint, rate: NanoUsdPerSiu): UsdcUnits =>
  (microSiu * rate) / 1_000_000_000n;
export const usdcForMicroSiuCeil = (microSiu: bigint, rate: NanoUsdPerSiu): UsdcUnits =>
  (microSiu * rate + 999_999_999n) / 1_000_000_000n;
export const microSiuForUsdcCeil = (usdc: UsdcUnits, rate: NanoUsdPerSiu): bigint =>
  (usdc * 1_000_000_000n + rate - 1n) / rate;

/** The posted price of a front claim: the print less the roll discount, in nano-USD per SIU (rounded down). */
export const discounted = (rate: NanoUsdPerSiu, discountBps: bigint): NanoUsdPerSiu =>
  (rate * (BPS - discountBps)) / BPS;

/**
 * A micro-SIU price as a whole count of mSIU ("250 mSIU", never "0.25 SIU"), for a quote's own posted price (the owner, 2026-11-07). Throws on a micro-SIU amount that is not
 * an exact multiple of 1,000: a quote's price is parsed as a whole mSIU count to begin with (`parse.ts`'s `post_quote`), so this never has to round.
 */
export function showMsiu(microSiu: bigint): string {
  if (microSiu % 1_000n !== 0n)
    throw new Error(`${microSiu} micro-SIU is not a whole number of mSIU`);
  return `${(microSiu / 1_000n).toString()} mSIU`;
}

/** D146: a whole number with its digits grouped in thousands, as the v3a boards show amounts */
export function group(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${s}` : s;
}
/** D146 (v3a): a micro-SIU amount as the board shows it -- whole mSIU with its value in µ$ at `rate` beside it, in the window's display order */
export function pairMicroSiu(microSiu: bigint, rate: NanoUsdPerSiu, siuFirst: boolean): string {
  const usd = usdcForMicroSiu(microSiu, rate);
  return siuFirst ? `${group(microSiu / 1_000n)} mSIU (≈ ${group(usd)} µ$)` : `${group(usd)} µ$ (≈ ${group(microSiu / 1_000n)} mSIU)`;
}
/** D146 (v3a): a USDC amount (base units, µ$) as the board shows it -- with its value in mSIU at `rate` beside it, in the window's display order */
export function pairUsdc(usdc: bigint, rate: NanoUsdPerSiu, siuFirst: boolean): string {
  const micro = rate === 0n ? 0n : (usdc * 1_000_000_000n) / rate;
  return siuFirst ? `${group(micro / 1_000n)} mSIU (≈ ${group(usdc)} µ$)` : `${group(usdc)} µ$ (≈ ${group(micro / 1_000n)} mSIU)`;
}

/** A decimal string of `units` with `decimals` places, for logs and boards (display only, never arithmetic). */
export function show(units: bigint, decimals = 6): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return neg ? `-${out}` : out;
}

/** Parses a non-negative decimal string into base units, refusing more decimals than the unit has (never rounds silently). */
export function parseUnits(text: string, decimals = 6): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (m === null) throw new Error(`not a plain non-negative decimal: ${JSON.stringify(text)}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals: ${text}`);
  return (
    BigInt(m[1] as string) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")
  );
}
