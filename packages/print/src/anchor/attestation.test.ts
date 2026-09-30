import { describe, expect, it } from "vitest";
import { StubAttestationClient, type AttestationClient } from "./attestation.js";

describe("StubAttestationClient", () => {
  it("is honestly labelled as a stub, never a real transaction", () => {
    // The dangerous failure mode this guards against: a stub that fabricates a
    // plausible-looking tx_hash would be indistinguishable from a real anchor to anyone
    // reading the print file.
    // Through the interface deliberately: the stub declares zero parameters (see its own
    // comment) and production only ever reaches it as an AttestationClient.
    const client: AttestationClient = new StubAttestationClient();
    return client.postPrint("0xabc", "SIU-2026a").then((result) => {
      expect(result.status).toBe("stub");
      expect(result.tx_hash).toBeUndefined();
      expect(result.chain).toBe("base");
      expect(result.notes).toMatch(/not deployed|no on-chain call/i);
    });
  });

  it("records when the (stub) call happened", async () => {
    const client: AttestationClient = new StubAttestationClient();
    const result = await client.postPrint("0xabc", "SIU-2026a");
    expect(result.posted_at).toBeTruthy();
    expect(() => new Date(result.posted_at as string)).not.toThrow();
  });
});
