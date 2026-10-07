/**
 * What the lab refuses, and the sentence it refuses with. Each refusal is shown to the agent as its
 * call's error, so each says only what is so — never what to do, never which asset is better.
 *
 * Quantity and price belong to the economy, not to the buyer: a job is one SIU at the trade price, a
 * unit of raw work is one SIU at the print. The schedule decides what a trader may ask for and when
 * (plan §2.4), the same discipline the gate configuration applies to job size.
 */
import type { ToolName } from "../tools/index.js";
import { LabBooks, type Counterparty } from "./books.js";
import { type LabParams, type TraderLabel } from "./economy.js";
import { claimValueMinorUnits } from "../tools/settle-split.js";
import { decimalToUnits, jobSiu, quotedPrice, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu } from "./money.js";

export interface GuardConfig {
  printNano: bigint;
  params: LabParams;
}

const sameDecimal = (a: unknown, b: string): boolean => {
  if (typeof a !== "string") return false;
  try {
    return decimalToUnits(a, 9) === decimalToUnits(b, 9);
  } catch {
    return false;
  }
};

/** Every call that settles a quote — the ways of paying. */
const PAYING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["pay", "settle_split_held", "transfer_claim"]);

export function guardLabCall(
  books: LabBooks,
  cfg: GuardConfig,
  caller: TraderLabel | "ISSUER",
  tool: ToolName,
  rawArgs: unknown,
): string | null {
  if (tool === "request_quote") return guardRequestQuote(books, cfg, caller, rawArgs);
  if (PAYING_TOOLS.has(tool)) {
    const refusal = guardPayment(books, caller, rawArgs);
    if (refusal !== null) return refusal;
    if (tool === "settle_split_held") return guardClaimPart(books, cfg, rawArgs);
  }
  return null;
}

/**
 * A quote is paid by the trader who asked for it, once. Found by the first model run (2026-10-06): a seller
 * called `pay_with_claim` on a quote it had itself issued, which its buyer had already paid in dollars, and it
 * went through — it minted a claim and sent it to itself, and the payment was recorded against the wrong trader.
 * With direct settlement nothing on the chain stops a second payment of any kind, and nothing in the tools asks who
 * the payer is. The sentences say only what is so.
 *
 * A transfer that names no quote settles nothing and is passed on to be a plain transfer. A request id this lab
 * does not know is left to the loop's own refusal, which says there is no such quote.
 */
function guardPayment(books: LabBooks, caller: TraderLabel | "ISSUER", rawArgs: unknown): string | null {
  const id = (rawArgs as { requestId?: unknown } | undefined)?.requestId;
  if (typeof id !== "string") return null;
  const sale = books.sale(id);
  if (sale === undefined) return null;
  if (caller === "ISSUER") return "the issuer does not pay quotes.";
  if (sale.buyer !== caller) return `${id} is not yours to pay: it was asked for by ${sale.buyer}.`;
  if (!sale.quoted) return `${id} has not been quoted yet.`;
  if (sale.paid) return `${id} has already been paid.`;
  return null;
}

function guardRequestQuote(books: LabBooks, cfg: GuardConfig, caller: TraderLabel | "ISSUER", rawArgs: unknown): string | null {
  if (caller === "ISSUER") return "the issuer answers requests; it does not make them.";
  const a = (rawArgs ?? {}) as { sellerId?: unknown; siu?: unknown; rateUsdPerSiu?: unknown };
  if (typeof a.sellerId !== "string") return "request_quote needs a sellerId.";
  const seller: Counterparty | undefined = books.counterpartyOf(a.sellerId);
  if (seller === undefined) return `${a.sellerId} is not a trader or the issuer in this run.`;
  if (seller === caller) return "a job cannot be bought from yourself.";

  const size = jobSiu(cfg.params);
  if (seller === "ISSUER") {
    if (!books.mayBuyRawWork(caller)) {
      return "you owe no delivery that lacks a unit of raw work, so there is nothing to buy from the issuer.";
    }
    if (a.siu !== size && !(typeof a.siu === "string" && decimalToUnits(a.siu, 3) === BigInt(cfg.params.jobMilliSiu))) {
      return `a unit of raw work is ${size} SIU.`;
    }
    const rate = rawWorkRateUsdPerSiu(cfg.printNano);
    if (!sameDecimal(a.rateUsdPerSiu, rate)) return `raw work is sold at the published print, ${rate} USD per SIU.`;
    return null;
  }

  const open = books.openNeeds(caller).filter((n) => n.seller === seller);
  if (open.length === 0) {
    const mine = books.openNeeds(caller);
    const locked = books.economy.needs.find((n) => n.buyer === caller && n.seller === seller && books.needStatus(n) === "locked");
    return (
      `you have no open need that ${seller} can deliver. ` +
      (locked ? `Your need of ${locked.type} from ${seller} opens in round ${locked.round}. ` : "") +
      (mine.length > 0
        ? `Your open needs: ${mine.map((n) => `${n.type} from ${n.seller}`).join("; ")}.`
        : "You have no open needs now.")
    );
  }
  if (!(typeof a.siu === "string" && decimalToUnits(a.siu, 3) === BigInt(cfg.params.jobMilliSiu))) {
    return `a job is ${size} SIU.`;
  }
  const rate = tradeRateUsdPerSiu(cfg.printNano, cfg.params);
  if (!sameDecimal(a.rateUsdPerSiu, rate)) return `a job is priced at ${rate} USD per SIU.`;
  return null;
}

/**
 * The claim part of a split is a whole number of mSIU worth something at the print and less than the quote's price: at
 * either end it is not a split but one of the other two payments. Said as a fact; it does not name the other payment.
 * A request id this lab does not know is left to the loop's own refusal.
 */
function guardClaimPart(books: LabBooks, cfg: GuardConfig, rawArgs: unknown): string | null {
  const a = (rawArgs ?? {}) as { requestId?: unknown; claimQuantityMilliSiu?: unknown };
  const sale = typeof a.requestId === "string" ? books.sale(a.requestId) : undefined;
  if (sale === undefined) return null;
  const q = a.claimQuantityMilliSiu;
  if (typeof q !== "string" || !/^[1-9]\d*$/.test(q)) {
    return "the claim part of a split is a whole number of mSIU, more than 0.";
  }
  const price = quotedPrice(
    jobSiu(cfg.params),
    sale.kind === "trade" ? tradeRateUsdPerSiu(cfg.printNano, cfg.params) : rawWorkRateUsdPerSiu(cfg.printNano),
  ).minorUnits;
  const value = claimValueMinorUnits(q, cfg.printNano.toString());
  if (value === 0n || value >= price) {
    return `the claim part of a split must be worth more than nothing and less than the quote's price: ${q} mSIU is worth ${value} USDC minor units at the print, and the price is ${price}.`;
  }
  return null;
}
