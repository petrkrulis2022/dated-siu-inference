import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { quoteHashHex, type DatumQuote } from "@datum/sdk";
import type { OnChainSettlement, SettlementReader } from "./reader.js";

/** Only the two members `read()` actually touches — `DatumEscrow`'s full ABI lives in
 * packages/contracts; this reader has no build-time dependency on that package (contracts sit
 * outside the pnpm workspace), so the minimal slice it needs is declared here instead. */
export const DATUM_ESCROW_ABI = [
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "quoteHash", type: "bytes32", indexed: true },
      { name: "actualAmount", type: "uint256", indexed: false },
      { name: "receiptRef", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "escrows",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "buyer", type: "address" },
      { name: "expiry", type: "uint64" },
      { name: "status", type: "uint8" },
      { name: "seller", type: "address" },
      { name: "settler", type: "address" },
      { name: "maxAmount", type: "uint256" },
    ],
  },
] as const;

/** Thrown, not swallowed into a `null` return, so a caller can never mistake "this quote does
 * not match what actually settled" for "nothing settled yet" — the two mean very different
 * things and `verify_receipt` must not paper over the distinction. */
export class QuoteHashMismatchError extends Error {
  constructor(onChainHash: string, recomputedHash: string) {
    super(
      `The supplied quote hashes to ${recomputedHash}, but the settlement at this transaction ` +
        `is for quoteHash ${onChainHash}. Refusing to attest to a settlement for a different offer.`,
    );
    this.name = "QuoteHashMismatchError";
  }
}

export interface OnChainSettlementReaderOptions {
  /** The chain name this reader serves, e.g. "base-sepolia" — matched against `read()`'s `chain`
   * argument so a caller can never be served a different network's data by mistake. */
  chainName: string;
  rpcUrl: string;
  escrowAddress: string;
}

/**
 * Reads real settlements from the deployed `DatumEscrow` (data/deployments/base-sepolia.json).
 * Stateless by design — see reader.ts's module doc for why the caller-supplied `quote` and the
 * hash check replace an off-chain quote index.
 */
export class OnChainSettlementReader implements SettlementReader {
  private readonly chainName: string;
  private readonly rpcUrl: string;
  private readonly escrowAddress: Hex;

  constructor(options: OnChainSettlementReaderOptions) {
    this.chainName = options.chainName;
    this.rpcUrl = options.rpcUrl;
    this.escrowAddress = options.escrowAddress as Hex;
  }

  async read(chain: string, txHash: string, quote: DatumQuote): Promise<OnChainSettlement | null> {
    if (chain !== this.chainName) {
      throw new Error(
        `This OnChainSettlementReader serves "${this.chainName}" only; got chain "${chain}".`,
      );
    }

    const expectedHash = quoteHashHex(quote);
    const publicClient = createPublicClient({ transport: http(this.rpcUrl) });

    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
    // A receipt exists for reverted transactions too (P13 lesson): mined is not succeeded.
    if (receipt.status !== "success") {
      throw new Error(
        `Transaction ${txHash} reverted on-chain (status "${receipt.status}") — it settled nothing.`,
      );
    }

    let decoded: { quoteHash: Hex; actualAmount: bigint; receiptRef: Hex } | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.escrowAddress.toLowerCase()) continue;
      try {
        const event = decodeEventLog({
          abi: DATUM_ESCROW_ABI,
          data: log.data,
          topics: log.topics,
          eventName: "Settled",
        });
        decoded = event.args;
        break;
      } catch {
        // Not a Settled log (or not decodable as one) — keep looking.
      }
    }
    if (!decoded) return null;

    if (decoded.quoteHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new QuoteHashMismatchError(decoded.quoteHash, expectedHash);
    }

    // settle() never clears maxAmount (confirmed by reading DatumEscrow.sol's source, not
    // assumed) — it stays readable from the escrow's own storage after settlement.
    const escrow = await publicClient.readContract({
      address: this.escrowAddress,
      abi: DATUM_ESCROW_ABI,
      functionName: "escrows",
      args: [decoded.quoteHash],
    });
    const maxAmount = escrow[5];
    if (maxAmount <= 0n) {
      throw new Error(
        `escrows(${decoded.quoteHash}) read maxAmount 0 on-chain — not a conclusive read for a ` +
          `settlement whose own event just fired. Treating as an RPC/indexing problem, not a fact.`,
      );
    }

    return {
      quoteHash: decoded.quoteHash,
      actualAmountMinorUnits: decoded.actualAmount.toString(),
      maxAmountMinorUnits: maxAmount.toString(),
      receiptRef: decoded.receiptRef,
      printRef: quote.print_id,
    };
  }
}
