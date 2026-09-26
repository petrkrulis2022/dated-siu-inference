import type { ToolName } from "../tools/index.js";

/**
 * Hand-written to match what a model calling *through this loop* actually needs to provide, not
 * always each tool's own raw zod schema (`tools/*.ts`) — `loop/full-run.ts`'s `buildToolArgs`
 * splices in whatever a model cannot or should not invent itself (a real signature, a real
 * cryptographic rate attestation, the exact seller-signed quote object a request already
 * received) before the real tool ever sees the call, exactly like `submit_job`'s own fixed
 * envelope. Describing the raw schema instead — found live, 2026-09-26, P5 planning: the
 * previous `pay(quote, settler)`/`issue_quote(quoteBody)`/`mint_claim(classId, quantity,
 * windowFrom, windowTo, printId, nanoUsdPerSiu, validUntil, signature)` entries told a model to
 * reconstruct exactly the things `buildToolArgs` exists to splice instead, which a real model
 * cannot produce correctly (it has no publisher key, and no way to reconstruct a seller's exact
 * signed bytes) — would derail the real ORCHESTRATOR delegation/asset-choice test with a
 * self-inflicted, purely documentary failure. `tool-descriptions.test.ts` is the structural drift
 * guard (every real tool has an entry, no stale entries) — it does not pin exact wording, so
 * this is free to describe the loop-facing surface precisely.
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  request_quote:
    "request_quote(siu, model, rateUsdPerSiu, indexVersion, printId, printHash, sellerId, chain, expiresInSeconds, pattern, siuMax?) -> an unsigned quote body, posted to the market board for that seller to see",
  issue_quote:
    "issue_quote(requestId) -> answers one open request from the market board with a real signed touchstone-quote (the board's own stored body, not anything you reconstruct)",
  pay: "pay(requestId, settler) -> pays the real signed quote that answered your own request (settler is usually the zero address, matching this repo's own demo convention); opens and funds escrow, returns a tx hash",
  mint_claim:
    "mint_claim(quantity) -> mints a dated work claim for this window's job/class at this window's real rate (the class id, window bounds and rate attestation are all supplied for you); routed to an issuer with headroom, returns tokenId + the routed issuer",
  transfer_claim:
    "transfer_claim(agentId, tokenId, quantity) -> free ERC-1155 transfer to a named roster agent (or transfer_claim(to, tokenId, quantity) with a literal address)",
  redeem_claim:
    "redeem_claim(tokenId, taskSpecHash) -> presents your claim for redemption inside its window",
  settle_window_close:
    "settle_window_close(tokenId, holder, printId, nanoUsdPerSiu, validUntil, signature) -> settles a closed window (Defaulted or Expired), permissionless; the rate attestation is only checked when the window Defaulted",
  serve_redemption:
    "serve_redemption(tokenId, agentId, quantity, passed, receiptRef) -> issuer-only: reports a redemption's real outcome once you see PENDING REDEMPTION ROUTED TO YOU (agentId names the holder; a literal holder address also works)",
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
