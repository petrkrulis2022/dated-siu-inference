import { parseAbi, type Hex } from "viem";
import { retryUntilConclusive, type RetryUntilConclusiveOptions } from "@datum/sdk";
import type { ChainClients } from "./wallets.js";

/** No reusable write-side ABI/wrapper for `DatumEscrow` exists anywhere in the repo — the full
 * ABI lives only in the Foundry build artifact (`packages/contracts/out/`), which sits outside
 * the pnpm workspace. Same minimal hand-written-fragment approach `settlement/on-chain.ts`
 * already established for the read side. */
const DATUM_ESCROW_WRITE_ABI = parseAbi([
  "function openAndFund(bytes32 quoteHash, address seller, address settler, uint256 maxAmount, uint64 expiry) external",
  "function settle(bytes32 quoteHash, uint256 actualAmount, bytes32 receiptRef) external",
  "function escrows(bytes32) view returns (address buyer, uint64 expiry, uint8 status, address seller, address settler, uint256 maxAmount)",
]);

const USDC_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const STATUS_OPEN = 1;

export interface EscrowRead {
  buyer: Hex;
  expiry: bigint;
  status: number;
  seller: Hex;
  settler: Hex;
  maxAmount: bigint;
}

export async function readEscrow(
  clients: ChainClients,
  escrowAddress: string,
  quoteHash: string,
): Promise<EscrowRead> {
  const [buyer, expiry, status, seller, settler, maxAmount] =
    await clients.publicClient.readContract({
      address: escrowAddress as Hex,
      abi: DATUM_ESCROW_WRITE_ABI,
      functionName: "escrows",
      args: [quoteHash as Hex],
    });
  return { buyer, expiry, status, seller, settler, maxAmount };
}

/** True only for an escrow genuinely open, funded by the exact terms this quote committed to —
 * the seller's own on-chain check before doing any real work, distinct from and in addition to
 * the buyer's later cryptographic re-check via `verify_receipt`. */
export function escrowMatchesQuote(
  escrow: EscrowRead,
  expected: { seller: string; maxAmount: bigint; expiryUnix: bigint },
): boolean {
  return (
    escrow.status === STATUS_OPEN &&
    escrow.seller.toLowerCase() === expected.seller.toLowerCase() &&
    escrow.maxAmount >= expected.maxAmount &&
    escrow.expiry >= expected.expiryUnix
  );
}

/**
 * Public RPC endpoints are load-balanced across nodes at slightly different heights — see
 * `@datum/sdk`'s `retryUntilConclusive`, the shared home for this lesson (also applied to print
 * anchoring's `postedAt` reads). Confirmed live during this demo's first real run: the buyer's
 * funding transaction had genuinely succeeded (re-querying moments later showed the correct
 * funded state), but the seller's immediate, unretried read saw stale state and rejected a real,
 * already-funded escrow. Only a match is conclusive; a non-match is retried.
 */
export async function readEscrowUntilMatch(
  clients: ChainClients,
  escrowAddress: string,
  quoteHash: string,
  expected: { seller: string; maxAmount: bigint; expiryUnix: bigint },
  options: RetryUntilConclusiveOptions = {},
): Promise<EscrowRead> {
  return retryUntilConclusive(
    () => readEscrow(clients, escrowAddress, quoteHash),
    (escrow) => escrowMatchesQuote(escrow, expected),
    options,
  );
}

/** Approves (if needed) and calls `openAndFund` — the buyer's step. */
export async function openAndFund(
  buyer: ChainClients,
  usdcAddress: string,
  escrowAddress: string,
  args: {
    quoteHash: string;
    seller: string;
    settler: string;
    maxAmount: bigint;
    expiryUnix: bigint;
  },
): Promise<Hex> {
  const allowance = await buyer.publicClient.readContract({
    address: usdcAddress as Hex,
    abi: USDC_APPROVE_ABI,
    functionName: "allowance",
    args: [buyer.account.address, escrowAddress as Hex],
  });
  if (allowance < args.maxAmount) {
    const approveTx = await buyer.walletClient.writeContract({
      account: buyer.account,
      chain: undefined,
      address: usdcAddress as Hex,
      abi: USDC_APPROVE_ABI,
      functionName: "approve",
      args: [escrowAddress as Hex, args.maxAmount],
    });
    const approveReceipt = await buyer.publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (approveReceipt.status !== "success") {
      throw new Error(`USDC approve for DatumEscrow reverted on-chain.`);
    }
  }

  const txHash = await buyer.walletClient.writeContract({
    account: buyer.account,
    chain: undefined,
    address: escrowAddress as Hex,
    abi: DATUM_ESCROW_WRITE_ABI,
    functionName: "openAndFund",
    args: [
      args.quoteHash as Hex,
      args.seller as Hex,
      args.settler as Hex,
      args.maxAmount,
      args.expiryUnix,
    ],
  });
  const receipt = await buyer.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`openAndFund(${args.quoteHash}) reverted on-chain.`);
  }
  return txHash;
}

/** Calls `settle` — the seller's step. `settler = address(0)` throughout this demo (P13's
 * seller-only path, per the user's instruction), so this must be called with the seller's own
 * key. */
export async function settle(
  seller: ChainClients,
  escrowAddress: string,
  args: { quoteHash: string; actualAmount: bigint; receiptRef: string },
): Promise<Hex> {
  const txHash = await seller.walletClient.writeContract({
    account: seller.account,
    chain: undefined,
    address: escrowAddress as Hex,
    abi: DATUM_ESCROW_WRITE_ABI,
    functionName: "settle",
    args: [args.quoteHash as Hex, args.actualAmount, args.receiptRef as Hex],
  });
  const receipt = await seller.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`settle(${args.quoteHash}) reverted on-chain.`);
  }
  return txHash;
}
