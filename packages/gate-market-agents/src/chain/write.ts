import type { Abi, Hex, TransactionReceipt } from "viem";
import type { ChainClients } from "@touchstone/agents";

/** Shared write-then-confirm shape every WorkClaim-writing tool needs — `chain: undefined`
 * matches `packages/agents/src/wallets.ts`/`escrow-client.ts`'s own established pattern for a
 * viem `WalletClient` constructed with a fixed account already. Throws on revert rather than
 * returning a status the caller might forget to check. Returns the full receipt (not just the
 * tx hash) so a caller like `mint_claim` can decode an emitted event — `WorkClaim.mint`'s
 * `tokenId` return value isn't otherwise observable, since `ClaimRouter` only decides the
 * routed issuer (and therefore the tokenId) at mint time. */
export async function writeAndConfirm(
  clients: ChainClients,
  params: {
    address: Hex;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
  },
): Promise<TransactionReceipt> {
  const txHash = await clients.walletClient.writeContract({
    account: clients.account,
    chain: undefined,
    address: params.address,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
  });
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`${params.functionName} reverted on-chain (tx ${txHash}).`);
  }
  return receipt;
}
