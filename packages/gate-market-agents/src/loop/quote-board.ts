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

/** What a quote was settled in: dollars through an escrow, a dated work claim, or both. */
export type PaidAsset = "usdc" | "fsiu" | "split";

export interface QuoteBoardOptions {
  /**
   * Whether the dollar route has a capacity-reservation step, and so whether the "you have been paid"
   * line may tell a seller to `reserve_for_work`. True in the gate configuration. The currency lab grants
   * no such tool, so there the line must not name it — a notice that names an action the system will
   * refuse is the defect §4.6-RULE exists to prevent.
   */
  reservationStep?: boolean;
  /**
   * How a buyer is named in what a seller is shown. The loop's own ids are seat names; the currency lab
   * shows its traders under labels, and a board that printed "from WORKER-CODE" would name a seat the
   * agent has never been told exists.
   */
  displayName?: (buyer: AgentId) => string;
  /**
   * Lead each quote line with the request id alone — `qr-2: quote from seller …` — as the lines for open requests
   * already do, instead of `answers qr-2: …`. The first lab run found the second form ambiguous: a trader read
   * "answers qr-2" as the id and called `pay` with it in 28 of its 40 turns, never realizing the id was "qr-2". Off in
   * the gate configuration, which its scripted readers and its history are written against.
   */
  requestIdFirst?: boolean;
}

export class QuoteBoard {
  constructor(private readonly options: QuoteBoardOptions = {}) {}

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
  #paid = new Map<string, PaidAsset>();
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

  /**
   * Called by the loop right after a real, successful settlement — never inferred from a balance.
   *
   * `asset` is what the quote was settled IN, and it decides what the seller is told. Only a
   * payment that opened an escrow (`usdc`, or the dollar leg of a `split`) leaves the seller
   * owing work against real money held for it. A claim payment moves no escrow: the claim is
   * transferred outright and there is nothing to `settle_escrow`. Until 2026-10-04 this recorded
   * no asset, so a quote settled in claims was shown to its seller as "real USDC is in escrow in
   * your favour ... settle_escrow" — false, and naming tools a claim holder cannot use. Defaults
   * to `usdc` so every existing caller keeps its meaning.
   */
  recordPaid(requestId: string, asset: PaidAsset = "usdc"): void {
    this.#paid.set(requestId, asset);
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

  /** Quotes this seller signed that have been paid IN ESCROW and not yet settled — it owes the
   * work, and on the dollar route this is how it finds out at all.
   *
   * Excludes quotes settled wholly in claims, deliberately and for two reasons. The notice would
   * be false (no escrow exists). And it could never clear: the dollar notice ends when the seller
   * calls `settle_escrow`, which does not apply to a claim, so a standing line would keep every
   * wake check and the stall guard believing somebody can still act, indefinitely. A claim's
   * arrival is told through the holder's own section, which ends when the claim is presented. */
  paidUnsettledFor(sellerId: string): QuoteBoardIssuedQuote[] {
    return this.issuedQuotesBySeller(sellerId).filter(
      (i) =>
        this.#paid.has(i.requestId) &&
        this.#paid.get(i.requestId) !== "fsiu" &&
        !this.#settled.has(i.requestId),
    );
  }

  /** What a paid quote was settled in, or undefined if it has not been paid. */
  paidAsset(requestId: string): PaidAsset | undefined {
    return this.#paid.get(requestId);
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
          `  ${r.requestId}: from ${this.options.displayName?.(r.buyer) ?? r.buyer}, ${r.body.siu} SIU, model ${r.body.model}, ` +
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
        const lead = this.options.requestIdFirst === true ? `  ${i.requestId}:` : `  answers ${i.requestId}:`;
        lines.push(
          this.options.reservationStep === false
            ? `${lead} amount_usd_max ${i.quote.amount_usd_max}.`
            : `${lead} amount_usd_max ${i.quote.amount_usd_max}. Commit the capacity ` +
                `first (reserve_for_work), then do the work you quoted for, then ` +
                `settle_escrow.`,
        );
      }
    }
    if (myQuotes.length > 0) {
      lines.push(
        "Quotes you have received (settle one by naming its requestId, in whichever asset you choose):",
      );
      for (const i of myQuotes) {
        const lead =
          this.options.requestIdFirst === true ? `  ${i.requestId}: quote from seller` : `  answers ${i.requestId}: seller`;
        lines.push(`${lead} ${i.quote.seller_id}, amount_usd_max ${i.quote.amount_usd_max}, expires ${i.quote.expiry}`);
      }
    }
    return lines.join("\n");
  }
}
