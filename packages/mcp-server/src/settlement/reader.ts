/**
 * What verify_receipt needs from an on-chain DatumEscrow settlement — build1-spec.md §10:
 * `Settled(quoteHash, actualAmount, receiptRef)`, plus the `maxAmount` the matching
 * `openAndFund` call authorised (escrow's own state, readable at the same address), so
 * `matched = actualAmount ≤ maxAmount` can be checked against the chain rather than trusted.
 *
 * `printRef` is a genuine open gap, flagged rather than invented: the Receipt schema requires
 * it (build1-spec.md §9's "signed attestation" carries which print priced the settlement), but
 * §10's `Settled` event as specified carries no print reference at all — only `quoteHash`,
 * `actualAmount`, `receiptRef`. A real SettlementReader implementation needs *some* way to
 * resolve `quoteHash` back to the print it was quoted against (an off-chain quote index, or a
 * print reference encoded into `receiptRef` at settle time) — a decision for whoever builds
 * P13, not settled here.
 */
export interface OnChainSettlement {
  quoteHash: string;
  actualAmountMinorUnits: string;
  maxAmountMinorUnits: string;
  receiptRef: string;
  printRef: string;
}

export interface SettlementReader {
  read(chain: string, txHash: string): Promise<OnChainSettlement | null>;
}

/**
 * `DatumEscrow` doesn't exist until P13 (build1-spec.md §10), and this environment has no chain
 * RPC credentials regardless. Throwing here rather than fabricating a plausible-looking
 * settlement is the same choice packages/print/src/anchor/attestation.ts's
 * `StubAttestationClient` and packages/sdk/src/quote/identity.ts's `Erc8004Resolver` made: a
 * stub that invents data indistinguishable from a real reading would be worse than no reading
 * at all. Everything downstream of a successful `read()` — turning an `OnChainSettlement` into
 * a signed `Receipt` — is real and fully tested against this interface.
 */
export class StubSettlementReader implements SettlementReader {
  read(): Promise<OnChainSettlement | null> {
    return Promise.reject(
      new Error(
        "StubSettlementReader cannot read on-chain settlements. Needs: DatumEscrow's deployed " +
          "address per chain (P13), its ABI, and an RPC endpoint for that chain. Until then, " +
          "verify_receipt has nothing real to attest to.",
      ),
    );
  }
}
