import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import { bodyHash, bodyHashHex } from "../crypto/canonicalise.js";
import { signBodyHash, verifyBodySignature, type SignatureCheck } from "../crypto/sign.js";
import { validateTouchstoneQuote } from "../validation/datum-quote.js";
import type { QuoteBody } from "./build.js";

/** Strips `sig` before hashing/signing — a signature cannot cover itself. */
export function quoteBodyOf(quote: TouchstoneQuote | QuoteBody): QuoteBody {
  const copy = { ...(quote as TouchstoneQuote) } as Partial<TouchstoneQuote>;
  delete copy.sig;
  return copy as QuoteBody;
}

/**
 * keccak256 of the JCS-canonicalised quote body, excluding `sig` — this is the `quoteHash`
 * `TouchstoneEscrow.openAndFund` and `receipt.quote_hash` both refer to (build1-spec.md §10, and
 * docs/plan.md:28's flagged coordination point with the Solidity contract). Excluding `sig`
 * mirrors excluding `signature` from a print body: the hash is a property of the offer, not the
 * signer, and is computable before a seller has signed anything.
 */
export function quoteHashHex(quote: TouchstoneQuote | QuoteBody): string {
  return bodyHashHex(quoteBodyOf(quote));
}

/**
 * Signs a quote body and returns the full, signed `TouchstoneQuote`. Refuses to sign a body that
 * fails the published schema — same reasoning as `@touchstone/print`'s `signPrintBody`: a signature
 * over an unpublishable body attests to something no verifier can accept.
 */
export function signQuote(body: QuoteBody, privateKeyHex: string): TouchstoneQuote {
  const signature = signBodyHash(bodyHash(body), privateKeyHex);
  const quote = { ...body, sig: signature } as TouchstoneQuote;

  const validation = validateTouchstoneQuote(quote);
  if (!validation.valid) {
    throw new Error(
      `Refusing to sign a quote that fails the published schema: ${validation.errors.join("; ")}`,
    );
  }
  return quote;
}

/**
 * Key-in, signature-out: verifies `quote.sig` against a caller-supplied public key. This
 * function proves body integrity and key custody only — it does NOT prove the key belongs to
 * `quote.seller_id`. Binding a key to an ERC-8004 identity is `quote/identity.ts`'s job; compose
 * the two with `verifyQuoteFromIdentity`.
 */
export function verifyQuoteSignature(quote: TouchstoneQuote, publicKeyHex: string): SignatureCheck {
  return verifyBodySignature(quoteBodyOf(quote), quote.sig, publicKeyHex);
}
