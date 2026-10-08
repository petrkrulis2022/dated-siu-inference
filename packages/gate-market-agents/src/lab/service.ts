/**
 * The currency lab's service: the loop's lab hooks and the `deliver_job` backend in one object, over the
 * lab's books. It is told what each tool call did, vets each call's arguments, runs the work, and opens each
 * round when the last has gone quiet. Every payment is a direct transfer (D30), so there is no escrow to
 * release and no fee to give back.
 *
 * Operator-side throughout. Nothing here is shown to an agent except through the board (`board.ts`), the
 * refusals (`guards.ts`) and `deliver_job`'s result — and none of those names an asset or advises.
 */
import type { LabHooks, LabToolEvent } from "../loop/lab-hooks.js";
import { QuoteBoard, type QuoteBoardIssuedQuote, type QuoteBoardRequest } from "../loop/quote-board.js";
import type { LabService as DeliverService } from "../deps.js";
import type { AgentId } from "../identity/resolve.js";
import type { ToolName } from "../tools/index.js";
import { LabBooks, MAX_DELIVERY_ATTEMPTS, type Asset } from "./books.js";
import { ISSUER_SEAT, LAB_ALIASES, LAB_TRADERS, labDisplayName, traderForSeat, type TraderLabel } from "./economy.js";
import { guardLabCall, type GuardConfig } from "./guards.js";
import { renderLabAction, renderLabInfo } from "./board.js";
import { priceMilliSiu, quoteTerms } from "./money.js";
import { fmt, quoteSentenceFor } from "./quote-text.js";
import { FIXED_ROUTE_ORDER, type RouteOrder } from "./route-order.js";
import { claimValueMinorUnits } from "../tools/settle-split.js";
import { LAB_TOOL_DESCRIPTIONS, resolveLabCall, rewriteLabText } from "./tools.js";
import { jobFor, type WorkExecutor } from "./jobs.js";

export interface LabServiceDeps {
  books: LabBooks;
  guard: GuardConfig;
  seed: number;
  /** Performs and grades a job on behalf of its seller. */
  executorFor: (trader: TraderLabel) => WorkExecutor;
  /** Real cost of a work execution, decimal USD, for the run's own ledger. */
  recordWorkCost?: (usd: string) => void;
  /** Called after a round opens, e.g. to take a snapshot of every trader's holdings. */
  onRoundOpened?: (round: number) => Promise<void>;
  /** The one token every trader holds: what a payment from a held balance gives. */
  tokenId: string;
  /**
   * A trader's confirmed holdings, read from the chain. With it, a payment the trader cannot afford is refused before
   * anything is sent, in one sentence that states the whole wallet whichever asset the payment is in. Without it (a test) every payment goes to the chain.
   */
  holdings?: (trader: TraderLabel) => Promise<{ usdcMinor: bigint; fsiuMilliSiu: bigint }>;
  /** The run's seeded order of routes and assets (D50). Defaults to the fixed one, for a test with no seed. */
  order?: RouteOrder;
  /**
   * What every trader opens with. From it the service keeps each trader's wallet itself, moving it by exactly what each payment moves (the
   * quote's dollars, its price in mSIU, or a split's two parts), and shows that wallet on every turn (D50). Without it no holdings line is shown.
   *
   * It is kept here and not read from the chain on each turn because a balance read straight after a write can lag, and a figure shown to an agent that
   * is stale is worse than none; the chain's balance is read every time (`readUntilStable`, which waits a block) and each such read adds about four
   * seconds to a turn. The runner checks the kept wallet against the chain at every snapshot, and a run whose shown holdings ever disagreed with it
   * is not countable (`holdingsShownAgreed`).
   */
  opening?: { usdcMinor: bigint; fsiuMilliSiu: bigint };
  /** Called with what each trader was shown of its own wallet this turn, so a report can state it. */
  onHoldingsShown?: (trader: TraderLabel, round: number, held: { usdcMinor: bigint; fsiuMilliSiu: bigint }) => void;
}

/**
 * The quote board exactly as a lab run builds it: one place, so a run, the scripted traders' tests, the issuer service's tests and the comprehension
 * probe all read the same lines. A request or a quote reads as the lab writes it, in SIU (D50), and a requester is shown by its label, never its seat.
 * The issuer service and the scripted traders read these lines; an option set only in `lab/run.ts` would leave their tests reading a board no run builds
 * (the first v8 walk found the issuer waiting on lines in the old form).
 */
