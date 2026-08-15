/**
 * build1-spec.md §6 Signing: "call DatumAttestation.postPrint(bodyHash, version) on Base so
 * the hash is timestamped by a third party." The contract itself is P13 — this interface lets
 * publication proceed today, and P13 only has to supply a new implementation, never touch a
 * caller.
 */
export interface AnchorResult {
  chain: string;
  status: "anchored" | "stub" | "failed";
  tx_hash?: string;
  posted_at?: string;
  notes?: string;
}

export interface AttestationClient {
  postPrint(bodyHash: string, version: string): Promise<AnchorResult>;
}

/**
 * Returns a result that is honestly labelled as not a real anchor — `status: "stub"`, no
 * `tx_hash`. A stub that fabricated a plausible-looking hash would be indistinguishable from
 * a real anchor to anyone reading the print file, which is worse than no anchor at all.
 */
export class StubAttestationClient implements AttestationClient {
  // Deliberately fewer parameters than AttestationClient's signature — a stub that never
  // calls a chain has no use for bodyHash or version, and TS structurally allows an
  // implementation to accept fewer arguments than the interface declares.
  async postPrint(): Promise<AnchorResult> {
    return {
      chain: "base",
      status: "stub",
      posted_at: new Date().toISOString(),
      notes:
        "DatumAttestation is not deployed yet (build1-spec.md §10, milestone P13). No on-chain call was made.",
    };
  }
}
