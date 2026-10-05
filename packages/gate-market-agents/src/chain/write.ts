import type { Abi, Hex, TransactionReceipt } from "viem";
import type { ChainClients } from "@touchstone/agents";

/**
 * How many times, and how far apart, a write is tried again after its gas estimation reverts.
 *
 * **Why a revert on simulation is not always the call's fault.** `writeContract` estimates gas
 * against whichever node the load-balanced public endpoint hands it, and that node may not yet have
 * seen the transaction the call depends on — a claim just transferred to the caller, an escrow just
 * opened by the payer. Found by the first live scripted run (2026-10-05, the seventh stale-read):
 * `redeem_claim` was refused "you hold none of this claim" a moment after being handed one, and
 * `reserve_for_work` "the escrow is not open" a moment after it was paid. Neither was reproducible
 * on a fork, which has one node and no lag.
 *
 * Nothing has been sent when an estimation reverts, so trying again cannot duplicate a transaction.
 * It waits for the write's effect to become readable and gives up if it never does — the same
 * principle as `untilVisible` — and when it gives up it throws the node's REAL revert, so a genuine
 * error (`ReservationExists`, a bad argument) is reported as itself, a few seconds later, not hidden.
 */
export interface RevertRetryPolicy {
  /** Tries after the first. Zero switches the retry off. */
  attempts: number;
  delayMs: number;
}

let revertRetryPolicy: RevertRetryPolicy = { attempts: 8, delayMs: 1000 };

export function setRevertRetryPolicy(policy: Partial<RevertRetryPolicy>): void {
  revertRetryPolicy = { ...revertRetryPolicy, ...policy };
}

/**
 * A contract revert raised by the node's simulation — nothing sent — as against any other failure.
 *
 * Recognised by NAME down the `cause` chain, never by `instanceof`. The loop's clients come from
 * `@touchstone/agents`, which resolves its own copy of viem, so an error they raise is not an
 * instance of THIS package's `ContractFunctionRevertedError` however much it is one: the first live
 * run with this retry in it never retried, because `instanceof` said no. A cycle in the chain is
 * tolerated rather than followed forever.
 */
function isSimulationRevert(err: unknown): boolean {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (typeof e === "object" && e !== null && !seen.has(e)) {
    seen.add(e);
    if ((e as { name?: unknown }).name === "ContractFunctionRevertedError") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

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
  let txHash: Hex | undefined;
  for (let attempt = 0; txHash === undefined; attempt++) {
    try {
      txHash = await clients.walletClient.writeContract({
        account: clients.account,
        chain: undefined,
        address: params.address,
        abi: params.abi,
        functionName: params.functionName,
        args: params.args,
      });
    } catch (err) {
      // Only an estimation revert is retried. A nonce or funds error is not lag, and a transaction
      // that was mined and reverted is handled below and is final.
      if (!isSimulationRevert(err) || attempt >= revertRetryPolicy.attempts) throw err;
      await new Promise((r) => setTimeout(r, revertRetryPolicy.delayMs));
    }
  }
  const receipt = await clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`${params.functionName} reverted on-chain (tx ${txHash}).`);
  }
  return receipt;
}
