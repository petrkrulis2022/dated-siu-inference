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

/** The posted price of a front claim: the print less the roll discount, in nano-USD per SIU (rounded down). */
export const discounted = (rate: NanoUsdPerSiu, discountBps: bigint): NanoUsdPerSiu =>
  (rate * (BPS - discountBps)) / BPS;

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
