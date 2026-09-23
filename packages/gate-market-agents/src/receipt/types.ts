import type { AgentId } from "../identity/resolve.js";

/**
 * Field-for-field `docs/gate-market-spec.md` §6.2's real schema — deliberately NOT
 * `@touchstone/sdk`'s `Receipt` type (`verify_receipt`'s attestation for the main escrow/quote
 * product: `quote_hash`, `amount_paid_usd`, `matched`), which is a different domain entirely.
 * See this package's WP-5 plan for why reusing or extending that shared type would be wrong.
 */
export interface GateMarketReceipt {
  receipt_id: string;
  /** Links this receipt to the job/payment it serves — spec §6.3: "EVERY PAYMENT MUST CARRY
   * parent_payment_id." `null` only for a depth-0 receipt (the operator's own top-level job, no
   * parent payment exists). */
  parent_payment_id: string | null;
  quote_id: string;
  buyer: AgentId;
  seller: AgentId;
  executor: AgentId;
  class: "code" | "extract";
  siu_delivered: number;
  gate_results: { G1: boolean; G2: boolean; G3: boolean; G4: boolean; G5: boolean; G6: boolean };
  settlement_asset: string;
  settlement_amount: number;
  usdc_equivalent_at_print: string;
  print_id: string;
  methodology_version: string;
  /** The record that proves failed work counts zero (spec §6.2's own words) — `false` alongside
   * a failed gate result must be kept, not filtered as an error. */
  claim_retired: boolean;
  usage: { input_tokens: number; output_tokens: number; retries: number };
  artefact_hashes: { gate_spec: string; adversarial_cases: string[] };
  /** Spec §1.1's mechanism-not-demand caveat, verbatim (`skills/caveat.ts`'s
   * `MECHANISM_CAVEAT`) — carried on every receipt, not just the summary this receipt might feed
   * into later. Pre-WP-7 fix, 2026-09-23: "a caveat bolted on afterwards is a caveat that was
   * missing when the numbers were first read." `receipt/emit.ts`'s `buildReceipt` sets this
   * directly, not as a caller-supplied parameter, so no receipt can be built without it. */
  mechanism_caveat: string;
}
