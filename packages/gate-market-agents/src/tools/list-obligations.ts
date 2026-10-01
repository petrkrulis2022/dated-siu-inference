import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * One thing this issuer owes, or may come to owe.
 *
 * `state` is the whole point of the tool. Before 2026-10-01 an issuer learned a claim existed
 * only when the loop pushed a presentation into its prompt, which happens at
 * `presented_graded_awaiting_service` and (since the task-spec fix) at
 * `presented_awaiting_delivery`. A claim minted against its bond but not yet presented was
 * invisible: its headroom was consumed, by a holder it could not name, for work it could not
 * see, and nothing told it so.
 */
export const obligationStates = [
  /** Headroom consumed against this issuer's bond. Nobody has presented it yet, and may not. */
  "minted_not_presented",
  /** Presented. The issuer owes the work and has not yet produced a passing deliverable. */
  "presented_awaiting_delivery",
  /** Presented and graded. The issuer owes only the `serve_redemption` report. */
  "presented_graded_awaiting_service",
  /** Carried from an earlier window, never settled. Defaults against the bond when settled. */
  "carried_unsettled",
] as const;

export type ObligationState = (typeof obligationStates)[number];

export interface IssuerObligation {
  tokenId: string;
  state: ObligationState;
  quantityMilliSiu?: string;
  holder?: string;
  mintedInWindow?: number;
  /** What the holder actually asked for, when a presentation carried it. */
  taskSpecText?: string;
}

const argsSchema = z.object({
  /**
   * Spliced by the loop, never named by the agent — the caller can only ask about itself, and
   * the loop is the only thing that knows the full set. Same shape as `submit_attack`'s spliced
   * target: the agent supplies intent, the runner supplies fact.
   */
  obligations: z.array(
    z.object({
      tokenId: z.string(),
      state: z.enum(obligationStates),
      quantityMilliSiu: z.string().optional(),
      holder: z.string().optional(),
      mintedInWindow: z.number().int().optional(),
      taskSpecText: z.string().optional(),
    }),
  ),
  windowLabel: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface ObligationsResult {
  windowLabel?: string;
  obligations: IssuerObligation[];
  /** Counts by state, so an issuer can act on the summary without re-reading the list. */
  counts: Record<ObligationState, number>;
  totalOutstandingMilliSiu: string;
  /** Plain-language, because the state names alone proved not to be actionable (§4.6b). */
  summary: string;
}

/**
 * What this issuer owes right now.
 *
 * Added 2026-10-01, after the capability-gap scan (spec §4.6x) found fifteen entries across
 * seven runs in which an issuer said it had no way to list claims presented or routed to it —
 * "no tool to poll pending redemptions or confirm my issuer address without guessing",
 * "no tool to list pending claims or redemptions routed to me". The loop held every one of
 * those facts and pushed one of them, sometimes.
 *
 * §4.6y is why this is a correctness fix and not a convenience: ten claims have been minted and
 * not served across this project's runs, and re-reading every one showed that none was an issuer
 * declining to deliver. Issuer reliability is therefore unmeasured, and a run that measures
 * fulfilment while issuers cannot see their own obligations measures sight, not reliability.
 *
 * Read-only and idempotent. It costs a turn, which is the honest price of asking.
 */
export const listObligationsTool: ToolDefinition<Args, ObligationsResult> = {
  name: "list_obligations",
  argsSchema,
  async handler(_ctx, args) {
    const counts = Object.fromEntries(obligationStates.map((s) => [s, 0])) as Record<
      ObligationState,
      number
    >;
    let total = 0n;
    for (const o of args.obligations) {
      counts[o.state] += 1;
      if (o.quantityMilliSiu !== undefined) total += BigInt(o.quantityMilliSiu);
    }

    const owed = counts.presented_awaiting_delivery + counts.presented_graded_awaiting_service;
    const summary =
      args.obligations.length === 0
        ? "Nothing is outstanding against you. No claim has been minted against your bond, and nothing has been presented."
        : [
            owed > 0
              ? `${owed} claim(s) presented and awaiting you — this is work you owe now.`
              : "Nothing is presented against you right now.",
            counts.minted_not_presented > 0
              ? `${counts.minted_not_presented} claim(s) have consumed your headroom but have NOT been presented. You cannot serve what has not been presented; the holder may present later in the window, or never.`
              : "",
            counts.carried_unsettled > 0
              ? `${counts.carried_unsettled} claim(s) carried from an earlier window are still unsettled and will default against your bond when settled.`
              : "",
          ]
            .filter(Boolean)
            .join(" ");

    return {
      ...(args.windowLabel !== undefined ? { windowLabel: args.windowLabel } : {}),
      obligations: args.obligations,
      counts,
      totalOutstandingMilliSiu: total.toString(),
      summary,
    };
  },
};
