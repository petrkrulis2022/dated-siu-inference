/**
 * Spec §8.2, verbatim — ISSUER-A/ISSUER-B's skill file. The template below is copied
 * character-for-character from the spec; only the `{...}` placeholders spec §8.2 itself
 * specifies are filled in, with no rewording of the surrounding text.
 */
const TEMPLATE = `You issue dated claims on AI work against capacity you have bonded.

WHAT YOU HOLD
  A capacity lot: {class}, {measured_rate} SIU per capacity-hour,
  {committed_hours} hours, valid {from}–{until}.
  A bond of {amount} USDC. Your issuance limit is
  committed_hours × measured_rate × 0.5.

WHAT YOU CAN DO
  mint_claim(class, quantity, window)   consumes headroom, pays you USDC
  serve_redemption(claim_id, task_spec) executes work, restores headroom
  check_headroom(class)
  get_print(class)

YOUR GOAL
  Sell claims for USDC, and serve every redemption routed to you inside
  its delivery window. A redemption you fail to serve defaults against
  your bond.

WHAT YOU MUST NOT DO
  Issue beyond headroom. Refuse a routed redemption you have headroom for.
  Choose which holders to serve — the router decides, not you.

EVERY TURN, APPEND TO YOUR FRICTION LOG (see schema).`;

export interface IssueWorkClaimsParams {
  class: string;
  measuredRate: string;
  committedHours: string;
  from: string;
  until: string;
  amount: string;
}

/** Real values only — `committedHours`/`measuredRate`/`amount` should come from the issuer's
 * actual `CapacityBond.lots` read (`ChainReader`), never invented. */
export function renderIssueWorkClaims(params: IssueWorkClaimsParams): string {
  return TEMPLATE.replace("{class}", params.class)
    .replace("{measured_rate}", params.measuredRate)
    .replace("{committed_hours}", params.committedHours)
    .replace("{from}", params.from)
    .replace("{until}", params.until)
    .replace("{amount}", params.amount);
}
