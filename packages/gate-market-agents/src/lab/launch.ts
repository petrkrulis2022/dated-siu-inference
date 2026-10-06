/**
 * What must be true before a lab run starts, as pure arithmetic over the economy and the print. The
 * runner reads the chain and hands the numbers here; nothing in this file reads one.
 *
 * The one check that is the lab's own is the mint bound. Every mint is backed by ISSUER-B, and a mint
 * ISSUER-B cannot back falls through to the next issuer in the router's order — the real ISSUER-A, whose
 * claims are not part of this economy and which no trader stands on (plan D22). The run aborts if that
 * happens; this check refuses to start a run in which it could.
 */
import type { Economy } from "./economy.js";
import { jobSiu, quotedPrice, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu } from "./money.js";

/** Plan §5: mints may use at most this share of ISSUER-B's headroom, so the backstop is never the plan. */
export const MINT_HEADROOM_SHARE_BPS = 8_000n;

export interface MintBound {
  /** Every trader's opening endowment, together. */
  openingMilliSiu: bigint;
  /** One job's quote paid by minting a claim for it. */
  jobClaimMilliSiu: bigint;
  /** One unit of raw work's quote paid by minting a claim for it. */
  rawClaimMilliSiu: bigint;
  /** A need has at most one sale, and a delivery needs at most one unit, so each need costs one of each. */
  needs: number;
  /** The most the lab can mint: the endowment, then every need's job and unit each paid by minting. */
  worstCaseMilliSiu: bigint;
}

/** The claim a quote is sized to — the loop's own rule (`loop/parity.ts`): the price's worth at the print, rounded up. */
const claimForMinor = (minorUnits: bigint, printNano: bigint): bigint =>
  (minorUnits * 1_000_000n + printNano - 1n) / printNano;

export function mintBound(printNano: bigint, economy: Economy): MintBound {
  const p = economy.params;
  const size = jobSiu(p);
  const jobClaim = claimForMinor(quotedPrice(size, tradeRateUsdPerSiu(printNano, p)).minorUnits, printNano);
  const rawClaim = claimForMinor(quotedPrice(size, rawWorkRateUsdPerSiu(printNano)).minorUnits, printNano);
  const opening = BigInt(p.openingMilliSiu) * 4n;
  const needs = economy.needs.length;
  return {
    openingMilliSiu: opening,
    jobClaimMilliSiu: jobClaim,
    rawClaimMilliSiu: rawClaim,
    needs,
    worstCaseMilliSiu: opening + BigInt(needs) * (jobClaim + rawClaim),
  };
}

/** The most the lab may mint against `issuerHeadroomMilliSiu`. */
export const mintAllowance = (issuerHeadroomMilliSiu: bigint): bigint =>
  (issuerHeadroomMilliSiu * MINT_HEADROOM_SHARE_BPS) / 10_000n;

export type MintCheck = { ok: true; allowanceMilliSiu: bigint } | { ok: false; reason: string };

export function checkMintsFit(bound: MintBound, issuerHeadroomMilliSiu: bigint): MintCheck {
  const allowance = mintAllowance(issuerHeadroomMilliSiu);
  if (bound.worstCaseMilliSiu <= allowance) return { ok: true, allowanceMilliSiu: allowance };
  return {
    ok: false,
    reason:
      `the most this lab can mint is ${bound.worstCaseMilliSiu} mSIU (${bound.openingMilliSiu} opening, then ` +
      `${bound.needs} needs each paid by minting a job claim of ${bound.jobClaimMilliSiu} and a raw-work claim of ` +
      `${bound.rawClaimMilliSiu}), and ISSUER-B can back ${allowance} of its ${issuerHeadroomMilliSiu} mSIU headroom ` +
      `(${MINT_HEADROOM_SHARE_BPS / 100n}%). Lower the opening endowment, or start from a whole pool.`,
  };
}
