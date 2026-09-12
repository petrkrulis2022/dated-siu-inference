import type { ReconciliationRecord } from "../types/generated/reconciliation.schema.js";
import { bodyHash, bodyHashHex } from "../crypto/canonicalise.js";
import {
  publicKeyFor,
  signBodyHash,
  verifyBodySignature,
  type SignatureCheck,
} from "../crypto/sign.js";
import { validateReconciliation } from "../validation/reconciliation.js";

export type ReconciliationBody = Omit<ReconciliationRecord, "signature" | "public_key" | "anchor">;

/**
 * Strips signature/public_key/anchor before hashing/signing — a signature cannot cover itself,
 * and anchor is added after signing the same way a print's own signature/public_key/anchor are
 * excluded (packages/print/src/sign/canonicalise.ts): `anchor` is optional in the schema for
 * exactly this reason, so a record can validate (and be signed) before it exists.
 */
export function reconciliationBodyOf(
  record: ReconciliationRecord | ReconciliationBody,
): ReconciliationBody {
  const copy = { ...(record as ReconciliationRecord) } as Partial<ReconciliationRecord>;
  delete copy.signature;
  delete copy.public_key;
  delete copy.anchor;
  return copy as ReconciliationBody;
}

export function reconciliationBodyHashHex(record: ReconciliationRecord | ReconciliationBody): string {
  return bodyHashHex(reconciliationBodyOf(record));
}

/**
 * Signs a reconciliation body and returns the signed `ReconciliationRecord` (anchor not yet
 * present — added by the caller once postPrint succeeds, same order publishPrint signs a print
 * before anchoring it). Same JCS -> keccak256 -> secp256k1 scheme as prints and receipts, so a
 * reader can independently verify a print is reconciled without trusting anything but the
 * publisher's public key. Refuses to sign a body that fails the published schema, for the same
 * reason signPrintBody/signReceipt do.
 */
export function signReconciliation(
  body: ReconciliationBody,
  privateKeyHex: string,
): ReconciliationRecord {
  const signature = signBodyHash(bodyHash(body), privateKeyHex);
  const record = { ...body, signature, public_key: publicKeyFor(privateKeyHex) } as ReconciliationRecord;

  const validation = validateReconciliation(record);
  if (!validation.valid) {
    throw new Error(
      `Refusing to sign a reconciliation record that fails the published schema: ${validation.errors.join("; ")}`,
    );
  }
  return record;
}

/** Key-in, signature-out — see receipt/sign.ts's verifyReceiptSignature for the same convention. */
export function verifyReconciliationSignature(
  record: ReconciliationRecord,
  publicKeyHex: string,
): SignatureCheck {
  return verifyBodySignature(reconciliationBodyOf(record), record.signature, publicKeyHex);
}
