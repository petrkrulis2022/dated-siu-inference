import { z } from "zod";
import { decodeEventLog, type Hex } from "viem";
import { quoteHashHex, usdToMinorUnits, type TouchstoneQuote } from "@touchstone/sdk";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";
import { resolveClassId } from "./class-id.js";

/**
 * `reserve_for_work` — the seller's commitment of real bonded capacity to a dollar-paid job.
 *
 * Exists because scarcity was one-sided. Before this, minting a claim consumed an issuer's
 * bonded headroom and paying in USDC consumed nothing at all, so an agent offered "pay in claims
 * or pay in dollars" was really being offered "accept a constraint or don't". Verified live in
 * the first real P5 window: ISSUER-A's headroom was untouched across an entire USDC purchase.
 * Any asset-choice measurement taken against that setup is measuring the asymmetry, not the
 * preference. `WorkClaim.reserveForWork` puts both routes on one finite pool; this tool is how a
 * seller reaches it.
 *
 * Seller-called, and only the seller: the contract requires `msg.sender` to be the named seller
 * of a currently-Open escrow for this quote hash. That tie is what makes consuming someone
 * else's capacity impossible to do for free — reserving costs the caller nothing directly, so
 * without it anyone could lock an issuer's whole pool.
 *
 * Disclosed asymmetry, not papered over: a reservation is not a claim. A claim reserves capacity
 * for a future delivery window and is transferable; this reserves it for immediate work and is
 * not. One pool, two instruments — and on this route the issuer is not paid for the commitment,
 * which is a real gap left open deliberately rather than papered over with an invented fee.
 */
const argsSchema = z.object({
  /** The signed quote the buyer's escrow was opened against — spliced by the loop from the
   * board, never reconstructed by the model, for the same reason `settle_escrow` takes the real
   * object: a rebuilt quote hashes differently and would address a different escrow. */
  quote: z.custom<TouchstoneQuote>(),
  /** Task class, as `check_headroom` reports it — the pool this work will draw from. */
  classId: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface ReserveForWorkResult {
  txHash: string;
  quoteHash: string;
  /** Whichever issuer `ClaimRouter` picked — the same router a mint would have gone through. */
  issuer: string;
  /** mSIU actually committed. */
  quantity: string;
  /** Unix seconds. The escrow's own expiry: past it the escrow can no longer settle, so the work
   * can no longer be paid for, and anyone may release the reservation. */
  deadline: string;
}

/** mSIU per SIU — the integer unit `CapacityBond` keys headroom in. */
const MILLI_SIU_DECIMALS = 3;

/**
 * The worst case the job could take, not the point estimate — `siu_max` when the quote carries
 * one. Same reasoning as `buildQuoteBody`'s own `amount_usd_max`: capacity has to be there for
 * the work actually performed, and a reservation sized to the optimistic case would let a job
 * overrun into headroom that was never set aside for it.
 *
 * Converted through `usdToMinorUnits`, the repo's one decimal-string-to-integer-units helper,
 * rather than multiplying here: it already rounds up, which is the bias a cap needs, and the
 * whole point of that helper is that this conversion never gets written twice.
 */
export function reservationQuantityMilliSiu(quote: TouchstoneQuote): bigint {
  const siu = quote.siu_max ?? quote.siu;
  const quantity = BigInt(usdToMinorUnits(siu, MILLI_SIU_DECIMALS));
  if (quantity <= 0n) {
    throw new Error(`reserve_for_work: quote covers no work (siu ${siu}).`);
  }
  return quantity;
}

export const reserveForWorkTool: ToolDefinition<Args, ReserveForWorkResult> = {
  name: "reserve_for_work",
  argsSchema,
  async handler(ctx, args) {
    const quoteHash = quoteHashHex(args.quote);
    const quantity = reservationQuantityMilliSiu(args.quote);

    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "reserveForWork",
      args: [quoteHash, resolveClassId(args.classId), quantity],
    });

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: WORK_CLAIM_ABI, ...log });
        if (decoded.eventName === "WorkReserved") {
          return {
            txHash: receipt.transactionHash,
            quoteHash,
            issuer: decoded.args.issuer,
            quantity: decoded.args.quantity.toString(),
            deadline: decoded.args.deadline.toString(),
          };
        }
      } catch {
        // Not a WorkReserved log — the same transaction also emits the bond's HeadroomConsumed.
      }
    }
    throw new Error(
      `reserve_for_work: reserved in ${receipt.transactionHash} but found no WorkReserved event. ` +
        "The reservation exists on-chain; read it back with check_headroom.",
    );
  },
};
