import { describe, expect, it } from "vitest";
import type { ReconciliationRecord } from "../types/generated/reconciliation.schema.js";
import { publicKeyFor } from "../crypto/sign.js";
import {
  reconciliationBodyHashHex,
  reconciliationBodyOf,
  signReconciliation,
  verifyReconciliationSignature,
  type ReconciliationBody,
} from "./sign.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;

const body: ReconciliationBody = {
  schema_version: "1.0",
  print_id: "2026-08-14",
  computed_usd: "0.0676",
  invoice_usd: "0.0676",
  provider_breakdown: [{ provider: "openrouter", invoice_usd: "0.0676" }],
  relative_delta: "0",
  tolerance: "0.02",
  reconciled_at: "2026-08-20T00:00:00Z",
};

describe("signReconciliation / verifyReconciliationSignature", () => {
  it("produces a signature that verifies against its own body", () => {
    const record = signReconciliation(body, TEST_KEY);
    expect(verifyReconciliationSignature(record, publicKeyFor(TEST_KEY)).valid).toBe(true);
  });

  it("writes the matching public key into the record", () => {
    const record = signReconciliation(body, TEST_KEY);
    expect(record.public_key).toBe(publicKeyFor(TEST_KEY));
  });

  it("is deterministic — the same body and key produce the same signature", () => {
    expect(signReconciliation(body, TEST_KEY).signature).toBe(
      signReconciliation(body, TEST_KEY).signature,
    );
  });

  it("DETECTS TAMPERING: a changed invoice_usd invalidates the signature", () => {
    const record = signReconciliation(body, TEST_KEY);
    const tampered = { ...record, invoice_usd: "999.000000" } as ReconciliationRecord;
    expect(verifyReconciliationSignature(tampered, publicKeyFor(TEST_KEY)).valid).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const record = signReconciliation(body, OTHER_KEY);
    expect(verifyReconciliationSignature(record, publicKeyFor(TEST_KEY)).valid).toBe(false);
  });

  it("refuses to sign a body that fails the published schema", () => {
    const broken = { ...body, provider_breakdown: [] } as unknown as ReconciliationBody;
    expect(() => signReconciliation(broken, TEST_KEY)).toThrow(/Refusing to sign/);
  });

  it("still validates and signs correctly with no anchor present yet", () => {
    // anchor is optional precisely so a record can be signed before it's added — see
    // reconciliationBodyOf's own doc comment.
    const record = signReconciliation(body, TEST_KEY);
    expect(record.anchor).toBeUndefined();
  });
});

describe("reconciliationBodyOf / reconciliationBodyHashHex", () => {
  it("strips signature, public_key and anchor before hashing", () => {
    const record = signReconciliation(body, TEST_KEY);
    const withAnchor = { ...record, anchor: { chain: "base-sepolia", status: "stub" as const } };
    const stripped = reconciliationBodyOf(withAnchor) as Partial<ReconciliationRecord>;
    expect(stripped.signature).toBeUndefined();
    expect(stripped.public_key).toBeUndefined();
    expect(stripped.anchor).toBeUndefined();
  });

  it("gives the same hash before and after signing, and before and after anchoring", () => {
    const record = signReconciliation(body, TEST_KEY);
    const withAnchor = { ...record, anchor: { chain: "base-sepolia", status: "stub" as const } };
    expect(reconciliationBodyHashHex(record)).toBe(reconciliationBodyHashHex(body));
    expect(reconciliationBodyHashHex(withAnchor)).toBe(reconciliationBodyHashHex(body));
  });
});