export function labQuoteBoard(service: Pick<LabService, "describeRequest" | "describeQuote">): QuoteBoard {
  return new QuoteBoard({
    reservationStep: false,
    displayName: labDisplayName,
    requestIdFirst: true,
    escrow: false,
    describeRequest: (r) => service.describeRequest(r),
    describeQuote: (i) => service.describeQuote(i),
  });
}

export type LabOperatorAction = { kind: "round_opened"; round: number };

export interface WorkLogEntry {
  requestId: string;
  seller: TraderLabel;
  buyer: TraderLabel;
  attempt: number;
  passed: boolean;
  reason?: string;
  costUsd: string;
}

const PAYMENT_ASSET: Partial<Record<ToolName, Asset>> = {
  pay: "usdc",
  transfer_claim: "fsiu",
  settle_split_held: "split",
};

export class LabService implements LabHooks, DeliverService {
  readonly operatorActions: LabOperatorAction[] = [];
  readonly workLog: WorkLogEntry[] = [];
  /** What each successful call came to, by agent and turn, for the report's decisions (`lab/decisions.ts`). */
  readonly #events = new Map<string, LabToolEvent>();
  /** Each trader's wallet as the payments have moved it, from the opening (`LabServiceDeps.opening`). */
  readonly #wallet = new Map<TraderLabel, { usdcMinor: bigint; fsiuMilliSiu: bigint }>();
  /** Trader labels an agent may use in a call's own arguments (`LabHooks.aliases`). */
  readonly aliases = LAB_ALIASES;

  constructor(private readonly d: LabServiceDeps) {
    if (d.opening !== undefined) for (const t of LAB_TRADERS) this.#wallet.set(t, { ...d.opening });
  }

  /** What a trader holds by the lab's own account, or undefined where the service was given no opening. A copy: nothing outside moves it. */
  walletOf(trader: TraderLabel): { usdcMinor: bigint; fsiuMilliSiu: bigint } | undefined {
    const w = this.#wallet.get(trader);
    return w === undefined ? undefined : { ...w };
  }

