import type { Hex } from "viem";
import type { TouchstoneQuote } from "@touchstone/sdk";
import { USDC_TRANSFER_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolContext } from "../deps.js";

/**
 * Direct settlement: a quote paid by a plain transfer to its seller, with no escrow in between.
 *
 * The currency lab (instrument v4, D30) settles every route this way. Through v3 a job paid in USDC sat in the
 * escrow until its seller delivered and released it, while a job paid in fSIU moved at once, so choosing an asset also
 * chose buyer protection, the seller's access to the money, a fee and a rebate. Direct settlement removes the difference:
 * both assets leave the buyer's wallet and reach the seller's at the moment of payment.
 *
 * It is a tool change and not a contract change. The escrow contract is not touched and its configuration is not
 * read; `RunnerDeps.directSettlement` selects this path, and only the lab sets it. The gate configuration still
 * opens an escrow.
 */
export function sellerAddress(quote: TouchstoneQuote, tool: string): string {
  const address = quote.seller_id.replace(/^erc8004:/, "");
  if (address === quote.seller_id || !address.startsWith("0x")) {
    throw new Error(`${tool}: expected an "erc8004:0x..." seller_id, got "${quote.seller_id}".`);
  }
  return address;
}

/** The escrow refuses a quote past its expiry when it is opened; a direct payment has no contract to say so. */
export async function refuseExpired(ctx: ToolContext, quote: TouchstoneQuote, tool: string): Promise<void> {
  const expiry = Math.floor(new Date(quote.expiry).getTime() / 1000);
  const now = Number(await ctx.deps.chainReader.currentBlockTimestamp());
  if (expiry <= now) throw new Error(`${tool}: this quote expired at ${quote.expiry}.`);
}

/**
 * USDC from the caller to `to`, confirmed. A write that needs the node to catch up is retried like every other.
 *
 * The token is the DEPLOYMENT's own USDC, not the address the quote names. The quote's address is the one the SDK fills in
 * for its chain, which on every real chain is the deployment's token; on a local devnet it is the canonical address of a chain
 * that is not there, where a `transfer` is estimated, sent and mined without moving anything. Paying the deployment's token
 * is right in the first case and the only thing that works in the second.
 */
export async function sendUsdc(ctx: ToolContext, to: string, minorUnits: bigint): Promise<string> {
  const receipt = await writeAndConfirm(ctx.clients, {
    address: ctx.deps.deployment.usdc.address as Hex,
    abi: USDC_TRANSFER_ABI,
    functionName: "transfer",
    args: [to as Hex, minorUnits],
  });
  return receipt.transactionHash;
}
