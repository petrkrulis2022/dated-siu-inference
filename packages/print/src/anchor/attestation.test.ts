import { describe, expect, it } from "vitest";
import { StubAttestationClient } from "./attestation.js";

describe("StubAttestationClient", () => {
  it("is honestly labelled as a stub, never a real transaction", () => {
    // The dangerous failure mode this guards against: a stub that fabricates a
    // plausible-looking tx_hash would be indistinguishable from a real anchor to anyone
    // reading the print file.
    return new StubAttestationClient().postPrint("0xabc", "SIU-2026a").then((result) => {
      expect(result.status).toBe("stub");
      expect(result.tx_hash).toBeUndefined();
      expect(result.chain).toBe("base");
      expect(result.notes).toMatch(/not deployed|no on-chain call/i);
    });
  });

  it("records when the (stub) call happened", async () => {
    const result = await new StubAttestationClient().postPrint("0xabc", "SIU-2026a");
    expect(result.posted_at).toBeTruthy();
    expect(() => new Date(result.posted_at as string)).not.toThrow();
  });
});
