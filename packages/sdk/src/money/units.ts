import { D } from "./decimal.js";

/**
 * USDC has 6 decimal places on every EVM chain it's deployed to — confirmed against Circle's
 * documentation (https://developers.circle.com/stablecoins/quickstart-transfer-10-usdc-on-solana,
 * "USDC uses 6 decimal places"), not assumed.
 */
export const USDC_DECIMALS = 6;

/**
 * The single shared USD-decimal-string ↔ integer-minor-units conversion, per
 * docs/plan.md's flagged risk: a quote's `amount_usd_max` (decimal string) and
 * `TouchstoneEscrow.openAndFund`'s `maxAmount` (uint256 minor units) must never be converted
 * ad hoc in more than one place, or the two can silently drift.
 *
 * Rounds UP (ceiling), not half-up or down: `amount_usd_max` is a cap, and rounding down
 * would let escrow hold strictly less than the dollar figure the quote promised — a payer
 * could then be asked to fund a shortfall mid-flow. `packages/print/src/rounding.ts` has no
 * ceiling helper because a published index figure should never overstate cost; a payment
 * cap has the opposite bias.
 */
export function usdToMinorUnits(usd: string, decimals: number = USDC_DECIMALS): string {
  return new D(usd).times(new D(10).pow(decimals)).ceil().toFixed(0);
}

/** The exact inverse of usdToMinorUnits — minor units are always integral, so this is exact. */
export function minorUnitsToUsd(minorUnits: string, decimals: number = USDC_DECIMALS): string {
  return new D(minorUnits).dividedBy(new D(10).pow(decimals)).toFixed(decimals);
}
