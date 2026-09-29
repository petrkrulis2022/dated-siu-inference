import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import type { AgentId } from "../identity/resolve.js";

/**
 * Found live, 2026-09-25 (WP-7 P5 planning): `request_quote` is a pure local computation
 * (`buildQuoteBody`, no network) and `issue_quote` just signs whatever body it's given with the
 * caller's own key — neither tool makes one agent's request visible to the seller it names, or a
 * seller's signed response visible back to the buyer. Confirmed by reading
 * `dry-loop/three-hop-chain.ts`'s own doc comment: every scripted multi-hop scenario so far fixed
 * each hop's asset choice in TypeScript rather than letting an agent decide, "because that's
 * WP-7's finding, not this package's."
 *
 * This is the real, necessary completion of the mechanism, not a message channel: only the same
 * structured fields `request_quote`/`issue_quote` already produce ever appear here (a `QuoteBody`
 * a buyer constructed, a `TouchstoneQuote` a seller actually signed) — never free text one agent
 * writes for another to read. A request is visible only to the `sellerId` it names; an issued
 * quote is visible only to the buyer whose request it answers.
 */
export interface QuoteBoardRequest {
  requestId: string;
  buyer: AgentId;
  sellerId: string;
  body: QuoteBody;
}

export interface QuoteBoardIssuedQuote {
  requestId: string;
  quote: TouchstoneQuote;
}

export class QuoteBoard {
  #requests: QuoteBoardRequest[] = [];
  #issued: QuoteBoardIssuedQuote[] = [];
  /**
   * Requests whose quote has actually been paid, and those whose escrow has actually been
   * settled — both recorded from real tool results, never inferred.
   *
   * Added 2026-09-29, for two failures the same window exposed. A board that cannot say whether a
   * quote was paid (a) keeps showing a buyer a quote it has already paid, so a wake gate keyed on
   * "the board has something" wakes it for state it has already resolved, and (b) cannot tell a
   * SELLER it was paid at all — which on the dollar route is the single fact it most needs, and
   * the reason WORKER-CODE slept through a job it had been paid for while USDC sat in escrow.
   * Payment is the actionable event on both sides; until it was recorded here neither side could
   * be woken by it.
   */
  #paid = new Set<string>();
  #settled = new Set<string>();
  #nextId = 1;

  /** Called by the loop right after a real `request_quote` tool call returns — never invented. */
  postRequest(buyer: AgentId, body: QuoteBody): QuoteBoardRequest {
    const request: QuoteBoardRequest = {
      requestId: `qr-${this.#nextId++}`,
      buyer,
      sellerId: body.seller_id,
      body,
    };
    this.#requests.push(request);
    return request;
  }

  requestById(requestId: string): QuoteBoardRequest | undefined {
    return this.#requests.find((r) => r.requestId === requestId);
  }

  /** Called by the loop right after a real `issue_quote` tool call returns. */
  postIssuedQuote(requestId: string, quote: TouchstoneQuote): void {
    this.#issued.push({ requestId, quote });
  }

  /** Called by the loop right after a real, successful `pay` — never inferred from a balance. */
  recordPaid(requestId: string): void {
    this.#paid.add(requestId);
  }

  /** Called by the loop right after a real, successful `settle_escrow`. */
  recordSettled(requestId: string): void {
    this.#settled.add(requestId);
  }

  isPaid(requestId: string): boolean {
    return this.#paid.has(requestId);
  }

