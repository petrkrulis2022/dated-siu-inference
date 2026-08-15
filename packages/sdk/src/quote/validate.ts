import type { DatumQuote } from "../types/generated/datum-quote.schema.js";
import type { ValidationResult } from "../validation/types.js";
import { validateDatumQuote } from "../validation/datum-quote.js";
import { D, roundHalfUp, usdToMinorUnits, usdcAddressFor } from "../money/index.js";
import { QUOTE_AMOUNT_DP } from "./build.js";

/**
 * Everything ajv's schema check (`validateDatumQuote`) cannot express: `if/then` covers
 * `siu_max`'s presence, but not whether the numbers it's present alongside are internally
 * consistent, or whether `settlement` actually points at USDC. Runs the schema check first —
 * these checks assume a schema-conformant shape to index into.
 *
 * Deliberately does NOT check `expiry` against the current time — a quote's *shape* doesn't
 * become invalid at a clock tick, only stale. Expiration and spending limits are payer
 * decisions, made by `quote/mandate.ts`'s `checkSpendingMandate`, not shape validity.
 */
export function validateQuote(data: unknown): ValidationResult<DatumQuote> {
  const schemaCheck = validateDatumQuote(data);
  if (!schemaCheck.valid) {
    return schemaCheck;
  }
  const quote = schemaCheck.data;
  const errors: string[] = [];

  const [major] = quote.schema_version.split(".");
  if (major !== "1") {
    errors.push(
      `unsupported schema_version "${quote.schema_version}" (build 1 only understands major version 1)`,
    );
  }

  if (quote.siu_max !== undefined && new D(quote.siu_max).lessThan(quote.siu)) {
    errors.push(
      `siu_max (${quote.siu_max}) is less than siu (${quote.siu}) — a cap below the point estimate is not a cap`,
    );
  }

  if (new D(quote.siu).isNegative()) {
    errors.push(`siu must not be negative, got ${quote.siu}`);
  }
  if (new D(quote.rate_usd_per_siu).isNegative()) {
    errors.push(`rate_usd_per_siu must not be negative, got ${quote.rate_usd_per_siu}`);
  }
  if (new D(quote.amount_usd_max).isNegative()) {
    errors.push(`amount_usd_max must not be negative, got ${quote.amount_usd_max}`);
  }

  // amount_usd_max must be reproducible from siu_max (estimate/cap) or siu (fixed) × rate — the
  // anti-deception rule. Without it a seller could advertise a cheap rate_usd_per_siu for SIU
  // comparison while charging an unrelated dollar amount.
  const siuForAmount = quote.pattern === "fixed" ? quote.siu : quote.siu_max;
  if (siuForAmount !== undefined) {
    const expectedAmount = roundHalfUp(
      new D(siuForAmount).times(quote.rate_usd_per_siu),
      QUOTE_AMOUNT_DP,
    );
    if (expectedAmount !== quote.amount_usd_max) {
      const basis = quote.pattern === "fixed" ? "siu" : "siu_max";
      errors.push(
        `amount_usd_max (${quote.amount_usd_max}) does not equal ${basis} × rate_usd_per_siu ` +
          `rounded to ${QUOTE_AMOUNT_DP}dp (expected ${expectedAmount})`,
      );
    }
  }

  // Build 1 permits exactly one settlement entry and it MUST be USDC at a known contract
  // address — the array shape exists for build 2 (wSIU/SIUSD as further entries), not to let a
  // build-1 seller point settlement at an arbitrary or attacker-controlled token today.
  if (quote.settlement.length !== 1) {
    errors.push(`build 1 permits exactly one settlement entry, got ${quote.settlement.length}`);
  } else {
    const entry = quote.settlement[0];
    if (entry.asset !== "usdc") {
      errors.push(`build 1 settlement must be "usdc", got "${entry.asset}"`);
    }
    const knownAddress = usdcAddressFor(entry.chain);
    if (!knownAddress) {
      errors.push(`unknown chain "${entry.chain}" — no known USDC address to check against`);
    } else if (entry.address.toLowerCase() !== knownAddress.toLowerCase()) {
      errors.push(
        `settlement address ${entry.address} does not match the known USDC address for ` +
          `"${entry.chain}" (${knownAddress})`,
      );
    }
    const expectedMinorUnits = usdToMinorUnits(quote.amount_usd_max);
    if (entry.amount_max !== expectedMinorUnits) {
      errors.push(
        `settlement amount_max (${entry.amount_max}) does not equal amount_usd_max converted ` +
          `to minor units (${expectedMinorUnits})`,
      );
    }
  }

  if (Number.isNaN(Date.parse(quote.expiry))) {
    errors.push(`expiry "${quote.expiry}" is not a parseable date`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, data: quote };
}
