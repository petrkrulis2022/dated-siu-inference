import { z } from "zod";
import { settle } from "@touchstone/agents";
import { quoteHashHex, retryUntilConclusive, usdToMinorUnits, type TouchstoneQuote } from "@touchstone/sdk";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { retryOnSimulationRevert, writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

/**
 * `settle_escrow` — the seller's own step, and the leg the USDC path was missing.
 *
 * Found live, 2026-09-27, in the first real P5 window: `pay` opens and funds an escrow against
 * the quote hash (`openAndFund`), and releasing those funds to the seller needs
 * `TouchstoneEscrow.settle`. That function existed on the contract and in
 * `@touchstone/agents`' escrow client, but was never exposed as a tool — so a buyer could pay,
 * the money would leave its wallet, and no agent in the roster had any way to move it onward.
 * The seller, seeing no balance change, correctly refused to deliver and the window deadlocked
 * with $0.0143 stranded in escrow. The fSIU path was complete end to end while the USDC path
 * could take money and never deliver it, which is a confound in any comparison between the two.
 *
 * `settler == address(0)` on every escrow this roster opens, which is the seller-only settlement
 * path — so this must be called by the seller named in the quote, and the contract enforces that
 * rather than this tool trusting it.
 *
 * `actualAmount` is genuinely the seller's own call, not spliced: §3.1 scores a worker on quote
 * accuracy (quoted versus actual), which is only a real measurement if the seller can settle for
 * less than it quoted. It is bounded by the escrow's own `maxAmount` on-chain, so the choice is
 * real but cannot exceed what the buyer committed.
 *
 * Releasing any capacity reserved against this quote happens here too, automatically, rather than
 * as its own tool. Two reasons. It is not a decision — once the job is paid for, returning the
 * issuer's headroom is right in every case, and a tool call that has only one correct answer adds
 * nothing to measure. And leaving it to the seller's judgment would mean a seller that simply
 * forgot left an issuer's capacity locked until the escrow's expiry, which would show up in the
 * run as scarcity that never actually existed.
 *
 * Between `settle` and `releaseReservation`, this reads the escrow's own status until it is
 * conclusively `settled` (`@touchstone/sdk`'s `retryUntilConclusive`) rather than trusting the
 * very next read — `releaseReservation`'s own pre-flight simulation reads that same escrow
 * status, and a public RPC's load-balanced nodes are not always mutually caught up (the same
 * family of bug `openAndFund`'s allowance re-check and `pay_with_claim`'s balance re-check both
 * already guard against): a lagging node could still see `Open` and revert
 * `ReservationNotReleasable` against an escrow that has, by every other measure, already settled.
 */
const argsSchema = z.object({
  /** The seller-signed quote this escrow was opened against — spliced by the loop from the board,
   * never reconstructed by the model, for the same reason `pay` takes the real object: a
   * hand-copied quote hashes differently and would address a different (nonexistent) escrow. */
  quote: z.custom<TouchstoneQuote>(),
  /** Decimal USD, the repo's money-string convention. Omitted settles the full quoted amount. */
  actualAmountUsd: z.string().optional(),
  receiptRef: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * What a settlement is for, in minor units. Omitted means everything the escrow holds, which is the quote's own
 * ceiling for a quote paid wholly in dollars and LESS for one paid by `settle_split`: that escrow opens for the
 * dollar leg only, and asking the contract for the full quoted amount reverts "more than the escrow holds".
 * Found by the currency lab's fork walk, 2026-10-06 — a split-paid seller could take the claim and never the
 * dollars. `held` is the escrow's own `maxAmount` read from the chain, or undefined when it could not be read, in
 * which case the quote's ceiling stands as before.
 */
export function escrowSettleAmount(input: {
  quotedMaxMinorUnits: bigint;
  heldMinorUnits?: bigint;
  actualAmountUsd?: string;
}): bigint {
  const ceiling =
    input.heldMinorUnits !== undefined && input.heldMinorUnits > 0n && input.heldMinorUnits < input.quotedMaxMinorUnits
      ? input.heldMinorUnits
      : input.quotedMaxMinorUnits;
  if (input.actualAmountUsd === undefined) return ceiling;
  const requested = BigInt(usdToMinorUnits(input.actualAmountUsd));
  if (requested > ceiling) {
    throw new Error(
      `settle_escrow: actualAmountUsd ${input.actualAmountUsd} exceeds the escrow's own maxAmount ` +
        `(${ceiling} minor units${ceiling < input.quotedMaxMinorUnits ? `, the dollar part of a quote paid partly in claims` : ""}). ` +
        "Settle for that amount or less.",
    );
  }
  return requested;
}

export const settleEscrowTool: ToolDefinition<
  Args,
  { txHash: string; settledMinorUnits: string; releaseTxHash?: string }
> = {
  name: "settle_escrow",
  argsSchema,
  async handler(ctx, args) {
    const quoteHash = quoteHashHex(args.quote) as Hex;
    let held: bigint | undefined;
    try {
      // A quote the board says was paid has an escrow, so "none" is a node that has not seen it open yet: read
      // until it has. (A node can lag a settle_split's escrow by several seconds; the lab's live walk read the
      // amount from one that had not, and asked for more than the escrow held.)
      const escrow = await retryUntilConclusive(
        () => ctx.deps.chainReader.escrowState(ctx.deps.escrowAddress as Hex, quoteHash),
        (state) => state.status !== "none",
        { attempts: 8, delayMs: 1000 },
      );
      if (escrow.status === "open") held = escrow.maxAmountMinorUnits;
    } catch {
      // Unreadable: the quote's own ceiling stands, as it always did.
    }
    const requested = escrowSettleAmount({
      quotedMaxMinorUnits: BigInt(args.quote.settlement[0].amount_max),
      ...(held !== undefined ? { heldMinorUnits: held } : {}),
      ...(args.actualAmountUsd !== undefined ? { actualAmountUsd: args.actualAmountUsd } : {}),
    });

    const txHash = await retryOnSimulationRevert({ functionName: "settle", account: ctx.clients.account.address }, () =>
      settle(ctx.clients, ctx.deps.escrowAddress, {
        quoteHash,
        actualAmount: requested,
        receiptRef: args.receiptRef,
      }),
    );

    const workClaim = ctx.deps.deployment.workClaim.address as Hex;
    await retryUntilConclusive(
      () => ctx.deps.chainReader.escrowState(ctx.deps.escrowAddress as Hex, quoteHash),
      (state) => state.status === "settled",
    );
    const reservation = await ctx.deps.chainReader.reservation(workClaim, quoteHash);
    let releaseTxHash: string | undefined;
    if (reservation.exists && !reservation.released) {
      const receipt = await writeAndConfirm(ctx.clients, {
        address: workClaim,
        abi: WORK_CLAIM_ABI,
        functionName: "releaseReservation",
        args: [quoteHash],
      });
      releaseTxHash = receipt.transactionHash;
    }

    return { txHash, settledMinorUnits: requested.toString(), releaseTxHash };
  },
};
