import type { Receipt } from "../types/generated/receipt.schema.js";
import { bodyHash, bodyHashHex } from "../crypto/canonicalise.js";
import {
  publicKeyFor,
  signBodyHash,
  verifyBodySignature,
  type SignatureCheck,
} from "../crypto/sign.js";
import { validateReceipt } from "../validation/receipt.js";

export type ReceiptBody = Omit<Receipt, "signature" | "public_key">;

/** Strips signature and public_key before hashing/signing — a signature cannot cover itself. */
export function receiptBodyOf(receipt: Receipt | ReceiptBody): ReceiptBody {
  const copy = { ...(receipt as Receipt) } as Partial<Receipt>;
  delete copy.signature;
  delete copy.public_key;
  return copy as ReceiptBody;
}

export function receiptBodyHashHex(receipt: Receipt | ReceiptBody): string {
  return bodyHashHex(receiptBodyOf(receipt));
}

/**
 * Signs a receipt body and returns the full, signed `Receipt` — same JCS → keccak256 →
 * secp256k1 scheme as prints and quotes, so `verify_receipt`'s result is independently
 * verifiable offline (build1-spec.md §9). Refuses to sign a body that fails the published
 * schema, for the same reason `signPrintBody`/`signQuote` do.
 */
export function signReceipt(body: ReceiptBody, privateKeyHex: string): Receipt {
  const signature = signBodyHash(bodyHash(body), privateKeyHex);
  const receipt = { ...body, signature, public_key: publicKeyFor(privateKeyHex) } as Receipt;

  const validation = validateReceipt(receipt);
  if (!validation.valid) {
    throw new Error(
      `Refusing to sign a receipt that fails the published schema: ${validation.errors.join("; ")}`,
    );
  }
  return receipt;
}

/** Key-in, signature-out — see quote/sign.ts's verifyQuoteSignature for the same convention. */
export function verifyReceiptSignature(receipt: Receipt, publicKeyHex: string): SignatureCheck {
  return verifyBodySignature(receiptBodyOf(receipt), receipt.signature, publicKeyHex);
}
