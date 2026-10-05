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
  pay:
    "pay(requestId, settler) -> settles a quote the seller issued, in USDC: pays the real signed quote that answered your own request, for the quote's own price; opens and funds escrow until the seller settles it, and returns a tx hash (settler is usually the zero address, matching this repo's own demo convention)",
  mint_claim:
    "mint_claim(quantity, forWindow?) -> mints a dated work claim for the job/class at the published rate (the class id, window bounds and rate attestation are all supplied for you); routed to an issuer with headroom, returns tokenId + the routed issuer. forWindow names which delivery window the claim is for, and defaults to the one you are in; a claim for a later window consumes that issuer's headroom now and can only be presented once that window opens.",
  transfer_claim:
    "transfer_claim(agentId, tokenId, quantity, requestId?) -> ERC-1155 transfer to a named roster agent (or transfer_claim(to, tokenId, quantity) with a literal address). Pass requestId to settle a quote you have received with a claim you already hold: the quantity is then set from the quote (the amount of claim worth its dollar price at the print in force) and the recipient must be the quote's seller — you choose which claim to spend. The seller is then told it has been paid and owes the work",
  redeem_claim:
    "redeem_claim(tokenId, taskSpecHash) -> presents your claim for redemption inside its window",
  settle_window_close:
    "settle_window_close(tokenId, holder, printId, nanoUsdPerSiu, validUntil, signature) -> settles a closed window (Defaulted or Expired), permissionless; the rate attestation is only checked when the window Defaulted",
  serve_redemption:
    "serve_redemption(tokenId, agentId, quantity, passed, receiptRef) -> issuer-only: reports a redemption's real outcome once you see PENDING REDEMPTION ROUTED TO YOU (agentId names the holder; a literal holder address also works)",
  // Found live, 2026-09-29 (P5 run 3): this description used to name seven parameters —
  // taskClass, originalGate, hardenedGate, referenceInstance, knownGoodSubmission,
  // adversarialSubmissions, heldOutInstances — of which `buildToolArgs` reads exactly NONE. The
  // one field it does read, `source`, was named nowhere. Both issuers dutifully filled in the
  // seven advertised parameters, left `source` unset, and the old `: ""` fallback substituted an
  // empty module — which then surfaced six checks later as "gate spec does not export a gate()
  // function". Two different models failing identically is what a description defect looks like.
  submit_job:
    "submit_job(source) -> submits YOUR hardened gate and runs the real G1-G6 checks on it. " +
    "`source` is the only field read: the original gate, the reference instance, the known-good " +
    "and adversarial submissions and the held-out instances are all supplied for you from the " +
    "job — do not pass them. `source` is a JavaScript ES module, as a single JSON string, that " +
    "must export a function named gate:\n" +
    "      export async function gate({ referenceDir, submissionDir }) {\n" +
    "        // referenceDir holds the job's reference files; submissionDir holds the\n" +
    "        // submission being graded (answer.mjs for the code class).\n" +
    '        return { accept: true, reason: "why" };   // accept: boolean, reason: string\n' +
    "      }\n" +
    "    A module that does not export gate() cannot be executed and fails every check at G1.",
  submit_attack:
    'submit_attack(submissionSource) -> runs your candidate answer.mjs against the delivered gate AND against an independent oracle, and reports which of the two accepted it. Supply only the module source as a JSON string; the gate being tested, the reference files and the oracle seed are supplied for you. A result counts for you ONLY when the gate accepts a submission the oracle rejects (classification "false_accept"). A correct submission both accept scores nothing, and breaking the oracle scores nothing.',
  pay_with_claim:
    "pay_with_claim(requestId, forWindow?) -> settles a quote the seller issued, in fSIU: mints a dated work claim against an issuer's bonded capacity, sized so it is worth the quote's dollar price at the print in force, and transfers it to the seller; returns the claim's tokenId and its issuer. forWindow names which delivery window the claim is for, and defaults to the one you are in",
  settle_split:
    "settle_split(requestId | quote, claimQuantityMilliSiu) -> settles ONE quote partly in fSIU and partly in USDC, in a single call. claimQuantityMilliSiu is how much of it to settle in claims; the dollar leg is whatever the quote's remaining value is, and the escrow opens for that. One call, one turn — the same turn cost as settling wholly in either asset.",
  settle_escrow:
    "settle_escrow(actualAmountUsd?, receiptRef) -> as the SELLER named in a quote that was paid: releases the escrowed USDC to yourself. Until you call this the money sits in escrow and never reaches your wallet. Omit actualAmountUsd to settle the full quoted amount; settling for less is allowed and is what quote accuracy is scored on. Any capacity you reserved against this quote is returned to its issuer automatically here.",
  reserve_for_work:
    "reserve_for_work(classId) -> as the SELLER named in a quote that was paid in USDC: commits an issuer's bonded capacity to that job before you do the work. Draws on exactly the same finite pool a dated work claim does, sized to the quote's own worst-case SIU. Call it once the escrow is open and before you deliver; settle_escrow releases it again.",
  quote_forward:
    "quote_forward(forWindow, rateUsdPerSiu, maxQuantityMilliSiu) -> as an ISSUER: states your own terms for a LATER window of this run — your price per SIU and how much capacity you will make available at it. This is the only tool here that lets you name your own number. It is recorded whether or not anyone takes it, together with your real headroom at the moment you quoted. It is NOT binding: nothing on-chain holds you to it, and a claim minted later still prices at the published print rate.",
  take_forward:
    "take_forward(quoteId) -> records that you are acting on an issuer's stated forward terms. Nothing is paid, minted or reserved — you still buy the work separately, at the published print rate. It exists so that taking an offer and ignoring one are distinguishable.",
  whoami:
    "whoami() -> your own address, whether you are a bonded issuer, and every class you hold capacity in with its real current headroom and issuance limit. Takes no arguments — nothing about you is model-supplied.",
  get_balances:
    "get_balances(account, tokenIds?) -> real USDC balance (decimal and integer minor-unit forms) plus claim balances",
  get_print: "get_print(printId) -> the real print body plus whether it's final",
  check_headroom: "check_headroom(issuer, classId) -> real headroom and issuance limit, in mSIU",
  list_obligations:
    "list_obligations() -> everything currently outstanding against you as an issuer: claims " +
    "presented and awaiting your work, claims presented and awaiting only your serve_redemption " +
    "report, claims minted against your bond that nobody has presented yet, and claims carried " +
    "unsettled from an earlier window. Takes no arguments — it answers only about you. Read-only.",
  check_delivery:
    "check_delivery() -> for each claim you hold or have presented: whether the issuer has " +
    "actually served it, and with a pass or a fail. Takes no arguments — it answers only about " +
    "your own claims. Read-only.",
};

export function formatToolList(): string {
  return Object.values(TOOL_DESCRIPTIONS).join("\n");
}