  /** Quotes answering this buyer's own requests that it has NOT yet paid — the buyer's only
   * genuinely actionable quote state. A quote it has already paid is resolved, and showing it
   * again is what woke a buyer with nothing to do. */
  unpaidQuotesFor(buyer: AgentId): QuoteBoardIssuedQuote[] {
    return this.issuedQuotesFor(buyer).filter((i) => !this.#paid.has(i.requestId));
  }

  /** Quotes this seller signed that have been paid and not yet settled — it owes the work, and
   * on the dollar route this is how it finds out at all. */
  paidUnsettledFor(sellerId: string): QuoteBoardIssuedQuote[] {
    return this.issuedQuotesBySeller(sellerId).filter(
      (i) => this.#paid.has(i.requestId) && !this.#settled.has(i.requestId),
    );
  }

  /** The exact, real, seller-signed `TouchstoneQuote` for one request — what `pay` must actually
   * be called with. `pay`'s own real args schema (`tools/pay.ts`) takes the full quote object,
   * not a reconstruction; `renderFor`'s own board summary (amount/expiry/seller only) is real but
   * deliberately partial, so a model copying it by hand could never produce a quote whose fields
   * still match the seller's real signature. Resolved here the same way `issue_quote`'s own
   * requestId splice already is, in `buildToolArgs`. */
  issuedQuoteById(requestId: string): TouchstoneQuote | undefined {
    return this.#issued.find((i) => i.requestId === requestId)?.quote;
  }

  /** Open requests addressed to `sellerId` (this agent's own erc8004 id) that nothing has
   * answered yet — what a seller's own turn should see. */
  openRequestsFor(sellerId: string): QuoteBoardRequest[] {
    const answered = new Set(this.#issued.map((i) => i.requestId));
    return this.#requests.filter((r) => r.sellerId === sellerId && !answered.has(r.requestId));
  }

  /** Quotes issued in answer to a request `buyer` itself made — what a buyer's own turn should
   * see, so it can decide whether to `pay` against one. */
  issuedQuotesFor(buyer: AgentId): QuoteBoardIssuedQuote[] {
    const myRequestIds = new Set(
      this.#requests.filter((r) => r.buyer === buyer).map((r) => r.requestId),
    );
    return this.#issued.filter((i) => myRequestIds.has(i.requestId));
  }

  /** Quotes this seller itself signed — the seller's own side of `issuedQuotesFor`. Needed
   * because an escrow is keyed by the hash of the quote it was opened against, and a seller has
   * no way to look one up otherwise: the escrow contract exposes a mapping, not an enumeration.
   * Added 2026-09-27, after a real run deadlocked because a paid seller could not see that it
   * had been paid. */
  issuedQuotesBySeller(sellerId: string): QuoteBoardIssuedQuote[] {
    const mine = new Set(
      this.#requests.filter((r) => r.sellerId === sellerId).map((r) => r.requestId),
    );
    return this.#issued.filter((i) => mine.has(i.requestId));
  }

  /** Small, structured text for one agent's own turn — job/buyer/seller/amount fields only, no
   * free text one agent authored for another to read. Empty string when there's nothing to show,
   * so a turn with no open market activity doesn't carry a hollow "MARKET BOARD" header. */
  renderFor(agentId: AgentId, myErc8004Id: string): string {
    const openRequests = this.openRequestsFor(myErc8004Id);
    // Only genuinely actionable state. A quote this buyer has already paid is resolved: showing
    // it again is what woke ORCHESTRATOR on a turn where it had nothing left to do (2026-09-29
    // run 4, window 1), which put it straight back into the forced choice between acting and
    // leaving that the wake gate exists to remove.
    const myQuotes = this.unpaidQuotesFor(agentId);
    const owedBySeller = this.paidUnsettledFor(myErc8004Id);
    if (openRequests.length === 0 && myQuotes.length === 0 && owedBySeller.length === 0) return "";

    const lines: string[] = ["MARKET BOARD"];
    if (openRequests.length > 0) {
      lines.push(
        "Open quote requests addressed to you (call issue_quote with { requestId } to answer one):",
      );
      for (const r of openRequests) {
        lines.push(
          `  ${r.requestId}: from ${r.buyer}, ${r.body.siu} SIU, model ${r.body.model}, ` +
            `rate ${r.body.rate_usd_per_siu} USD/SIU, pattern ${r.body.pattern}`,
        );
      }
    }
    if (owedBySeller.length > 0) {
      lines.push(
        "YOU HAVE BEEN PAID AND OWE THE WORK — real USDC is in escrow in your favour and is not " +
          "yours until you deliver and settle:",
      );
      for (const i of owedBySeller) {
        lines.push(
          `  answers ${i.requestId}: amount_usd_max ${i.quote.amount_usd_max}. Commit the capacity ` +
            `first (reserve_for_work), then do the work (submit_job) until it passes, then ` +
            `settle_escrow.`,
        );
      }
    }
    if (myQuotes.length > 0) {
      lines.push(
        "Quotes you have received (pay against one with the real quote object, via get_balances/pay):",
      );
      for (const i of myQuotes) {
        lines.push(
          `  answers ${i.requestId}: seller ${i.quote.seller_id}, amount_usd_max ${i.quote.amount_usd_max}, ` +
            `expires ${i.quote.expiry}`,
        );
      }
    }
    return lines.join("\n");
  }
}
