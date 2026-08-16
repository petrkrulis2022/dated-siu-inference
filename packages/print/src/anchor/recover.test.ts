import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { computePrint } from "../compute/index.js";
import { publishableWorkedExampleInput } from "../worked-example.fixture.js";
import { publicKeyFor, signPrintBody } from "../sign/sign.js";
import { fromHex, printBodyHashHex, toHex } from "../sign/canonicalise.js";
import { recoverSignerCandidates, signatureMatchesAddress } from "./recover.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;

const { body } = computePrint(publishableWorkedExampleInput());
const signed = signPrintBody(body, TEST_KEY);
const bodyHash = printBodyHashHex(signed);

/** The published public_key is compressed; deriving the address the same way real Ethereum
 * address derivation works (uncompressed pubkey -> keccak256 -> last 20 bytes) gives the
 * independently-known-correct answer to compare recovery's output against. */
function addressForKey(privateKeyHex: string): string {
  const uncompressed = secp256k1.getPublicKey(fromHex(privateKeyHex), false);
  const digest = keccak_256(uncompressed.subarray(1));
  return toHex(digest.subarray(-20));
}

describe("recoverSignerCandidates", () => {
  it("yields exactly two candidates for a real signature (no recovery bit is stored)", () => {
    const candidates = recoverSignerCandidates(signed.signature, bodyHash);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.recoveryId).sort()).toEqual([0, 1]);
  });

  it("one candidate's address matches the true signer, derived independently", () => {
    const trueAddress = addressForKey(TEST_KEY);
    const candidates = recoverSignerCandidates(signed.signature, bodyHash);
    expect(candidates.some((c) => c.address.toLowerCase() === trueAddress.toLowerCase())).toBe(
      true,
    );
  });

  it("one candidate's compressed public key matches the print's own public_key field", () => {
    // Not circular: recovery derives this from {signature, hash} alone, never reading
    // print.public_key. That it matches confirms the field wasn't tampered with independently
    // of confirming who actually signed.
    const candidates = recoverSignerCandidates(signed.signature, bodyHash);
    expect(candidates.some((c) => c.publicKeyCompressed === signed.public_key)).toBe(true);
    expect(signed.public_key).toBe(publicKeyFor(TEST_KEY));
  });

  it("the other candidate does not match a different key's address", () => {
    const otherAddress = addressForKey(OTHER_KEY);
    const candidates = recoverSignerCandidates(signed.signature, bodyHash);
    expect(candidates.every((c) => c.address.toLowerCase() !== otherAddress.toLowerCase())).toBe(
      true,
    );
  });
});

describe("signatureMatchesAddress", () => {
  it("returns true for the real signer's address", () => {
    expect(signatureMatchesAddress(signed.signature, bodyHash, addressForKey(TEST_KEY))).toBe(true);
  });

  it("is case-insensitive", () => {
    const addr = addressForKey(TEST_KEY);
    expect(signatureMatchesAddress(signed.signature, bodyHash, addr.toUpperCase())).toBe(true);
  });

  it("returns false for an unrelated address", () => {
    expect(signatureMatchesAddress(signed.signature, bodyHash, addressForKey(OTHER_KEY))).toBe(
      false,
    );
  });

  it("DETECTS TAMPERING: a body hash that was actually signed by a different key doesn't match", () => {
    const otherSigned = signPrintBody(body, OTHER_KEY);
    const otherHash = printBodyHashHex(otherSigned);
    expect(signatureMatchesAddress(otherSigned.signature, otherHash, addressForKey(TEST_KEY))).toBe(
      false,
    );
  });

  it("throws on a malformed signature rather than silently reporting no match", () => {
    expect(() => recoverSignerCandidates("0xdead", bodyHash)).toThrow(/64-byte/);
  });
});
