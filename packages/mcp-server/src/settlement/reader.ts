import type { DatumQuote } from "@datum/sdk";

/**
 * What verify_receipt needs from an on-chain DatumEscrow settlement — build1-spec.md §10:
 * `Settled(quoteHash, actualAmount, receiptRef)`, plus the `maxAmount` the matching
 * `openAndFund` call authorised (escrow's own state — `settle()` never clears `maxAmount`, so
 * it stays readable after settlement — confirmed by reading the deployed source rather than
 * assumed).
 *
 * `printRef` closes a gap flagged since P12: the Receipt schema requires it, but §10's `Settled`
 * event carries no print reference at all. Closed here without touching the contract: the caller
 * supplies the full `datum-quote` being settled, `read()` cryptographically binds it to the
 * on-chain settlement by recomputing `quoteHashHex(quote)` and asserting it equals the on-chain
 * `quoteHash` — reject otherwise — and only then trusts the quote's own `print_id` as `printRef`.
 * No off-chain quote index is needed; the binding is the hash, which is exactly why this reader
 * needs no database and is safe to call statelessly, from anywhere, with no prior state.
 */
export interface OnChainSettlement {
  quoteHash: string;
  actualAmountMinorUnits: string;
  maxAmountMinorUnits: string;
  receiptRef: string;
  printRef: string;
}

export interface SettlementReader {
  /** `quote` is the full signed datum-quote the caller claims this settlement is for — required
   * so the reader can verify that claim cryptographically rather than trust it. */
  read(chain: string, txHash: string, quote: DatumQuote): Promise<OnChainSettlement | null>;
}

/**
 * `DatumEscrow` is now deployed (see data/deployments/base-sepolia.json), so
 * `OnChainSettlementReader` in ./on-chain.ts is the real implementation. This stub remains for
 * tests and for running the server with no chain configured — throwing rather than fabricating a
 * plausible-looking settlement, the same choice `StubAttestationClient` and `Erc8004Resolver`
 * made elsewhere in this project.
 */
export class StubSettlementReader implements SettlementReader {
  read(): Promise<OnChainSettlement | null> {
    return Promise.reject(
      new Error(
        "StubSettlementReader cannot read on-chain settlements. No SettlementReader was " +
          "configured for this server. Pass an OnChainSettlementReader (settlement/on-chain.js).",
      ),
    );
  }
}
