import { requestQuoteTool } from "./request-quote.js";
import { issueQuoteTool } from "./issue-quote.js";
import { payTool } from "./pay.js";
import { mintClaimTool } from "./mint-claim.js";
import { transferClaimTool } from "./transfer-claim.js";
import { payWithClaimTool } from "./pay-with-claim.js";
import { settleSplitTool } from "./settle-split.js";
import { redeemClaimTool } from "./redeem-claim.js";
import { settleWindowCloseTool } from "./settle-window-close.js";
import { settleEscrowTool } from "./settle-escrow.js";
import { reserveForWorkTool } from "./reserve-for-work.js";
import { quoteForwardTool } from "./quote-forward.js";
import { takeForwardTool } from "./take-forward.js";
import { whoamiTool } from "./whoami.js";
import { serveRedemptionTool } from "./serve-redemption.js";
import { submitJobTool } from "./submit-job.js";
import { submitAttackTool } from "./submit-attack.js";
import { getBalancesTool } from "./get-balances.js";
import { getPrintTool } from "./get-print.js";
import { checkHeadroomTool } from "./check-headroom.js";
import { listObligationsTool } from "./list-obligations.js";
import { checkDeliveryTool } from "./check-delivery.js";
import { deliverJobTool } from "./deliver-job.js";
export type { ToolDefinition } from "./types.js";

/** Spec §10's WP-4 tool list, dispatched by name — plus `submit_attack` (2026-09-27), the
 * adversary's own action, which §10 never enumerated because the adversary role in §3 had no
 * mechanism behind it until then — and `reserve_for_work` (2026-09-28), the seller's commitment
 * of bonded capacity to a dollar-paid job, which §10 never enumerated either because until then
 * the USDC route consumed no capacity at all — and `quote_forward`/`take_forward`
 * (2026-09-28), the only way in this roster for a seller to name its own price and for a buyer to
 * record acting on it, which §10 never enumerated because until then no window followed another. Deliberately no
 * `Record<string, ToolDefinition>` annotation here — each tool keeps its own precise
 * `ToolDefinition<Args, Result>` type; widening to a shared supertype would hit TypeScript's
 * contravariant parameter checking on `handler` for no benefit, since `Runner.callTool` below
 * looks each tool up by its own literal name and never needs the widened type. */
export const TOOLS = {
  request_quote: requestQuoteTool,
  issue_quote: issueQuoteTool,
  pay: payTool,
  mint_claim: mintClaimTool,
  transfer_claim: transferClaimTool,
  pay_with_claim: payWithClaimTool,
  settle_split: settleSplitTool,
  redeem_claim: redeemClaimTool,
  settle_window_close: settleWindowCloseTool,
  settle_escrow: settleEscrowTool,
  reserve_for_work: reserveForWorkTool,
  quote_forward: quoteForwardTool,
  take_forward: takeForwardTool,
  whoami: whoamiTool,
  serve_redemption: serveRedemptionTool,
  submit_job: submitJobTool,
  submit_attack: submitAttackTool,
  get_balances: getBalancesTool,
  get_print: getPrintTool,
  check_headroom: checkHeadroomTool,
  list_obligations: listObligationsTool,
  check_delivery: checkDeliveryTool,
  deliver_job: deliverJobTool,
} as const;

export type ToolName = keyof typeof TOOLS;
