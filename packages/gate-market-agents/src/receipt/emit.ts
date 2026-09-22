import type { G1ToG5Result } from "@touchstone/gate-market";
import type { AgentId } from "../identity/resolve.js";
import type { GateMarketReceipt } from "./types.js";

export interface BuildReceiptInput {
  receiptId: string;
  parentPaymentId: string | null;
  quoteId: string;
  buyer: AgentId;
  seller: AgentId;
  executor: AgentId;
  taskClass: "code" | "extract";
  siuDelivered: number;
  /** The real G1-G5 result from a `submit_job` tool call — `claim_retired` is derived from its
   * own `passed` field, never set independently, so a receipt can never claim a retirement the
   * gate didn't actually grant. */
  gateResult: G1ToG5Result;
  settlementAsset: string;
  settlementAmount: number;
  usdcEquivalentAtPrint: string;
  printId: string;
  methodologyVersion: string;
  gateSpecHash: string;
  adversarialCaseHashes: string[];
  /** No model ran, so there's nothing to report beyond zero — honest, not invented. */
  usage?: { input_tokens: number; output_tokens: number; retries: number };
}

const NO_MODEL_USAGE = { input_tokens: 0, output_tokens: 0, retries: 0 };

export function buildReceipt(input: BuildReceiptInput): GateMarketReceipt {
  return {
    receipt_id: input.receiptId,
    parent_payment_id: input.parentPaymentId,
    quote_id: input.quoteId,
    buyer: input.buyer,
    seller: input.seller,
    executor: input.executor,
    class: input.taskClass,
    siu_delivered: input.siuDelivered,
    gate_results: {
      G1: input.gateResult.g1.passed,
      G2: input.gateResult.g2.passed,
      G3: input.gateResult.g3.passed,
      G4: input.gateResult.g4.passed,
      G5: input.gateResult.g5.passed,
    },
    settlement_asset: input.settlementAsset,
    settlement_amount: input.settlementAmount,
    usdc_equivalent_at_print: input.usdcEquivalentAtPrint,
    print_id: input.printId,
    methodology_version: input.methodologyVersion,
    claim_retired: input.gateResult.passed,
    usage: input.usage ?? NO_MODEL_USAGE,
    artefact_hashes: {
      gate_spec: input.gateSpecHash,
      adversarial_cases: input.adversarialCaseHashes,
    },
  };
}
