import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { classIdFor, resolveClassId } from "./class-id.js";

describe("resolveClassId", () => {
  it("accepts the plain class name an agent actually has — the nine failed calls that made this a boundary concern", () => {
    // ISSUER-B passed "code" nine times and every call died on
    // `Size of bytes "code" (bytes4) does not match expected size (bytes32)`. The class is
    // called "code" in its brief and in every line it was shown; nothing told it a hash was
    // wanted, or what the hash was.
    expect(resolveClassId("code")).toBe(keccak256(stringToBytes("code")));
    expect(resolveClassId("extract")).toBe(classIdFor("extract"));
  });

  it("passes an already-hashed id through untouched, so existing callers are unaffected", () => {
    const hashed = classIdFor("code");
    expect(resolveClassId(hashed)).toBe(hashed);
  });

  it("tolerates surrounding whitespace, which a model emits more often than it should", () => {
    expect(resolveClassId("  code  ")).toBe(classIdFor("code"));
  });

  it("hashes anything that is not a 32-byte hex id, rather than guessing at a near-miss", () => {
    // A 4-byte hex string is not a class id; treating it as one is exactly the silent-wrong-answer
    // this boundary must not produce. It hashes, and the resulting lookup simply finds no lot.
    expect(resolveClassId("0xdeadbeef")).toBe(classIdFor("0xdeadbeef"));
  });
});
