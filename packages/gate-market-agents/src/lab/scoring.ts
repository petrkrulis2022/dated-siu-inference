/**
 * Holdings and results, read from the chain, never from the loop's own books. A trader's result is its USDC,
 * plus its fSIU valued at the print, plus the credit for each need met (plan §2.8) — the arithmetic is
 * `money.ts`'s; this reads the balances and applies it.
 *
 * The balances are the chain's because the loop's ledger is deliberately not an authority on money (it
 * records what the loop saw, and a balance read straight after a write can lag, which is why `LabChain` reads
 * until two reads agree). Needs met come from the books, which the grader decides.
 */
import type { Hex } from "viem";
import { LabBooks } from "./books.js";
import { LAB_TRADERS, type LabParams, type TraderLabel } from "./economy.js";
import { resultNano } from "./money.js";
import type { LabChain } from "./operator.js";

export interface TraderHoldings {
  trader: TraderLabel;
  usdcMinor: bigint;
  fsiuMilliSiu: bigint;
  needsMet: number;
  /** Nano-USD, by `money.resultNano`. */
  resultNano: bigint;
}

export interface Snapshot {
  label: string;
  round: number;
  atChainSeconds: bigint;
  traders: TraderHoldings[];
  /**
   * What ISSUER-B holds. Every payment is a direct transfer (D30), so USDC and fSIU are conserved across the four traders
   * and the issuer together: a fee, an escrow left holding money, or a mint after the opening would show as a total that moved.
   */
  issuer: { usdcMinor: bigint; fsiuMilliSiu: bigint };
}

export async function takeSnapshot(input: {
  label: string;
  chain: LabChain;
  books: LabBooks;
  addressOf: Readonly<Record<TraderLabel, Hex>>;
  issuerAddress: Hex;
  tokenId: bigint;
  printNano: bigint;
  params: LabParams;
}): Promise<Snapshot> {
  const atChainSeconds = await input.chain.now();
  const traders = await Promise.all(
    LAB_TRADERS.map(async (trader): Promise<TraderHoldings> => {
      const usdcMinor = await input.chain.usdcBalance(input.addressOf[trader]);
      const fsiuMilliSiu = await input.chain.claimBalance(input.tokenId, input.addressOf[trader]);
      const needsMet = input.books.needsMet(trader);
      return {
        trader,
        usdcMinor,
        fsiuMilliSiu,
        needsMet,
        resultNano: resultNano({ usdcMinor, fsiuMilliSiu, needsMet }, input.printNano, input.params),
      };
    }),
  );
  const issuer = {
    usdcMinor: await input.chain.usdcBalance(input.issuerAddress),
    fsiuMilliSiu: await input.chain.claimBalance(input.tokenId, input.issuerAddress),
  };
  return { label: input.label, round: input.books.round, atChainSeconds, traders, issuer };
}

/** A snapshot with its bigints as decimal strings, which is what a JSON report can hold. */
export function snapshotToJson(s: Snapshot): unknown {
  return {
    label: s.label,
    round: s.round,
    atChainSeconds: s.atChainSeconds.toString(),
    traders: s.traders.map((t) => ({
      trader: t.trader,
      usdcMinor: t.usdcMinor.toString(),
      fsiuMilliSiu: t.fsiuMilliSiu.toString(),
      needsMet: t.needsMet,
      resultNano: t.resultNano.toString(),
    })),
    issuer: { usdcMinor: s.issuer.usdcMinor.toString(), fsiuMilliSiu: s.issuer.fsiuMilliSiu.toString() },
  };
}

/** Whether a snapshot holds exactly what the operator meant to hand out. */
export function openingMatches(s: Snapshot, usdcMinor: bigint, fsiuMilliSiu: bigint): string | undefined {
  const off = s.traders.filter((t) => t.usdcMinor !== usdcMinor || t.fsiuMilliSiu !== fsiuMilliSiu);
  if (off.length === 0) return undefined;
  return (
    `the opening is not what was handed out (expected ${usdcMinor} USDC minor units and ${fsiuMilliSiu} mSIU each): ` +
    off.map((t) => `${t.trader} holds ${t.usdcMinor} and ${t.fsiuMilliSiu}`).join("; ")
  );
}
