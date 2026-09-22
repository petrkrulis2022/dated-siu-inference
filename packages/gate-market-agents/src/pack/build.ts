import type { TaskClass } from "@touchstone/gate-market";
import { QUOTE_SCHEMA_VERSION } from "@touchstone/sdk";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { formatToolList } from "./tool-descriptions.js";
import type { AgentId } from "../identity/resolve.js";

/** Compact field references, not full JSON schema dumps — §8.1's own framing: "facts it would
 * otherwise waste budget discovering," not a document to parse. */
const QUOTE_SCHEMA_SUMMARY =
  `touchstone-quote v${QUOTE_SCHEMA_VERSION}: quote_id, seller, task_spec_hash, class, quantity_siu, ` +
  "quantity_display_integer, quality_gate_id, print_id, price_usdc, spread_to_index_pct, " +
  "accepted_settlement[], expiry, delivery_deadline, signature";
const RECEIPT_SCHEMA_SUMMARY =
  "GateMarketReceipt: receipt_id, parent_payment_id, quote_id, buyer, seller, executor, class, " +
  "siu_delivered, gate_results{G1..G5}, settlement_asset, settlement_amount, " +
  "usdc_equivalent_at_print, print_id, methodology_version, claim_retired, usage, artefact_hashes";

export interface ClassPrint {
  printId: string;
  rateUsdPerSiu: string;
}

export interface ClassInfo {
  taskClass: TaskClass;
  gateSource: string;
  commercialIntent: string;
}

export interface CommonPackParams {
  agentId: AgentId;
  walletAddress: string;
  erc8004Id: string;
  usdcBalanceUsd: string;
  /** Pre-formatted by the caller from a real `get_balances` tool result — this builder never
   * reads a chain itself, matching every other testable-without-a-chain piece in this package. */
  claimBalancesSummary: string;
  classes: readonly ClassInfo[];
  /** Injected — no Gate Market per-class print has ever been computed (spec phase P2, still
   * unbuilt; WP-5's dry loop used a fixed illustrative rate). A class with no entry here says so
   * honestly in the assembled pack rather than fabricating a print. */
  printsByClass: Partial<Record<TaskClass, ClassPrint>>;
}

/**
 * Spec §8.1's common pack, assembled from real data only. Explicitly excluded, per §8.1's own
 * "not in any pack" list: the monetary design doc, the gate-market spec, the promise-ladder
 * rationale, the experiment descriptions, any statement about which asset is preferred — this
 * function never reads those files, and `pack/validate.ts` checks the result at runtime too.
 */
export function buildCommonPack(params: CommonPackParams): string {
  const lines: string[] = [
    `AGENT: ${params.agentId}`,
    `WALLET: ${params.walletAddress}`,
    `IDENTITY: ${params.erc8004Id}`,
    `BALANCES: ${params.usdcBalanceUsd} USDC; ${params.claimBalancesSummary}`,
    "",
    "CURRENT PER-CLASS PRINTS:",
    ...(params.classes.length === 0
      ? ["  (none)"]
      : params.classes.map((classInfo) => {
          const print = params.printsByClass[classInfo.taskClass];
          return print
            ? `  ${classInfo.taskClass}: print ${print.printId}, ${print.rateUsdPerSiu} USD/SIU`
            : `  ${classInfo.taskClass}: no print measured yet`;
        })),
    "",
    `QUOTE SCHEMA: ${QUOTE_SCHEMA_SUMMARY}`,
    `RECEIPT SCHEMA: ${RECEIPT_SCHEMA_SUMMARY}`,
    "",
    "YOUR TOOLS:",
    formatToolList(),
    "",
    CANONICAL_ASSET_DESCRIPTION,
  ];

  for (const classInfo of params.classes) {
    lines.push(
      "",
      `CLASS: ${classInfo.taskClass}`,
      `COMMERCIAL INTENT: ${classInfo.commercialIntent}`,
      `GATE:\n${classInfo.gateSource}`,
    );
  }

  return lines.join("\n");
}
