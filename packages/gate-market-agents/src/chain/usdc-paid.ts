import { erc20Abi, parseEventLogs, type Hex } from "viem";

/**
 * USDC, in minor units, that left `payer` in one transaction — read from the token's own
 * `Transfer` logs in the receipt.
 *
 * **Why it is read and not computed.** `WorkClaim.mint` charges `quantity × rate ÷ 1e6`, and the
 * `Minted` event does not record what was charged. Recomputing it here would prove only that the
 * formula agrees with itself. The receipt's transfer log is what actually moved, so it is what a
 * cost figure is built from. A mint's only USDC movement from the payer is the cost itself, so the
 * sum is that cost.
 */
export function usdcPaidBy(
  receipt: { logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] },
  usdc: string,
  payer: string,
): bigint {
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs.filter((l) => l.address.toLowerCase() === usdc.toLowerCase()) as never,
  });
  return transfers
    .filter((t) => t.args.from.toLowerCase() === payer.toLowerCase())
    .reduce((sum, t) => sum + t.args.value, 0n);
}
