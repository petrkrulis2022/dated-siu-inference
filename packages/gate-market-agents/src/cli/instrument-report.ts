/**
 * The F1 facts a run reports about its own window 1, computed from the recorded events.
 *
 * Kept as a pure function over window outcomes — and not inline in the runner — because the thing
 * worth pinning is WHICH window it reads. F1 is window 1 alone: windows 2 and 3 route to the
 * non-serving issuer by design and answer the enforcement question, so a mint there backed by the
 * other issuer is the instrument working, not contamination. A version of this that scanned every
 * window would call every correctly configured run unclean.
 */
import { opportunityFromMoments, type MomentLike } from "./decision-rule.js";
import { f1Clean } from "./topology.js";

/** The three tools that create a claim, and so name the issuer the router chose. */
const MINT_KINDS: ReadonlySet<string> = new Set(["mint_claim", "pay_with_claim", "settle_split"]);

export interface WindowFacts {
  windowIndex: number;
  capacityEvents: readonly { kind: string; issuer?: string }[];
  paymentMoments: readonly MomentLike[];
}

export interface F1Report {
  window: 1;
  /** False when the run ended before window 1 produced an outcome. */
  reached: boolean;
  /** Present only when the topology says which issuer window 1 should route to. */
  clean?: { expectedIssuer: string; clean: boolean; mints: number; backedByOthers: number };
  /** Why `clean` is absent, so its absence is a stated fact and not a silent omission. */
  cleanNotComputedBecause?: string;
  /** Per paying agent, from window 1's own payment moments only. */
  opportunities: Record<string, { eligible: boolean; spentOnward: boolean }>;
}

export function buildF1Report(
  windows: readonly WindowFacts[],
  expectedIssuerAddress: string | undefined,
): F1Report {
  const w1 = windows.find((w) => w.windowIndex === 1);
  if (w1 === undefined) {
    return { window: 1, reached: false, opportunities: {}, cleanNotComputedBecause: "window 1 was not reached" };
  }
  const agents = [...new Set(w1.paymentMoments.map((m) => m.agentId))];
  const opportunities = Object.fromEntries(
    agents.map((a) => [a, opportunityFromMoments(w1.paymentMoments, a)]),
  );
  if (expectedIssuerAddress === undefined) {
    return {
      window: 1,
      reached: true,
      opportunities,
      cleanNotComputedBecause: "this instrument names no expected issuer for window 1",
    };
  }
  const mints = w1.capacityEvents.filter((e) => MINT_KINDS.has(e.kind));
  return {
    window: 1,
    reached: true,
    opportunities,
    clean: { expectedIssuer: expectedIssuerAddress, ...f1Clean(mints, expectedIssuerAddress) },
  };
}
