import type { AgentId } from "../identity/resolve.js";

/**
 * Forward terms an issuer states for a *later* window, and whether anyone took them.
 *
 * Why this exists. Scarcity is what makes a later window's capacity worth something, and an
 * issuer that can see its own pool draining has a reason to say what it will sell the remainder
 * for. Until now no agent in this roster could say that at all: `request_quote`/`issue_quote`
 * are a buyer-proposes/seller-signs pair for one immediate job, and `issue_quote` signs the exact
 * terms the buyer wrote — a seller cannot name its own price with it, let alone name one for a
 * window that has not started.
 *
 * What this is NOT, stated plainly because the gap matters. A forward term recorded here is a
 * **stated price, not an instrument.** Nothing enforces it: `WorkClaim.mint` charges the attested
 * print rate, the attestation is signed by the publisher rather than by the issuer, and there is
 * no contract anywhere in this build that could bind an issuer to a price it named in advance.
 * Building one would be a new instrument, which build 1 does not have and this testbed's own
 * sanctioned exception does not cover. So what is measured here is what an issuer offers and what
 * a buyer does about it — genuinely interesting, and genuinely not a forward market.
 *
 * Every quote is recorded whether or not it is taken. A book that only kept accepted terms would
 * show a market that always clears, which is exactly the failure mode worth avoiding: a rejected
 * offer at a stated price is as much a datum as an accepted one.
 */
export interface ForwardQuote {
  quoteId: string;
  /** The issuer that stated these terms. */
  issuer: AgentId;
  /** 1-based window this offer is for — always later than the window it was stated in. */
  forWindow: number;
  /** The window this offer was actually stated in. */
  statedInWindow: number;
  /** Decimal USD per SIU, the repo's money-string convention. The issuer's own number. */
  rateUsdPerSiu: string;
  /** mSIU the issuer says it will make available at that rate. */
  maxQuantityMilliSiu: string;
  /** The issuer's own headroom in the class at the moment it quoted — recorded so a later
   * reading can tell an offer made against real remaining capacity from one made against none. */
  issuerHeadroomAtQuote: string;
  /** Whether a buyer ever acted on it, and if so in which window. `null` means never taken. */
  takenInWindow: number | null;
  /** The buyer that took it. */
  takenBy: AgentId | null;
}

export class ForwardQuoteBook {
  #quotes: ForwardQuote[] = [];
  #nextId = 1;

  /** Called by the loop right after a real `quote_forward` tool call returns — never invented. */
  record(input: Omit<ForwardQuote, "quoteId" | "takenInWindow" | "takenBy">): ForwardQuote {
    const quote: ForwardQuote = {
      ...input,
      quoteId: `fwd-${this.#nextId++}`,
      takenInWindow: null,
      takenBy: null,
    };
    this.#quotes.push(quote);
    return quote;
  }

  byId(quoteId: string): ForwardQuote | undefined {
    return this.#quotes.find((q) => q.quoteId === quoteId);
  }

  /** Marks one offer as taken. Returns false for an unknown id or one already taken, so a
   * double-take is visible as a refusal rather than silently overwriting who took it first. */
  markTaken(quoteId: string, buyer: AgentId, window: number): boolean {
    const quote = this.byId(quoteId);
    if (!quote || quote.takenInWindow !== null) return false;
    quote.takenInWindow = window;
    quote.takenBy = buyer;
    return true;
  }

  /** Offers stated for `window` and not yet taken — what a buyer entering that window should
   * see. Sorted cheapest first: that is an ordering of the issuers' own numbers, not a
   * recommendation, and the buyer is told as much. */
  openFor(window: number): ForwardQuote[] {
    return this.#quotes
      .filter((q) => q.forWindow === window && q.takenInWindow === null)
      .sort((a, b) => Number(a.rateUsdPerSiu) - Number(b.rateUsdPerSiu));
  }

  quotesBy(issuer: AgentId): ForwardQuote[] {
    return this.#quotes.filter((q) => q.issuer === issuer);
  }

  all(): readonly ForwardQuote[] {
    return this.#quotes;
  }

  /** One agent's own view, in the same structured-fields-only style as the quote board: an
   * issuer sees what it has offered, a buyer sees what is open for the window it is in. Empty
   * string when there is nothing, so a turn with no forward activity carries no hollow header. */
  renderFor(agentId: AgentId, currentWindow: number, isIssuer: boolean): string {
    const lines: string[] = [];
    if (isIssuer) {
      const mine = this.quotesBy(agentId);
      if (mine.length === 0) return "";
      lines.push("FORWARD TERMS YOU HAVE STATED");
      for (const q of mine) {
        lines.push(
          `  ${q.quoteId}: window ${q.forWindow}, ${q.rateUsdPerSiu} USD/SIU, up to ` +
            `${q.maxQuantityMilliSiu} mSIU — ` +
            (q.takenInWindow === null
              ? "not taken"
              : `taken by ${q.takenBy} in window ${q.takenInWindow}`),
        );
      }
      return lines.join("\n");
    }

    const open = this.openFor(currentWindow);
    const later = this.#quotes.filter((q) => q.forWindow > currentWindow && q.takenInWindow === null);
    if (open.length === 0 && later.length === 0) return "";
    lines.push("FORWARD TERMS OFFERED BY ISSUERS (their own numbers, listed cheapest first)");
    lines.push(
      "  These are stated prices, not binding contracts: nothing on-chain holds an issuer to one, " +
        "and a claim still mints at the published print rate. Taking one is a record of what you " +
        "chose, not a payment.",
    );
    for (const q of [...open, ...later]) {
      lines.push(
        `  ${q.quoteId}: ${q.issuer} offers up to ${q.maxQuantityMilliSiu} mSIU for window ` +
          `${q.forWindow} at ${q.rateUsdPerSiu} USD/SIU (their headroom when they quoted: ` +
          `${q.issuerHeadroomAtQuote} mSIU)`,
      );
    }
    return lines.join("\n");
  }
}
