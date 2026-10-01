import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * Where one claim this agent holds (or held) has got to.
 *
 * The mirror of `list_obligations`: that one answers an issuer's "what do I owe?", this one
 * answers a holder's "did I get it?". Both exist because the loop knew and the agent could not
 * ask.
 */
export const deliveryStates = [
  /** Held, in window, never presented. Nothing is owed to this holder until it presents. */
  "not_presented",
  /** Presented. The issuer owes the work and has not yet reported a result. */
  "presented_awaiting_issuer",
  /** The issuer called serve_redemption and reported a PASS. The work was delivered. */
  "served_passed",
  /** The issuer called serve_redemption and reported a FAIL. Delivered, and it did not pass. */
  "served_failed",
  /** The window closed with the claim unserved. It defaults against the issuer's bond. */
  "window_closed_unserved",
] as const;

export type DeliveryState = (typeof deliveryStates)[number];

export interface DeliveryStatus {
  tokenId: string;
  state: DeliveryState;
  issuer?: string;
  quantityMilliSiu?: string;
  /** Seconds until this claim's window closes, when it is still open. */
  timeToExpirySeconds?: number;
}

const argsSchema = z.object({
  /**
   * Spliced by the loop, never named by the agent — it answers about the caller's own claims,
   * and only the loop knows the full set. Same shape as `list_obligations`.
   */
  claims: z.array(
    z.object({
      tokenId: z.string(),
      state: z.enum(deliveryStates),
      issuer: z.string().optional(),
      quantityMilliSiu: z.string().optional(),
      timeToExpirySeconds: z.number().optional(),
    }),
  ),
  windowLabel: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DeliveryResult {
  windowLabel?: string;
  claims: DeliveryStatus[];
  counts: Record<DeliveryState, number>;
  summary: string;
}

/**
 * Has the issuer actually served what I paid for?
 *
 * Added 2026-10-01. WORKER-CODE asked for exactly this, in its own friction log, in run 13:
 *
 *     "No tool exists to check whether the issuer has actually served the redeemed claim"
 *
 * It had redeemed a claim and wanted to confirm delivery. Nothing did that, so it called
 * `get_balances` nine times as the nearest proxy, bought nothing across three windows, and read
 * from the outside as a buyer declining to buy (spec §4.6w). That reading would have sent us to
 * rewrite its brief and bury a missing capability while appearing to fix it.
 *
 * The reason this is a correctness fix and not a convenience is F1. A buyer that cannot check
 * whether work it paid for arrived is not choosing between assets on their merits — it is
 * guessing, and fSIU is the asset whose settlement it cannot verify. Measuring asset preference
 * against that asymmetry measures the asymmetry.
 *
 * Read-only. It costs a turn, like any other call.
 */
export const checkDeliveryTool: ToolDefinition<Args, DeliveryResult> = {
  name: "check_delivery",
  argsSchema,
  async handler(_ctx, args) {
    const counts = Object.fromEntries(deliveryStates.map((s) => [s, 0])) as Record<
      DeliveryState,
      number
    >;
    for (const c of args.claims) counts[c.state] += 1;

    const summary =
      args.claims.length === 0
        ? "You hold no claims this window, and none of yours has been presented. There is nothing to check."
        : [
            counts.served_passed > 0
              ? `${counts.served_passed} claim(s) served with a PASS — that work was delivered.`
              : "",
            counts.served_failed > 0
              ? `${counts.served_failed} claim(s) served with a FAIL — the issuer reported, and the work did not pass.`
              : "",
            counts.presented_awaiting_issuer > 0
              ? `${counts.presented_awaiting_issuer} claim(s) presented and NOT yet served. The issuer owes you this; it has not reported.`
              : "",
            counts.not_presented > 0
              ? `${counts.not_presented} claim(s) you hold have not been presented. Nothing is owed to you until you present them with redeem_claim.`
              : "",
            counts.window_closed_unserved > 0
              ? `${counts.window_closed_unserved} claim(s) whose window closed unserved. These default against the issuer's bond, and the bond pays you.`
              : "",
          ]
            .filter(Boolean)
            .join(" ");

    return {
      ...(args.windowLabel !== undefined ? { windowLabel: args.windowLabel } : {}),
      claims: args.claims,
      counts,
      summary,
    };
  },
};
