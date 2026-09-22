import { describe, expect, it } from "vitest";
import { renderIssueWorkClaims } from "./issue-work-claims.js";

describe("renderIssueWorkClaims — spec §8.2, verbatim", () => {
  it("fills the real placeholders into the exact template text, with no rewording", () => {
    const rendered = renderIssueWorkClaims({
      class: "code",
      measuredRate: "120",
      committedHours: "1000",
      from: "2026-09-22",
      until: "2026-09-29",
      amount: "60000",
    });

    // Copied independently from docs/gate-market-spec.md §8.2, not re-derived from the source
    // module, so an accidental reword there is actually caught here.
    expect(rendered).toBe(
      `You issue dated claims on AI work against capacity you have bonded.

WHAT YOU HOLD
  A capacity lot: code, 120 SIU per capacity-hour,
  1000 hours, valid 2026-09-22–2026-09-29.
  A bond of 60000 USDC. Your issuance limit is
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

EVERY TURN, APPEND TO YOUR FRICTION LOG (see schema).`,
    );
  });
});
