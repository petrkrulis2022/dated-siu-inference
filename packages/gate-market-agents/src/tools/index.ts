import { requestQuoteTool } from "./request-quote.js";
import { issueQuoteTool } from "./issue-quote.js";
import { payTool } from "./pay.js";
import { mintClaimTool } from "./mint-claim.js";
import { transferClaimTool } from "./transfer-claim.js";
import { redeemClaimTool } from "./redeem-claim.js";
import { settleWindowCloseTool } from "./settle-window-close.js";
import { serveRedemptionTool } from "./serve-redemption.js";
import { submitJobTool } from "./submit-job.js";
import { getBalancesTool } from "./get-balances.js";
import { getPrintTool } from "./get-print.js";
import { checkHeadroomTool } from "./check-headroom.js";
export type { ToolDefinition } from "./types.js";

/** The 10 tools of spec §10's WP-4 list, dispatched by name. Deliberately no
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
  redeem_claim: redeemClaimTool,
  settle_window_close: settleWindowCloseTool,
  serve_redemption: serveRedemptionTool,
  submit_job: submitJobTool,
  get_balances: getBalancesTool,
  get_print: getPrintTool,
  check_headroom: checkHeadroomTool,
} as const;

export type ToolName = keyof typeof TOOLS;
