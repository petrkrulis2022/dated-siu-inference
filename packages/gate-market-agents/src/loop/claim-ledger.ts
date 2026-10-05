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

/**
 * Cumulative quantities for one agent over the window, in mSIU as decimal strings. Kept apart from
 * the held balances above because the decision rule is stated at the BALANCE level — fSIU units are
 * fungible, so which unit left is not knowable — and it needs totals, not token identities.
 */
export interface ClaimFlows {
  /** Claims another agent handed this agent, keyed or not. A self-transfer is not "received". */
  receivedMilliSiu: string;
  /** …of which a payment that named a quote it settles. */
  receivedKeyedMilliSiu: string;
  /** …of which a transfer that named none. Reported apart so a reading can say whether it mattered. */
  receivedUnkeyedMilliSiu: string;
  /** Claims the agent minted for itself with `mint_claim`. */
  mintedMilliSiu: string;
  /** Claims that LEFT the agent's balance in a transfer settling a quote. A payment made by
   *  minting and forwarding (`pay_with_claim`) never touches the balance and is not counted here. */
  transferredOutKeyedMilliSiu: string;
  /** Claims of the agent's that an issuer served and burned. Credited to the HOLDER. */
  redeemedMilliSiu: string;
}

export class ClaimLedger {
  #received = new Map<AgentId, Holdings>();
  #minted = new Map<AgentId, Holdings>();
  #cumulative = new Map<AgentId, Record<keyof ClaimFlows, bigint>>();

  #flow(agent: AgentId): Record<keyof ClaimFlows, bigint> {
    let f = this.#cumulative.get(agent);
    if (!f) {
      f = {
        receivedMilliSiu: 0n,
        receivedKeyedMilliSiu: 0n,
        receivedUnkeyedMilliSiu: 0n,
        mintedMilliSiu: 0n,
        transferredOutKeyedMilliSiu: 0n,
        redeemedMilliSiu: 0n,
      };
      this.#cumulative.set(agent, f);
    }
    return f;
  }

  /** The agent's cumulative flows, as decimal strings (a bigint does not survive JSON). */
  flows(agent: AgentId): ClaimFlows {
    return Object.fromEntries(
      Object.entries(this.#flow(agent)).map(([k, v]) => [k, v.toString()]),
    ) as unknown as ClaimFlows;
  }

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
  transfer(from: AgentId, to: AgentId | undefined, tokenId: string, quantity: bigint): bigint {
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
    return quantity - remaining;
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
    const keyed = event.settlesRequestId !== undefined;
    switch (event.kind) {
      case "mint_claim":
        this.mint(event.agentId, event.tokenId, qty);
        this.#flow(event.agentId).mintedMilliSiu += qty;
        break;
      case "pay_with_claim":
      case "settle_split":
        // Minted fresh and delivered to the counterparty in one call: the payer never holds it.
        if (to !== undefined && to !== event.agentId) {
          this.receive(to, event.tokenId, qty);
          this.#flow(to).receivedMilliSiu += qty;
          this.#flow(to).receivedKeyedMilliSiu += qty;
        }
        break;
      case "transfer_claim": {
        // To oneself is not a receipt, and moves nothing the rule is about.
        const recipient = to === event.agentId ? undefined : to;
        const moved = this.transfer(event.agentId, recipient, event.tokenId, qty);
        if (keyed) this.#flow(event.agentId).transferredOutKeyedMilliSiu += moved;
        if (recipient !== undefined) {
          this.#flow(recipient).receivedMilliSiu += moved;
          if (keyed) this.#flow(recipient).receivedKeyedMilliSiu += moved;
          else this.#flow(recipient).receivedUnkeyedMilliSiu += moved;
        }
        break;
      }
      case "serve_redemption": {
        // The ISSUER's event; the claim burned is the HOLDER's, named in `counterparty`. An issuer
        // is not an agent of this ledger, so only the holder's side is touched.
        if (to !== undefined) {
          const burned = this.transfer(to, undefined, event.tokenId, qty);
          this.#flow(to).redeemedMilliSiu += burned;
        }
        break;
      }
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
