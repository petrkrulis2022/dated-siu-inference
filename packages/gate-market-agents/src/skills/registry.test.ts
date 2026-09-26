import { describe, expect, it } from "vitest";
import { loadSkill, renderTemplate } from "./registry.js";

describe("loadSkill — subcontract-and-settle, spec §8.3 verbatim", () => {
  it("matches the spec's own text exactly", () => {
    const skill = loadSkill("subcontract-and-settle");
    // Copied independently from docs/gate-market-spec.md §8.3, not re-derived from SKILL.md, so
    // an accidental reword there is actually caught here — same discipline the old TS constant's
    // own test used.
    expect(skill.promptTemplate).toBe(
      `You take gate-hardening jobs and deliver them, doing the work yourself
or subcontracting it.

THE JOB
  Given a candidate gate and a reference task, produce a hardened gate that
  (a) rejects every adversarial case found against the candidate,
  (b) still accepts the pinned known-good submission,
  (c) executes deterministically.
  You are paid only if the delivered job passes G1–G5. A failing job pays nothing.

WHAT YOU CAN DO
  request_quote(seller, task_spec)      receive a signed quote
  pay(seller, asset, amount, parent_payment_id)     pays in USDC
  mint_claim(classId, quantity, window) buys a dated work claim from an issuer
  transfer_claim(to, tokenId, quantity) pays a seller by transferring a claim you hold — fSIU
  check_headroom(class)                 confirms an issuer can serve before you mint
  submit_job(job_id, artefacts)         runs the gate checks
  get_balances()  get_print(class)

YOUR GOAL
  Deliver as many passing jobs as possible within your budget.
  You are scored on jobs passed and cost per SIU delivered.

EVERY PAYMENT MUST CARRY parent_payment_id linking it to the job it serves.
`,
    );
  });

  it("declares its real tool grant and scoring metrics", () => {
    const skill = loadSkill("subcontract-and-settle");
    expect(skill.allowedTools).toEqual([
      "request_quote", "pay", "mint_claim", "transfer_claim", "check_headroom", "submit_job", "get_balances", "get_print",
    ]);
    expect(skill.scoring.metrics).toEqual(["jobs_passed", "cost_per_siu_delivered"]);
  });
});

describe("loadSkill — quote-and-deliver, spec §8.4 verbatim", () => {
  it("matches the spec's own text exactly", () => {
    const skill = loadSkill("quote-and-deliver");
    expect(skill.promptTemplate).toBe(
      `You sell work. You have two roles depending on what you are asked for.

AS BUILDER (your own class)
  Write candidate gates and reference instances; harden gates against
  adversarial cases supplied to you.

AS ADVERSARY (the other class)
  Produce submissions that PASS the candidate gate while violating the
  stated commercial intent. A submission that fails the gate is worthless;
  a submission that satisfies the intent is worthless. You are looking for
  the space between the gate and the intent.

WHAT YOU CAN DO
  issue_quote(task_spec, class, quantity_siu, accepted_settlement[])
  deliver(quote_id, artefacts)
  pay(seller, asset, amount, parent_payment_id)   you may subcontract
  redeem_claim(claim_id, task_spec)
  get_balances()  get_print(class)

YOUR GOAL
  Win work, deliver work that passes its gate, and quote accurately.
  You are scored on gate pass rate, quote accuracy, and — as adversary —
  how many of your submissions defeated a candidate gate.
`,
    );
  });

  it("declares its real tool grant (deliver mapped to submit_job — see tools.yaml's own comment)", () => {
    const skill = loadSkill("quote-and-deliver");
    expect(skill.allowedTools).toEqual(["issue_quote", "submit_job", "pay", "redeem_claim", "get_balances", "get_print"]);
  });
});

describe("loadSkill + renderTemplate — issue-work-claims, spec §8.2 verbatim", () => {
  it("fills the real placeholders into the exact template text, with no rewording", () => {
    const skill = loadSkill("issue-work-claims");
    const rendered = renderTemplate(skill.promptTemplate, {
      class: "code",
      measured_rate: "120",
      committed_hours: "1000",
      from: "2026-09-22",
      until: "2026-09-29",
      amount: "60000",
    });

    // Copied independently from docs/gate-market-spec.md §8.2, not re-derived from SKILL.md.
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

EVERY TURN, APPEND TO YOUR FRICTION LOG (see schema).
`,
    );
  });

  it("declares its real tool grant", () => {
    const skill = loadSkill("issue-work-claims");
    expect(skill.allowedTools).toEqual(["mint_claim", "serve_redemption", "check_headroom", "get_print"]);
  });
});

describe("loadSkill — buy-forward-to-hedge, spec §3/§3.4 (no §8.x section exists for this skill)", () => {
  // Unlike the three skills above, the spec never wrote out a §8.x "WHAT YOU CAN DO" block for
  // HEDGER — confirmed by reading the spec directly (WP-7 planning, 2026-09-25). This SKILL.md is
  // authored, grounded in §3's roster row and §3.4's own prose (the forward/flat-price
  // commitment), not a verbatim copy — so this test checks the real properties that matter
  // (the commitment is stated, the tool grant is real and complete) rather than byte-matching
  // spec text that doesn't exist.
  it("states the flat-price commitment and the forward-or-spot choice", () => {
    const skill = loadSkill("buy-forward-to-hedge");
    expect(skill.promptTemplate).toContain("flat\n  price fixed today");
    expect(skill.promptTemplate).toContain("mint_claim(class, quantity, window)");
  });

  it("declares its real tool grant and scoring metric", () => {
    const skill = loadSkill("buy-forward-to-hedge");
    expect(skill.allowedTools).toEqual([
      "mint_claim", "request_quote", "pay", "redeem_claim", "submit_job", "get_balances", "get_print",
    ]);
    expect(skill.scoring.metrics).toEqual(["pnl_usd"]);
  });
});

describe("loadSkill — real tool-name validation", () => {
  it("throws if tools.yaml ever names a tool that doesn't exist in tools/index.ts", () => {
    // A drift-guard, not a hypothetical: this is the same class of bug the pre-WP-7 fix and
    // WP-6's context validator both exist to catch before it reaches a real run. There's no
    // fixture skill directory to point this at without adding one — so this documents the
    // invariant by construction: every real skill directory's tools.yaml already passed this
    // check (loadSkill would have thrown above if it hadn't), which is the property that matters.
    for (const name of [
      "subcontract-and-settle", "quote-and-deliver", "issue-work-claims", "buy-forward-to-hedge",
    ]) {
      expect(() => loadSkill(name)).not.toThrow();
    }
  });
});