  /**
   * Moves the payer's wallet and the payee's by what a payment moved: a payment in USDC the quote's dollars, in claims its price in mSIU, a split its
   * claim part and the rest of the dollars (the quote's less the claim part's value at the print it was priced at, rounded down — the same sum the tool
   * does). The issuer's wallet is not shown to anyone and is not kept.
   */
  #settle(tool: ToolName, requestId: string, intentArgs: unknown): void {
    const { books } = this.d;
    const sale = books.sale(requestId);
    if (sale === undefined) return;
    const payer = this.#wallet.get(sale.buyer);
    if (payer === undefined) return;
    const p = books.printForSale(requestId) ?? this.d.guard.printNano;
    const terms = quoteTerms(sale.kind, p, this.d.guard.params);
    let usdc = 0n;
    let fsiu = 0n;
    if (tool === "pay") usdc = terms.minorUnits;
    else if (tool === "transfer_claim") fsiu = terms.milliSiu;
    else if (tool === "settle_split_held") {
      const q = (intentArgs as { claimQuantityMilliSiu?: unknown } | undefined)?.claimQuantityMilliSiu;
      if (typeof q !== "string" || !/^[1-9]\d*$/.test(q)) return;
      fsiu = BigInt(q);
      usdc = terms.minorUnits - claimValueMinorUnits(q, p.toString());
    } else return;
    payer.usdcMinor -= usdc;
    payer.fsiuMilliSiu -= fsiu;
    const payee = sale.seller === "ISSUER" ? undefined : this.#wallet.get(sale.seller);
    if (payee !== undefined) {
      payee.usdcMinor += usdc;
      payee.fsiuMilliSiu += fsiu;
    }
  }

  #who(agentId: AgentId): TraderLabel | "ISSUER" | undefined {
    if (agentId === ISSUER_SEAT) return "ISSUER";
    return traderForSeat(agentId);
  }

  // ---- LabHooks -----------------------------------------------------------------------------

  /**
   * The turn's information: the schedule, the prices in SIU, and what the trader holds, in both assets (D50), by the lab's own account of the wallet
   * (`LabServiceDeps.opening`). Without an opening the line is left out; a wallet is never guessed.
   */
  async infoTextFor(agentId: AgentId): Promise<string> {
    const me = traderForSeat(agentId);
    if (me === undefined) return "";
    const held = this.walletOf(me);
    if (held !== undefined) this.d.onHoldingsShown?.(me, this.d.books.round, held);
    return renderLabInfo(this.d.books, this.d.guard, me, { order: this.#order, ...(held !== undefined ? { held } : {}) });
  }

  get #order(): RouteOrder {
    return this.d.order ?? FIXED_ROUTE_ORDER;
  }

  /** What follows its id on a seller's line for an open request: the work, who asked, what it is priced at and settles for (D50). */
  describeRequest(r: QuoteBoardRequest): string | undefined {
    return quoteSentenceFor(this.d.books, this.d.guard.params, this.#order, r.requestId, (s) => `asked for by ${s.buyer}`, "", this.d.guard.printNano);
  }

  /** The same for a quote a buyer has received, with the seller and when it expires. */
  describeQuote(i: QuoteBoardIssuedQuote): string | undefined {
    return quoteSentenceFor(
      this.d.books,
      this.d.guard.params,
      this.#order,
      i.requestId,
      (s) => `from ${s.seller === "ISSUER" ? ISSUER_SEAT : s.seller}`,
      `, expires ${i.quote.expiry}`,
      this.d.guard.printNano,
    );
  }

  actionTextFor(agentId: AgentId): string {
    const me = traderForSeat(agentId);
    return me === undefined ? "" : renderLabAction(this.d.books, me);
  }

  async guard(agentId: AgentId, tool: ToolName, rawArgs: unknown): Promise<string | null> {
    const who = this.#who(agentId);
    if (who === undefined) return null;
    const refusal = guardLabCall(this.d.books, this.d.guard, who, tool, rawArgs);
    if (refusal !== null) return refusal;
    if (who === "ISSUER" || this.d.holdings === undefined) return null;
    return this.#affordability(who, tool, rawArgs);
  }

  // ---- the lab's names for its tools ---------------------------------------------------------

  toolDescription(tool: ToolName): string | undefined {
    return LAB_TOOL_DESCRIPTIONS[tool];
  }

  resolveCall(_agentId: AgentId, name: string, args: unknown) {
    return resolveLabCall(
      {
        sellerNameOf: (id) => {
          const sale = this.d.books.sale(id);
          return sale === undefined ? undefined : sale.seller === "ISSUER" ? ISSUER_SEAT : sale.seller;
        },
        tokenId: this.d.tokenId,
        printIdNow: () => this.d.books.currentPrintId(),
      },
      name,
      args,
    );
  }

  /**
   * The print a quote was asked for at, which sizes a claim paid against it (D41). A quote keeps the price it was asked for at,
   * so paying it later, in either asset, costs what it cost then; a claim is sized at that round's print and not the current one.
   */
  printForQuote(requestId: string): bigint | undefined {
    return this.d.books.printForSale(requestId);
  }

  /** A quote is priced in SIU, so the claim that pays it is that price in mSIU, at every print (D50). */
  claimForQuote(requestId: string): bigint | undefined {
    const sale = this.d.books.sale(requestId);
    return sale === undefined ? undefined : priceMilliSiu(sale.kind, this.d.guard.params);
  }

  rewriteText(text: string): string {
    return rewriteLabText(text);
  }

  /**
   * What a payment costs against what the wallet holds — confirmed reads, one sentence, the same form whichever asset it is
   * paid in and whichever is short: the cost, then the whole wallet, both assets (D33). A fact, symmetric, with no advice
   * about what to do. A payment the trader cannot afford is refused here, before it is sent, so it neither reaches the chain
   * nor is retried as though the node were lagging; a payment this lets through that the chain then refuses is a stale
   * balance, and the loop's own retry is the right answer to that.
   */
  async #affordability(me: TraderLabel, tool: ToolName, rawArgs: unknown): Promise<string | null> {
    const a = (rawArgs ?? {}) as { requestId?: unknown; claimQuantityMilliSiu?: unknown };
    if (typeof a.requestId !== "string") return null;
    const sale = this.d.books.sale(a.requestId);
    if (sale === undefined) return null;
    // The quote's own round's print, not the current one (D41).
    const p = this.d.books.printForSale(a.requestId) ?? this.d.guard.printNano;
    const price = quoteTerms(sale.kind, p, this.d.guard.params);
    let usdcCost = 0n;
    let claimCost = 0n;
    if (tool === "pay") {
      usdcCost = price.minorUnits;
    } else if (tool === "transfer_claim") {
      claimCost = price.milliSiu;
    } else if (tool === "settle_split_held") {
      // A malformed or out-of-range claim part is the guard's to refuse (`guards.ts`); it never reaches here.
      if (typeof a.claimQuantityMilliSiu !== "string" || !/^[1-9]\d*$/.test(a.claimQuantityMilliSiu)) return null;
      claimCost = BigInt(a.claimQuantityMilliSiu);
      usdcCost = price.minorUnits - claimValueMinorUnits(a.claimQuantityMilliSiu, p.toString());
    } else {
      return null;
    }
    const held = await this.d.holdings!(me);
    if (held.usdcMinor >= usdcCost && held.fsiuMilliSiu >= claimCost) return null;
    const costs = [
      ...(usdcCost > 0n ? [`${fmt(usdcCost)} USDC minor units`] : []),
      ...(claimCost > 0n ? [`${fmt(claimCost)} mSIU of fSIU`] : []),
    ].join(" and ");
    return `This payment costs ${costs}; the wallet holds ${fmt(held.usdcMinor)} USDC minor units and ${fmt(held.fsiuMilliSiu)} mSIU of fSIU.`;
  }

  /** The lab's own record of a successful call: the request it posted, and what the tool returned. */
  eventAt(agentId: string, turn: number): { requestId?: string; result?: unknown } | undefined {
    const e = this.#events.get(`${agentId}#${turn}`);
    return e === undefined ? undefined : { ...(e.requestId !== undefined ? { requestId: e.requestId } : {}), result: e.result };
  }

  async afterToolCall(e: LabToolEvent): Promise<void> {
    this.#events.set(`${e.agentId}#${e.turn}`, e);
    const who = this.#who(e.agentId);
    if (who === undefined) return;
    const { books } = this.d;

    if (e.tool === "request_quote" && e.requestId !== undefined && who !== "ISSUER") {
      const sellerId = (e.result as { seller_id?: string } | undefined)?.seller_id;
      const seller = sellerId === undefined ? undefined : books.counterpartyOf(sellerId);
      if (seller !== undefined) books.requestPosted(e.requestId, who, seller);
      return;
    }

    if (e.tool === "issue_quote") {
      const requestId = (e.intentArgs as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string") books.quoteIssued(requestId);
      return;
    }

    const asset = PAYMENT_ASSET[e.tool];
    if (asset !== undefined) {
      // A transfer that names no quote settles nothing and is not a payment.
      const requestId = (e.intentArgs as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string") {
        // The wallets move only for a payment the books accepted: a second payment of one quote is refused before it runs, and a request the lab does not know moves nothing.
        const sale = books.sale(requestId);
        const wasPaid = sale?.paid === true;
        books.paid(requestId, asset);
        if (sale !== undefined && !wasPaid) this.#settle(e.tool, requestId, e.intentArgs);
      }
      return;
    }
  }

  async advanceRound(): Promise<boolean> {
    const opened = this.d.books.advanceRound();
    if (opened) {
      this.operatorActions.push({ kind: "round_opened", round: this.d.books.round });
      await this.d.onRoundOpened?.(this.d.books.round);
    }
    return opened;
  }

  // ---- deliver_job --------------------------------------------------------------------------

  async deliverJob(caller: AgentId, requestId: string): Promise<unknown> {
    const { books } = this.d;
    const me = traderForSeat(caller);
    if (me === undefined) throw new Error("deliver_job: only a trader delivers jobs.");
    const sale = books.sale(requestId);
    if (sale === undefined) throw new Error(`deliver_job: there is no request ${requestId}.`);
    if (sale.kind !== "trade") throw new Error(`deliver_job: ${requestId} is not a job; it is a unit of raw work.`);
    if (sale.seller !== me) throw new Error(`deliver_job: ${requestId} is not a job you sold.`);
    if (!sale.paid) throw new Error(`deliver_job: ${requestId} has not been paid yet.`);
    if (sale.delivered) throw new Error(`deliver_job: ${requestId} has already been delivered.`);
    if (sale.attempts >= MAX_DELIVERY_ATTEMPTS) {
      throw new Error(`deliver_job: ${requestId} has had its ${MAX_DELIVERY_ATTEMPTS} attempts.`);
    }
    if (books.unitsOf(me) < 1) throw new Error("deliver_job: you hold no unit of raw work, and delivering uses one.");
    const need = books.economy.needs.find((n) => n.id === sale.needId);
    if (need === undefined) throw new Error(`deliver_job: ${requestId} answers no need.`);

    const result = await this.d.executorFor(me)(jobFor(this.d.seed, need));
    this.d.recordWorkCost?.(result.costUsd);
    books.attempted(requestId, result.passed);
    this.workLog.push({
      requestId,
      seller: me,
      buyer: sale.buyer,
      attempt: sale.attempts,
      passed: result.passed,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      costUsd: result.costUsd,
    });
    return result.passed
      ? { delivered: true, requestId, buyer: sale.buyer, unitsLeft: books.unitsOf(me) }
      : {
          delivered: false,
          requestId,
          reason: result.reason ?? "the output did not match the record",
          attemptsLeft: MAX_DELIVERY_ATTEMPTS - sale.attempts,
        };
  }
}
