import type { AgentId } from "../identity/resolve.js";
import type { CapacityEvent, OutstandingClaim } from "../loop/full-run.js";
import type { OpenPosition } from "../loop/redemption-tracker.js";

/**
 * The claims a window leaves for the next one to settle, per HOLDER.
 *
 * This used to be one entry per mint event, with the payee as holder and the minted quantity. That
 * is only true of a claim that is never passed on. A claim passed on in part is two holders' claims;
 * the share that left the payee was never listed, so nobody was ever offered it for settlement, an
 * unpresented share never Expired, and the capacity it consumed stayed consumed past the run — found
 * by the first scripted walk on a fork of the real chain, 2026-10-05.
 *
 * Built from the loop's own record of who holds what (`claimPositions`), not from the mints: the
 * loop saw every transfer, in order, and the chain would have reverted any it had wrong.
 *
 * Pure: returns a new list and touches neither argument.
 */
export function nextOutstanding(
  carried: readonly OutstandingClaim[],
  window: {
    windowIndex: number;
    capacityEvents: readonly CapacityEvent[];
    claimPositions: readonly OpenPosition[];
  },
  addresses: Readonly<Record<string, string>>,
): OutstandingClaim[] {
  const presentedTokens = new Set(
    window.capacityEvents.filter((e) => e.kind === "redeem_claim").map((e) => e.tokenId),
  );
  // A settlement closes one HOLDER's position in a token. An event with no holder (written before
  // the field existed) closes the token's, which is all it can say.
  const settled = window.capacityEvents.filter((e) => e.kind === "settle_window_close");
  const isSettled = (c: OutstandingClaim): boolean =>
    settled.some(
      (e) =>
        e.tokenId === c.tokenId &&
        (e.counterparty === undefined || e.counterparty.toLowerCase() === c.holder.toLowerCase()),
    );

  const out: OutstandingClaim[] = carried
    .filter((c) => !isSettled(c))
    .map((c) => (presentedTokens.has(c.tokenId) ? { ...c, everPresented: true } : { ...c }));

  for (const position of window.claimPositions) {
    const known = addresses[position.holder];
    out.push({
      tokenId: position.tokenId,
      holder: known ?? position.holder,
      ...(known !== undefined ? { holderAgentId: position.holder as AgentId } : {}),
      issuerAgentId: position.issuer,
      quantityMilliSiu: position.quantity,
      mintedInWindow: window.windowIndex,
      everPresented: position.presented,
    });
  }
  return out;
}
