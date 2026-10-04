/**
 * Who holds which claim, derived ONLY from the loop's own recorded capacity events — no RPC.
 *
 * It exists to answer one question the decision rule (D5) is conditioned on: **did this agent
 * hold fSIU it had RECEIVED at the moment it paid?** A buyer that holds nothing cannot spend a
 * claim onward, and counting its run as a "no" would let the rule say "do not build" for reasons
 * that have nothing to do with whether agents carry fSIU between hands.
 *
 * Deliberately not a chain read. A balance read straight after a write can serve a pre-write view
 * (the stale-read pattern, five documented instances), and an understated balance here would
 * silently mark an agent ineligible. The loop knows exactly which events it has recorded, in
 * order, so the ledger is built from those.
 *
 * "Received" and "minted" are kept apart on purpose. A claim an agent minted for itself was not
 * given to it, and the rule is about claims that arrive from somebody else and are passed on.
 */
import type { CapacityEvent } from "./full-run.js";
import type { AgentId } from "../identity/resolve.js";

type Holdings = Map<string, bigint>;

export class ClaimLedger {
  #received = new Map<AgentId, Holdings>();
  #minted = new Map<AgentId, Holdings>();

  /** Claims `agent` was GIVEN: a payment in claims, or a transfer. */
  receive(agent: AgentId, tokenId: string, quantity: bigint): void {
    credit(this.#received, agent, tokenId, quantity);
  }

  /** Claims `agent` minted for itself. */
  mint(agent: AgentId, tokenId: string, quantity: bigint): void {
    credit(this.#minted, agent, tokenId, quantity);
  }

  /**
   * Moves a held claim. Debits RECEIVED first, then minted: when an agent holds both of one token
   * the rule is asking about the received claim going onward, so that is the one treated as spent.
   * Never goes negative — a transfer larger than the ledger knows of is a gap in the record, and
   * the chain, which would have reverted, is the authority.
   */
  transfer(from: AgentId, to: AgentId | undefined, tokenId: string, quantity: bigint): void {
    let remaining = quantity;
    for (const book of [this.#received, this.#minted]) {
      const held = book.get(from)?.get(tokenId) ?? 0n;
      const take = held < remaining ? held : remaining;
      if (take > 0n) {
        debit(book, from, tokenId, take);
        remaining -= take;
      }
    }
    if (to !== undefined) this.receive(to, tokenId, quantity - remaining);
  }

  /** Total mSIU of claims `agent` was GIVEN and still holds. */
  heldReceived(agent: AgentId): bigint {
    return sum(this.#received.get(agent));
  }

  /** Total mSIU the agent holds, received or minted. */
  heldTotal(agent: AgentId): bigint {
    return sum(this.#received.get(agent)) + sum(this.#minted.get(agent));
  }

  /**
   * Applies one recorded capacity event. `resolve` turns an address into an agent; an address that
   * is not an agent (the external buyer, an issuer) simply is not tracked.
   */
  apply(event: CapacityEvent, resolve: (address: string) => AgentId | undefined): void {
    if (event.tokenId === undefined || event.quantityMilliSiu === undefined) return;
    const qty = BigInt(event.quantityMilliSiu);
    const to = event.counterparty !== undefined ? resolve(event.counterparty) : undefined;
    switch (event.kind) {
      case "mint_claim":
        this.mint(event.agentId, event.tokenId, qty);
        break;
      case "pay_with_claim":
      case "settle_split":
        // Minted fresh and delivered to the counterparty in one call: the payer never holds it.
        if (to !== undefined) this.receive(to, event.tokenId, qty);
        break;
      case "transfer_claim":
        this.transfer(event.agentId, to, event.tokenId, qty);
        break;
      default:
        // redeem_claim presents without moving the balance; settle_window_close burns, but only
        // after the window, and this ledger is scoped to one window.
        break;
    }
  }
}

function credit(book: Map<AgentId, Holdings>, agent: AgentId, tokenId: string, qty: bigint): void {
  if (qty <= 0n) return;
  const held = book.get(agent) ?? new Map<string, bigint>();
  held.set(tokenId, (held.get(tokenId) ?? 0n) + qty);
  book.set(agent, held);
}

function debit(book: Map<AgentId, Holdings>, agent: AgentId, tokenId: string, qty: bigint): void {
  const held = book.get(agent);
  if (!held) return;
  held.set(tokenId, (held.get(tokenId) ?? 0n) - qty);
}

function sum(held: Holdings | undefined): bigint {
  let total = 0n;
  for (const v of held?.values() ?? []) total += v > 0n ? v : 0n;
  return total;
}
