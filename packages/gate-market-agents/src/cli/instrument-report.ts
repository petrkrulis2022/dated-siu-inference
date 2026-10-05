/**
 * The F1 facts a run reports about its own window 1, computed from the recorded events.
 *
 * Kept as a pure function over window outcomes — and not inline in the runner — because the thing
 * worth pinning is WHICH window it reads. F1 is window 1 alone: windows 2 and 3 route to the
 * non-serving issuer by design and answer the enforcement question, so a mint there backed by the
 * other issuer is the instrument working, not contamination. A version of this that scanned every
 * window would call every correctly configured run unclean.
 */
import { opportunityOf, type FlowsLike, type MomentLike, type Opportunity } from "./decision-rule.js";
import { f1Clean } from "./topology.js";

/** The three tools that create a claim, and so name the issuer the router chose. */
const MINT_KINDS: ReadonlySet<string> = new Set(["mint_claim", "pay_with_claim", "settle_split"]);

export interface WindowFacts {
  windowIndex: number;
  capacityEvents: readonly {
    kind: string;
    issuer?: string;
    agentId?: string;
    counterparty?: string;
  }[];
  paymentMoments: readonly MomentLike[];
  /** Each seat's cumulative claim flows over the window; a seat absent here has none. */
  claimFlows?: Record<string, FlowsLike>;
}

/** No claim has moved to an agent that nothing in this roster pays in fSIU. ORCHESTRATOR buys; the
 *  only agent-to-agent claim movements are payments TO the seller of a quote. If a report marks it
 *  eligible, the count is wrong, not the roster. */
const NEVER_PAID_IN_FSIU: readonly string[] = ["ORCHESTRATOR"];

const NO_FLOWS: FlowsLike = {
  receivedMilliSiu: "0",
  redeemedMilliSiu: "0",
  transferredOutKeyedMilliSiu: "0",
};

export interface F1Report {
  window: 1;
  /** False when the run ended before window 1 produced an outcome. */
  reached: boolean;
  /** Present only when the topology says which issuer window 1 should route to. */
  clean?: { expectedIssuer: string; clean: boolean; mints: number; backedByOthers: number };
  /** Why `clean` is absent, so its absence is a stated fact and not a silent omission. */
  cleanNotComputedBecause?: string;
  /** Per paying agent, from window 1's own payment moments and claim flows only. */
  opportunities: Record<string, Opportunity>;
  /**
   * Defects in the count itself, found by checking it against the recorded events a second way.
   * A report with any is not a result: the block report refuses it, because a rule decided on a
   * miscount is decided on nothing.
   */
  countingErrors: string[];
}

export function buildF1Report(
  windows: readonly WindowFacts[],
  expectedIssuerAddress: string | undefined,
  /** Lower-cased address -> agent id, to check eligibility against the events a second way. */
  agentByAddress?: Readonly<Record<string, string>>,
): F1Report {
  const w1 = windows.find((w) => w.windowIndex === 1);
  if (w1 === undefined) {
    return {
      window: 1,
      reached: false,
      opportunities: {},
      countingErrors: [],
      cleanNotComputedBecause: "window 1 was not reached",
    };
  }
  const agents = [...new Set(w1.paymentMoments.map((m) => m.agentId))];
  const opportunities = Object.fromEntries(
    agents.map((a) => [a, opportunityOf(w1.paymentMoments, a, w1.claimFlows?.[a] ?? NO_FLOWS)]),
  );
  const countingErrors = checkCount(w1, opportunities, agentByAddress);
  if (expectedIssuerAddress === undefined) {
    return {
      window: 1,
      reached: true,
      opportunities,
      countingErrors,
      cleanNotComputedBecause: "this instrument names no expected issuer for window 1",
    };
  }
  const mints = w1.capacityEvents.filter((e) => MINT_KINDS.has(e.kind));
  return {
    window: 1,
    reached: true,
    opportunities,
    countingErrors,
    clean: { expectedIssuer: expectedIssuerAddress, ...f1Clean(mints, expectedIssuerAddress) },
  };
}

/**
 * Checks eligibility against the recorded events, independently of the ledger that produced it.
 *
 * The ledger and this check read the same run but not the same state: the ledger is updated as
 * events are recorded, this replays the finished events with the address book. An agent can only
 * hold fSIU received from another agent if some recorded payment delivered a claim to its address
 * from a DIFFERENT agent — so an agent marked eligible with no such event is a counting error, and
 * ORCHESTRATOR marked eligible at all is one regardless.
 */
function checkCount(
  w1: WindowFacts,
  opportunities: Record<string, Opportunity>,
  agentByAddress: Readonly<Record<string, string>> | undefined,
): string[] {
  const errors: string[] = [];
  for (const [agent, o] of Object.entries(opportunities)) {
    if (!o.eligible) continue;
    if (NEVER_PAID_IN_FSIU.includes(agent)) {
      errors.push(`${agent} is marked eligible, but nothing in this roster pays ${agent} in fSIU`);
      continue;
    }
    if (agentByAddress === undefined) continue;
    const delivered = w1.capacityEvents.some(
      (e) =>
        ["pay_with_claim", "settle_split", "transfer_claim"].includes(e.kind) &&
        e.counterparty !== undefined &&
        agentByAddress[e.counterparty.toLowerCase()] === agent &&
        e.agentId !== agent,
    );
    if (!delivered) {
      errors.push(`${agent} is marked eligible, but no recorded payment delivered it a claim from another agent`);
    }
  }
  return errors;
}

/**
 * The dollar route and the claim route are not the same to a SELLER, even though parity makes them
 * the same to a buyer: the escrow takes a protocol fee out of what the seller is paid, and a claim
 * moves whole. That would give a seller a reason to prefer fSIU if it could steer which asset a
 * quote is settled in. It cannot — the quote a seller signs is the buyer's own stored request, and
 * nothing the seller supplies reaches it — so the asymmetry is recorded and not equalised, and a
 * report must carry it either way.
 */
export interface SellerFeeAsymmetry {
  /** The live escrow's `feeBps`, read from the chain at launch — never assumed. */
  usdcRouteEscrowFeeBps: number;
  /** `WorkClaim` takes no fee: the mint pays the issuer in full and the transfer moves no value. */
  fsiuRouteFeeBps: number;
  chargedTo: "seller";
  sellersCanSteerAssetOfAQuote: boolean;
  note: string;
}

export function sellerFeeAsymmetry(escrowFeeBps: number): SellerFeeAsymmetry {
  if (!Number.isInteger(escrowFeeBps) || escrowFeeBps < 0) {
    throw new Error(`the escrow fee must be a whole number of basis points, got ${escrowFeeBps}.`);
  }
  return {
    usdcRouteEscrowFeeBps: escrowFeeBps,
    fsiuRouteFeeBps: 0,
    chargedTo: "seller",
    sellersCanSteerAssetOfAQuote: false,
    note:
      "The dollar route's escrow fee comes out of the seller's proceeds and the fSIU route has none. " +
      "That is a seller-side difference and not a buyer's cost: price parity is a statement about what " +
      "the payer pays. Sellers cannot steer which asset a quote is settled in — a seller decides only " +
      "whether to sign the buyer's own request — so the asymmetry cannot bias what buyers do, and it " +
      "is recorded and not equalised.",
  };
}
