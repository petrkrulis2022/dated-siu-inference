/**
 * Contract errors, said so an agent can use them.
 *
 * An agent that calls a tool which reverts used to be handed viem's whole report: a four-byte
 * selector ("0x73f18ad7"), a note that it "could not decode" it, and a dump of the call with
 * addresses and arguments. `ReservationExists()` means nothing to a model; "you have already
 * reserved capacity for this quote" does. Not being able to say what went wrong is an affordance
 * defect of the same kind as not being able to express an action.
 *
 * The table is keyed by canonical signature, and a test parses the Solidity sources and fails if
 * any custom error the agent-reachable contracts declare has no entry — so a new error cannot ship
 * unexplained. Every sentence states what is true and does not advise: an error message is read at
 * a decision point, and a steer there is a steer.
 */
import { keccak256, toBytes } from "viem";

export const PLAIN_ERRORS: Record<string, string> = {
  // WorkClaim
  "EscrowZero()": "the deployment is misconfigured (no escrow address); an agent cannot fix this.",
  "EscrowNotOpen()": "the escrow for this quote is not open: it has already been settled or has expired.",
  "NotTheEscrowSeller()": "only the seller named in the quote can reserve capacity against it.",
  "ReservationExists()": "you have already reserved capacity for this quote.",
  "NoReservation()": "no capacity has been reserved for this quote.",
  "ReservationAlreadyReleased()": "the capacity reserved for this quote has already been released.",
  "ReservationNotReleasable()": "this reservation cannot be released yet: its escrow is still open and the quote has not expired.",
  "UsdcZero()": "the deployment is misconfigured (no USDC address); an agent cannot fix this.",
  "BondZero()": "the deployment is misconfigured (no bond address); an agent cannot fix this.",
  "RouterZero()": "the deployment is misconfigured (no router address); an agent cannot fix this.",
  "ZeroAmount()": "the amount has to be greater than zero.",
  "BadWindow()": "the claim's delivery window is not valid: it has to end after it starts.",
  "WindowNotOpenYet()": "this claim's window has not opened yet, so it cannot be presented.",
  "WindowClosed()": "this claim's window has closed, so it can no longer be presented.",
  "WindowNotClosedYet()": "this claim's window has not closed yet, so it cannot be settled at close.",
  "NotTheRoutedIssuer()": "only the issuer this claim was routed to can report on it.",
  "NothingToPresent()": "you hold none of this claim, or it does not exist, so there is nothing to present.",
  "NothingToSettle()": "you hold none of this claim, so there is nothing to settle.",
  "AlreadySettled()": "this claim has already been settled.",
  "InsufficientRedemption(uint256,uint256)": "the holder has fewer of this claim than the amount being redeemed.",
  "SeriesMismatch(bytes32,bytes32)": "the rate attestation is for a different grade than this claim's.",
  "StalePrintDate(uint64,uint64)": "the rate attestation is dated for a different day than the day this claim's window closed.",
  // RateAttestationVerifier (inherited by WorkClaim)
  "PublisherZero()": "the deployment is misconfigured (no publisher address); an agent cannot fix this.",
  "RateAttestationExpired(uint64,uint64)": "the rate attestation has expired.",
  "InvalidRateAttestation(address,address)": "the rate attestation was not signed by the publisher.",
  // CapacityBond
  "WorkClaimZero()": "the deployment is misconfigured (no WorkClaim address); an agent cannot fix this.",
  "LotExists()": "this issuer already has a lot for this class.",
  "OnlyWorkClaim()": "only the WorkClaim contract can change an issuer's capacity.",
  "InsufficientHeadroom(uint256,uint256)": "the issuer does not have enough headroom for that amount.",
  "OutstandingUnderflow(uint256,uint256)": "that would release more capacity than the issuer has outstanding.",
  "InsufficientBond(uint256,uint256)": "the issuer's bond cannot cover that payout.",
  // ClaimRouter
  "NoIssuerWithHeadroom(bytes32,uint256)": "no single issuer has enough headroom for a claim this size.",
  // TouchstoneEscrow
  "TokenZero()": "the deployment is misconfigured (no settlement token); an agent cannot fix this.",
  "TreasuryZero()": "the deployment is misconfigured (no fee treasury); an agent cannot fix this.",
  "FeeTooHigh(uint16,uint16)": "the deployment is misconfigured (fee above its maximum); an agent cannot fix this.",
  "QuoteHashZero()": "the quote has no hash, so no escrow can be opened against it.",
  "EscrowExists()": "an escrow already exists for this quote.",
  "SellerZero()": "the quote names no seller.",
  "AmountZero()": "the amount has to be greater than zero.",
  "ExpiryNotInFuture()": "the quote has already expired.",
  "UnexpectedAmountReceived(uint256,uint256)": "the escrow received a different amount than was sent.",
  "PastExpiry()": "the quote has expired.",
  "NotYetExpired()": "the quote has not expired yet.",
  "NotAuthorisedToSettle()": "you are not authorised to settle this escrow: only the seller, or the settler the buyer named, can.",
  "AmountExceedsMax(uint256,uint256)": "that amount is more than the escrow holds.",
  "SettlementTooSmall(uint256,uint256)": "that amount is below the minimum settlement.",
  // The claim token's own errors (OpenZeppelin-style, not declared in our sources)
  "ERC1155InvalidArrayLength(uint256,uint256)": "the claim transfer named a different number of claims than of amounts.",
  "ERC1155InvalidReceiver(address)": "a claim cannot be sent to that address.",
  "ERC1155InvalidSender(address)": "a claim cannot be sent from that address.",
  "ERC1155MissingApprovalForAll(address,address)": "that address has not been approved to move these claims.",
  "ERC1155InsufficientBalance(address,uint256,uint256,uint256)": "you hold less of this claim than the amount you tried to move.",
  // The settlement token's own errors, on a local node's token
  "ERC20InsufficientAllowance(address,uint256,uint256)": "the paying wallet has not approved enough USDC for this contract to take; an agent cannot change that.",
  "ERC20InsufficientBalance(address,uint256,uint256)": "the paying wallet does not hold enough USDC.",
};

