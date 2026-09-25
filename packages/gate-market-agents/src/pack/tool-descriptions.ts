import type { ToolName } from "../tools/index.js";

/**
 * Hand-written to match each tool's own real zod schema exactly (`tools/*.ts`) — deliberately
 * not auto-generated from zod internals, since a short, hand-verified list is more reliable than
 * fragile schema introspection for 12 tools. `tool-descriptions.test.ts` is the drift guard: it
 * asserts every key in the real `TOOLS` registry has an entry here, so adding a 13th tool without
 * updating this file fails a test rather than silently shipping an incomplete pack.
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  request_quote:
    "request_quote(siu, model, rateUsdPerSiu, indexVersion, printId, printHash, sellerId, chain, expiresInSeconds, pattern, siuMax?) -> an unsigned quote body",
  issue_quote: "issue_quote(quoteBody) -> a signed touchstone-quote",
  pay: "pay(quote, settler) -> opens and funds escrow for a signed quote, returns a tx hash",
  mint_claim:
    "mint_claim(classId, quantity, windowFrom, windowTo, printId, nanoUsdPerSiu, validUntil, signature) -> mints a claim, routed to an issuer with headroom, returns tokenId + the routed issuer",
  transfer_claim: "transfer_claim(to, tokenId, quantity) -> free ERC-1155 transfer",
  redeem_claim:
    "redeem_claim(tokenId, taskSpecHash) -> presents your claim for redemption inside its window",
  settle_window_close:
    "settle_window_close(tokenId, holder, printId, nanoUsdPerSiu, validUntil, signature) -> settles a closed window (Defaulted or Expired), permissionless; the rate attestation is only checked when the window Defaulted",
  serve_redemption:
    "serve_redemption(tokenId, holder, quantity, passed, receiptRef) -> issuer-only: reports a redemption's outcome",
  submit_job:
    "submit_job(taskClass, originalGate, hardenedGate, referenceInstance, knownGoodSubmission, adversarialSubmissions, heldOutInstances) -> runs the real G1-G6 checks",
  get_balances:
    "get_balances(account, tokenIds?) -> real USDC balance (decimal and integer minor-unit forms) plus claim balances",
  get_print: "get_print(printId) -> the real print body plus whether it's final",
  check_headroom: "check_headroom(issuer, classId) -> real headroom and issuance limit, in mSIU",
};

export function formatToolList(): string {
  return Object.values(TOOL_DESCRIPTIONS).join("\n");
}
