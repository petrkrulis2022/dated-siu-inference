import {
  minorUnitsToUsd,
  D,
  signReceipt,
  validateTouchstoneQuote,
  type TouchstoneQuote,
  type ReceiptBody,
  type Receipt,
} from "@touchstone/sdk";
import type { SettlementReader } from "../settlement/reader.js";

/** Same v1 scoping docs/plan.md risk 6 states for the TouchstoneEscrow contract itself: multi-chain
 * plumbing isn't built, so an unsupported chain errors with a documented limitation rather than
 * silently attempting an unsupported read. */
export const SUPPORTED_VERIFY_RECEIPT_CHAINS = ["base", "base-sepolia"] as const;

export interface VerifyReceiptInput {
  chain: string;
  tx_hash: string;
  /** The full signed quote this settlement is claimed to be for. verify_receipt is stateless —
   * there is no off-chain quote index — so the caller supplies it and `reader` cryptographically
   * binds it to the on-chain settlement via quoteHashHex, rejecting any mismatch. */
  quote: unknown;
}

/**
 * verify_receipt(chain, tx_hash, quote) — build1-spec.md §9: "reads an on-chain settlement,
 * matches it against the referenced quote hash, and returns a signed attestation." Reading the
 * chain is `reader`'s job (settlement/on-chain.ts, against the deployed TouchstoneEscrow); everything
 * here — validating the caller's quote, then turning what was read into a checked, signed
 * Receipt — is real.
 */
export async function verifyReceiptTool(
  input: VerifyReceiptInput,
  reader: SettlementReader,
  attestationPrivateKeyHex: string,
): Promise<Receipt> {
  if (
    !SUPPORTED_VERIFY_RECEIPT_CHAINS.includes(
      input.chain as (typeof SUPPORTED_VERIFY_RECEIPT_CHAINS)[number],
    )
  ) {
    throw new Error(
      `Unsupported chain "${input.chain}". Build 1 supports: ${SUPPORTED_VERIFY_RECEIPT_CHAINS.join(", ")}.`,
    );
  }

  const validation = validateTouchstoneQuote(input.quote);
  if (!validation.valid) {
    throw new Error(
      `quote fails the published touchstone-quote schema: ${validation.errors.join("; ")}`,
    );
  }
  const quote: TouchstoneQuote = validation.data;

  const settlement = await reader.read(input.chain, input.tx_hash, quote);
  if (!settlement) {
    throw new Error(`No settlement found for ${input.chain}/${input.tx_hash}.`);
  }

  const matched = !new D(settlement.actualAmountMinorUnits).greaterThan(
    settlement.maxAmountMinorUnits,
  );

  const body: ReceiptBody = {
    schema_version: "1.0",
    quote_hash: settlement.quoteHash,
    chain: input.chain,
    tx_ref: input.tx_hash,
    amount_quoted_usd: minorUnitsToUsd(settlement.maxAmountMinorUnits),
    amount_paid_usd: minorUnitsToUsd(settlement.actualAmountMinorUnits),
    matched,
    print_ref: settlement.printRef,
  };

  return signReceipt(body, attestationPrivateKeyHex);
}
