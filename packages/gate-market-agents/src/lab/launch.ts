/**
 * What must be true before a lab run starts, as pure arithmetic over the economy and the print. The
 * runner reads the chain and hands the numbers here; nothing in this file reads one.
 *
 * Since instrument v4 nothing is minted after the opening (D31): the fSIU supply is the endowment, fixed for the run.
 * So the one check that is the lab's own is that the endowment fits ISSUER-B's headroom. The endowment is backed by
 * ISSUER-B, and a mint ISSUER-B cannot back falls through to the next issuer in the router's order — the real ISSUER-A,
 * whose claims are not part of this economy and which no trader stands on (plan D22). The run aborts if that happens;
 * this check refuses to start a run in which it could.
 */
import type { LabParams } from "./economy.js";
import { LAB_TRADERS } from "./economy.js";
import { openingMilliSiuPerTrader, openingUsdcMinor, usdcNeededPerTrader } from "./money.js";

/** Plan §5: the endowment may use at most this share of ISSUER-B's headroom, so the backstop is never the plan. */
export const ENDOWMENT_HEADROOM_SHARE_BPS = 8_000n;

export interface EndowmentBound {
  /** The highest print the walk can reach (D41): USDC is sized at it, so USDC alone is enough however the print moves. */
  ceilingPrintNano: bigint;
  /** One trader's opening, in fSIU and in USDC of equal value at the highest reachable print. */
  perTraderMilliSiu: bigint;
  perTraderUsdcMinor: bigint;
  /** What one trader must pay to meet every need, in USDC minor units: either asset alone covers it. */
  perTraderUsdcNeededMinor: bigint;
  /** Every trader's opening together: the whole fSIU supply of the run. */
  totalMilliSiu: bigint;
}

/** `reachable` is every print the walk can reach (`lab/prints.ts`); a lab with a fixed print passes the one. */
export function endowmentBound(reachable: readonly bigint[], params: LabParams): EndowmentBound {
  const perTrader = openingMilliSiuPerTrader(reachable, params);
  return {
    ceilingPrintNano: reachable.reduce((a, b) => (a > b ? a : b)),
    perTraderMilliSiu: perTrader,
    perTraderUsdcMinor: openingUsdcMinor(reachable, params),
    perTraderUsdcNeededMinor: usdcNeededPerTrader(reachable, params),
    totalMilliSiu: perTrader * BigInt(LAB_TRADERS.length),
  };
}

/** The most the endowment may use of `issuerHeadroomMilliSiu`. */
export const endowmentAllowance = (issuerHeadroomMilliSiu: bigint): bigint =>
  (issuerHeadroomMilliSiu * ENDOWMENT_HEADROOM_SHARE_BPS) / 10_000n;

export type EndowmentCheck = { ok: true; allowanceMilliSiu: bigint } | { ok: false; reason: string };

export function checkEndowmentFits(bound: EndowmentBound, issuerHeadroomMilliSiu: bigint): EndowmentCheck {
  const allowance = endowmentAllowance(issuerHeadroomMilliSiu);
  // Either asset alone must cover every need. The USDC opening is the fSIU's value rounded up, so it can only fall short
  // if that sizing is changed to something else; this is the check that would say so.
  if (bound.perTraderUsdcMinor < bound.perTraderUsdcNeededMinor) {
    return {
      ok: false,
      reason:
        `a trader opens with ${bound.perTraderUsdcMinor} USDC minor units but must pay ${bound.perTraderUsdcNeededMinor} ` +
        "to meet every need: USDC alone would not be enough.",
    };
  }
  if (bound.totalMilliSiu <= allowance) return { ok: true, allowanceMilliSiu: allowance };
  return {
    ok: false,
    reason:
      `the endowment is ${bound.totalMilliSiu} mSIU (${bound.perTraderMilliSiu} for each of ${LAB_TRADERS.length} traders), and ` +
      `ISSUER-B can back ${allowance} of its ${issuerHeadroomMilliSiu} mSIU headroom (${ENDOWMENT_HEADROOM_SHARE_BPS / 100n}%). ` +
      "Start from a whole pool, or shrink the schedule.",
  };
}
