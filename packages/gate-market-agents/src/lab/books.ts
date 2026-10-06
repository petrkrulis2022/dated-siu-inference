/**
 * The lab's state: which needs are open, which jobs are sold, paid and delivered, how many units of raw
 * work each trader holds, and which round it is. Pure — it is told what happened and answers questions —
 * so every rule about the economy can be tested without a loop or a chain.
 *
 * It holds no money. Balances are the chain's; this holds the economy's own facts.
 */
import type { Economy, Need, TraderLabel } from "./economy.js";

export type Asset = "usdc" | "fsiu" | "split";
export type Counterparty = TraderLabel | "ISSUER";

export interface Sale {
  requestId: string;
  /** A job bought from a trader to meet a need, or one unit of raw work bought from the issuer. */
  kind: "trade" | "rawwork";
  buyer: TraderLabel;
  seller: Counterparty;
  needId?: string;
  quoted: boolean;
  paid: boolean;
  paidAsset?: Asset;
  /** The seller released the escrow. */
  settled: boolean;
  delivered: boolean;
  attempts: number;
}

/** Attempts a seller gets at one job: an extraction that fails does not consume the unit and may be tried again. */
export const MAX_DELIVERY_ATTEMPTS = 3;

export type NeedStatus = "locked" | "open" | "requested" | "quoted" | "paid" | "met";

export class LabBooks {
  #round = 1;
  readonly #sales = new Map<string, Sale>();
  readonly #units = new Map<TraderLabel, number>();
  readonly #met = new Set<string>();

  constructor(
    readonly economy: Economy,
    readonly ids: { traders: Readonly<Record<TraderLabel, string>>; issuer: string },
  ) {}

  get round(): number {
    return this.#round;
  }

  /** Opens the next round. False, and nothing changes, when the last round is already open. */
  advanceRound(): boolean {
    if (this.#round >= this.economy.params.rounds) return false;
    this.#round += 1;
    return true;
  }

  /** Who an `erc8004:` seller id names: a trader, the issuer, or nobody in the lab. */
  counterpartyOf(erc8004Id: string): Counterparty | undefined {
    if (erc8004Id === this.ids.issuer) return "ISSUER";
    return (Object.keys(this.ids.traders) as TraderLabel[]).find((t) => this.ids.traders[t] === erc8004Id);
  }

  // ---- what happened -------------------------------------------------------------------------

  /**
   * A request was posted. A request to a trader answers the buyer's open need of that trader's type; a
   * request to the issuer is a unit of raw work. Callers have already passed the guard, so a request that
   * matches nothing is ignored rather than invented into a sale.
   */
  requestPosted(requestId: string, buyer: TraderLabel, seller: Counterparty): void {
    if (seller === "ISSUER") {
      this.#sales.set(requestId, blank(requestId, "rawwork", buyer, seller));
      return;
    }
    const need = this.openNeeds(buyer).find((n) => n.seller === seller);
    if (need === undefined) return;
    this.#sales.set(requestId, { ...blank(requestId, "trade", buyer, seller), needId: need.id });
  }

  quoteIssued(requestId: string): void {
    const s = this.#sales.get(requestId);
    if (s) s.quoted = true;
  }

  /** A quote was paid in some asset. A paid raw-work quote credits its buyer one unit at once. */
  paid(requestId: string, asset: Asset): void {
    const s = this.#sales.get(requestId);
    if (!s || s.paid) return;
    s.paid = true;
    s.paidAsset = asset;
    if (s.kind === "rawwork") this.#units.set(s.buyer, (this.#units.get(s.buyer) ?? 0) + 1);
  }

  settled(requestId: string): void {
    const s = this.#sales.get(requestId);
    if (s) s.settled = true;
  }

  /** One attempt at a job, pass or fail. A pass consumes the seller's unit and meets the buyer's need. */
  attempted(requestId: string, passed: boolean): void {
    const s = this.#sales.get(requestId);
    if (!s) return;
    s.attempts += 1;
    if (!passed) return;
    s.delivered = true;
    if (s.seller !== "ISSUER") this.#units.set(s.seller, Math.max(0, (this.#units.get(s.seller) ?? 0) - 1));
    if (s.needId !== undefined) this.#met.add(s.needId);
  }

  // ---- what is so ----------------------------------------------------------------------------

  sale(requestId: string): Sale | undefined {
    return this.#sales.get(requestId);
  }

  allSales(): readonly Sale[] {
    return [...this.#sales.values()];
  }

  needStatus(need: Need): NeedStatus {
    if (this.#met.has(need.id)) return "met";
    const s = this.activeSaleForNeed(need.id);
    if (s) return s.paid ? "paid" : s.quoted ? "quoted" : "requested";
    return need.round > this.#round ? "locked" : "open";
  }

  activeSaleForNeed(needId: string): Sale | undefined {
    return [...this.#sales.values()].find((s) => s.needId === needId);
  }

  /** Needs a trader may buy right now: its round has opened, nothing is in flight for them, not yet met. */
  openNeeds(buyer: TraderLabel): Need[] {
    return this.economy.needs.filter((n) => n.buyer === buyer && this.needStatus(n) === "open");
  }

  /** Jobs a trader has been paid for and has not yet delivered. */
  owedBy(seller: TraderLabel): Sale[] {
    return [...this.#sales.values()].filter((s) => s.kind === "trade" && s.seller === seller && s.paid && !s.delivered);
  }

  unitsOf(trader: TraderLabel): number {
    return this.#units.get(trader) ?? 0;
  }

  /** Raw-work quotes a trader has asked for and not yet paid. */
  pendingRawWork(trader: TraderLabel): number {
    return [...this.#sales.values()].filter((s) => s.kind === "rawwork" && s.buyer === trader && !s.paid).length;
  }

  /**
   * A trader may buy a unit of raw work only while it owes more deliveries than it holds or has
   * ordered units for — so units are never stockpiled and none are left over to score (plan D9).
   */
  mayBuyRawWork(trader: TraderLabel): boolean {
    return this.owedBy(trader).length > this.unitsOf(trader) + this.pendingRawWork(trader);
  }

  needsMet(trader: TraderLabel): number {
    return this.economy.needs.filter((n) => n.buyer === trader && this.#met.has(n.id)).length;
  }

  allNeedsMet(): boolean {
    return this.economy.needs.every((n) => this.#met.has(n.id));
  }
}

function blank(requestId: string, kind: Sale["kind"], buyer: TraderLabel, seller: Counterparty): Sale {
  return { requestId, kind, buyer, seller, quoted: false, paid: false, settled: false, delivered: false, attempts: 0 };
}
