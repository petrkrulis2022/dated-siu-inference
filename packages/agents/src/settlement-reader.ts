import { createPublicClient, decodeEventLog, http, type Hex } from "viem";
import { quoteHashHex, retryUntilConclusive, type TouchstoneQuote } from "@touchstone/sdk";
import type { OnChainSettlement, SettlementReader } from "@touchstone/mcp-server";

/**
 * A local `SettlementReader`, mirroring `@touchstone/mcp-server`'s `OnChainSettlementReader`
 * (`settlement/on-chain.ts`, live-tested against Base Sepolia in P14 step 2) — not imported
 * directly, since it isn't part of that package's public `index.ts` export surface and this step
 * doesn't touch `packages/mcp-server`. Only the read logic this demo's own local `buildApp`
 * instance needs to power a real `verify_receipt` call.
 */
const TOUCHSTONE_ESCROW_READ_ABI = [
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

export class QuoteHashMismatchError extends Error {
  constructor(onChainHash: string, recomputedHash: string) {
    super(
      `The supplied quote hashes to ${recomputedHash}, but the settlement at this transaction ` +
        `is for quoteHash ${onChainHash}.`,
    );
    this.name = "QuoteHashMismatchError";
  }
}

export interface LocalSettlementReaderOptions {
  chainName: string;
  rpcUrl: string;
  escrowAddress: string;
}

export class LocalSettlementReader implements SettlementReader {
  private readonly chainName: string;
  private readonly rpcUrl: string;
  private readonly escrowAddress: Hex;

  constructor(options: LocalSettlementReaderOptions) {
    this.chainName = options.chainName;
    this.rpcUrl = options.rpcUrl;
    this.escrowAddress = options.escrowAddress as Hex;
  }

  async read(
    chain: string,
    txHash: string,
    quote: TouchstoneQuote,
  ): Promise<OnChainSettlement | null> {
    if (chain !== this.chainName) {
      throw new Error(`This reader serves "${this.chainName}" only; got chain "${chain}".`);
    }

    const expectedHash = quoteHashHex(quote);
    const publicClient = createPublicClient({ transport: http(this.rpcUrl) });

    const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
    if (receipt.status !== "success") {
      throw new Error(`Transaction ${txHash} reverted on-chain (status "${receipt.status}").`);
    }

    let decoded: { quoteHash: Hex; actualAmount: bigint; receiptRef: Hex } | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.escrowAddress.toLowerCase()) continue;
      try {
        const event = decodeEventLog({
          abi: TOUCHSTONE_ESCROW_READ_ABI,
          data: log.data,
          topics: log.topics,
          eventName: "Settled",
        });
        decoded = event.args;
        break;
      } catch {
        // Not a Settled log — keep looking.
      }
    }
    if (!decoded) return null;

    if (decoded.quoteHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new QuoteHashMismatchError(decoded.quoteHash, expectedHash);
    }

    // Retried via @touchstone/sdk's retryUntilConclusive — see escrow-client.ts's readEscrowUntilMatch
    // for the same RPC-lag failure mode confirmed live against this exact escrow contract.
    const maxAmount = await retryUntilConclusive(
      async () => {
        const escrow = await publicClient.readContract({
          address: this.escrowAddress,
          abi: TOUCHSTONE_ESCROW_READ_ABI,
          functionName: "escrows",
          args: [decoded.quoteHash],
        });
        return escrow[5];
      },
      (value) => value > 0n,
    );
    if (maxAmount <= 0n) {
      throw new Error(`escrows(${decoded.quoteHash}) read maxAmount 0 — not a conclusive read.`);
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