/** The string reasons the real USDC contract throws. */
export const PLAIN_REASONS: Record<string, string> = {
  "ERC20: transfer amount exceeds allowance":
    "the paying wallet has not approved enough USDC for this contract to take; an agent cannot change that.",
  "ERC20: transfer amount exceeds balance": "the paying wallet does not hold enough USDC.",
};

const SELECTOR_TO_SIGNATURE = new Map(
  Object.keys(PLAIN_ERRORS).map((sig) => [keccak256(toBytes(sig)).slice(0, 10).toLowerCase(), sig]),
);

/** A chain revert, as opposed to an error one of our own tools or builders wrote for the agent. */
const CHAIN_REVERT = /The contract function|execution reverted|reverted with the following/i;

/**
 * The sentence an agent should see for a failed tool call. An error that is not a chain revert is
 * returned untouched — those are written for the agent already. A revert is explained from its
 * selector or reason when the table knows it, and otherwise reduced to one honest sentence; in no
 * case does the agent see the call dump (contract address, argument list, sender, docs link).
 */
export function explainToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!CHAIN_REVERT.test(message)) return message;

  const selector = message.match(/(?:following signature:\s*|custom error\s+)(0x[0-9a-fA-F]{8})/)?.[1];
  if (selector !== undefined) {
    const sig = SELECTOR_TO_SIGNATURE.get(selector.toLowerCase());
    if (sig !== undefined) return PLAIN_ERRORS[sig];
  }

  const reason =
    message.match(/following reason:\s*\n?\s*([^\n]+)/)?.[1]?.trim() ??
    message.match(/execution reverted:\s*([^\n]+)/)?.[1]?.trim();
  if (reason !== undefined) {
    if (PLAIN_REASONS[reason] !== undefined) return PLAIN_REASONS[reason];
    const name = reason.match(/^([A-Za-z0-9_]+)\(/)?.[1];
    if (name !== undefined) {
      const sig = Object.keys(PLAIN_ERRORS).find((s) => s.startsWith(`${name}(`));
      if (sig !== undefined) return PLAIN_ERRORS[sig];
    }
  }

  return "the chain refused this call, and no further explanation is available.";
}
