import type { NextFunction, Request, Response } from "express";
import type { Print } from "@touchstone/sdk";
import { D, commodityPrintCandidates, siuPriceFor } from "@touchstone/print";
import type { PrintDataSource } from "./print-data-source.js";
import type { ToolMiddleware } from "./paywall.js";

/**
 * The SIU price beside the USDC amount in every 402 the paid tools send (mainnet-switch, owner's
 * approval 2026-11-26).
 *
 * Each payment offer in x402's `accepts` list gets `extra.touchstone`: the same price in whole mSIU
 * at the latest Commodity print, with that print's id, date, hash and methodology identifiers
 * (../../print/src/siu-price.ts). It sits in `extra`, the protocol's per-offer extension field, under
 * its own key, so it never overwrites the fields Circle or Kite put there and standard clients
 * ignore it. Each offer is priced from its own amount, because Kite's floor makes its amount
 * differ. The figure follows the daily print, and is left out, never guessed, when no usable print
 * exists or the latest is more than 7 days old. Nothing here can stop a 402 from being sent.
 */

export interface SiuPricing {
  /** The Commodity print to price against; undefined, or a rejection, means no SIU price. */
  loadPrint(): Promise<Print | undefined>;
  /** Token decimals of the asset each offer names, by CAIP-2 network; undefined leaves that offer unpriced. */
  decimalsFor(network: string): number | undefined;
  now?: () => Date;
}

interface Offer {
  network?: unknown;
  amount?: unknown;
  extra?: Record<string, unknown>;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header: string): unknown => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

/**
 * The PAYMENT-REQUIRED header with every offer priced in mSIU, and whether every offer got one.
 * An unreadable header comes back untouched.
 */
export function priceChallengeHeader(
  header: string,
  print: Print | undefined,
  decimalsFor: (network: string) => number | undefined,
  now: Date,
): { header: string; carried: boolean } {
  let required: { accepts?: unknown };
  try {
    required = decode(header) as { accepts?: unknown };
  } catch {
    return { header, carried: false };
  }
  if (typeof required !== "object" || required === null || !Array.isArray(required.accepts)) {
    return { header, carried: false };
  }

  let priced = 0;
  const accepts = required.accepts.map((raw: unknown) => {
    const offer = raw as Offer;
    const decimals = typeof offer.network === "string" ? decimalsFor(offer.network) : undefined;
    if (decimals === undefined || typeof offer.amount !== "string" || !/^\d+$/.test(offer.amount)) {
      return raw;
    }
    const usd = new D(offer.amount).div(new D(10).pow(decimals)).toFixed();
    const siu = siuPriceFor(usd, print, now);
    if (!siu) return raw;
    priced++;
    return { ...offer, extra: { ...(offer.extra ?? {}), touchstone: siu } };
  });

  if (priced === 0) return { header, carried: false };
  return {
    header: encode({ ...required, accepts }),
    carried: priced === required.accepts.length,
  };
}

const PRICED = "touchstoneSiuPriced";

/** After a paywall ran: true or false if it sent a 402 (fully SIU-priced or not), undefined if it sent none. */
export function siuPricedFrom(req: unknown): boolean | undefined {
  return (req as Record<string, boolean | undefined>)[PRICED];
}

/** Wraps one paid tool's paywall middleware so the 402 it sends carries the SIU price. */
export function withSiuPrice(inner: ToolMiddleware, pricing: SiuPricing): ToolMiddleware {
  return async (req: Request, res: Response, next: NextFunction) => {
    let print: Print | undefined;
    try {
      print = await pricing.loadPrint();
    } catch {
      print = undefined;
    }
    const now = pricing.now ? pricing.now() : new Date();

    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: string | number | readonly string[]) => {
      if (name.toLowerCase() === "payment-required") {
        const { header, carried } = priceChallengeHeader(String(value), print, pricing.decimalsFor, now);
        (req as unknown as Record<string, boolean>)[PRICED] = carried;
        value = header;
      }
      return setHeader(name, value);
    }) as typeof res.setHeader;
    return inner(req, res, next);
  };
}

/**
 * The Commodity print of record: from the newest date with a Commodity print, the latest revision
 * that nothing supersedes. Undefined when there is none, or none loads; never throws.
 */
export async function commodityPrintOfRecord(
  source: Pick<PrintDataSource, "listPrintIds" | "loadPrintByDate">,
): Promise<Print | undefined> {
  let ids: string[];
  try {
    ids = await source.listPrintIds();
  } catch {
    return undefined;
  }
  for (const id of commodityPrintCandidates(ids)) {
    try {
      const print = await source.loadPrintByDate(id);
      if (print && !(print as { superseded_by?: unknown }).superseded_by) return print;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
