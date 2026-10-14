import { describe, expect, it } from "vitest";
import {
  AnchorSkipped,
  FallbackAttestationClient,
  SkippingAttestationClient,
  StubAttestationClient,
  anchorBestEffort,
  describeFailure,
  redactUrls,
  type AnchorResult,
  type AttestationClient,
} from "./attestation.js";

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

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef";

describe("redactUrls and describeFailure: an RPC key never reaches a print, the repository or a log", () => {
  it("shortens any URL to its host", () => {
    expect(redactUrls(`failed: URL: https://arc-testnet-rpc.crouton.digital/${KEY} Details: x`)).toBe("failed: URL: arc-testnet-rpc.crouton.digital/<redacted> Details: x");
    expect(redactUrls(`wss://host.example/${KEY}?a=1 and http://other.example:8545/path`)).toBe("host.example/<redacted> and other.example:8545/<redacted>");
    expect(redactUrls("nothing to hide")).toBe("nothing to hide");
  });

  it("keeps the first line of an error, redacted and cut to a length a print can carry", () => {
    expect(describeFailure(new Error(`HTTP request failed.\nURL: https://x.example/${KEY}\nDetails: boom`))).toBe("HTTP request failed.");
    expect(describeFailure(new Error(`first https://x.example/${KEY} line`))).not.toContain(KEY);
    expect(describeFailure({ shortMessage: "The contract function reverted.", message: `long ${"x".repeat(900)}` })).toBe("The contract function reverted.");
    expect(describeFailure(new Error("y".repeat(1000))).length).toBeLessThanOrEqual(301);
    expect(describeFailure("a plain string")).toBe("a plain string");
  });
});

describe("anchorBestEffort", () => {
  const ok = (over: Partial<AnchorResult> = {}): AttestationClient => ({ postPrint: async () => ({ chain: "arc-testnet", status: "anchored", tx_hash: "0x01", posted_at: "2026-10-15T00:00:00.000Z", ...over }) });

  it("carries a landed anchor through, under the name it was asked for", async () => {
    expect(await anchorBestEffort({ chainName: "arc-testnet", client: ok() }, "0xhash", "SIU-2026a")).toEqual({ chain: "arc-testnet", status: "anchored", tx_hash: "0x01", posted_at: "2026-10-15T00:00:00.000Z" });
  });

  it("carries already-anchored through with no transaction", async () => {
    const r = await anchorBestEffort({ chainName: "arc-testnet", client: ok({ status: "already-anchored", tx_hash: undefined }) }, "0xhash", "v");
    expect(r.status).toBe("already-anchored");
    expect(r.tx_hash).toBeUndefined();
  });

  it("records a throw as failed, with the reason and without the URL, and never throws itself", async () => {
    const client: AttestationClient = { postPrint: async () => { throw new Error(`HTTP request failed.\nURL: https://rpc.example/${KEY}`); } };
    const r = await anchorBestEffort({ chainName: "arc-testnet", client }, "0xhash", "v");
    expect(r).toEqual({ chain: "arc-testnet", status: "failed", notes: "HTTP request failed." });
  });

  it("records a refused-to-send as skipped, with its reason", async () => {
    const r = await anchorBestEffort({ chainName: "arc-testnet", client: new SkippingAttestationClient("balance too low") }, "0xhash", "v");
    expect(r).toEqual({ chain: "arc-testnet", status: "skipped", notes: "balance too low" });
  });

  it("gives up on a chain that does not answer, and says the late transaction is picked up next run", async () => {
    const r = await anchorBestEffort({ chainName: "arc-testnet", client: { postPrint: () => new Promise<AnchorResult>(() => undefined) }, timeoutMs: 20 }, "0xhash", "v");
    expect(r.status).toBe("failed");
    expect(r.notes).toMatch(/no confirmation within \d+s.*already anchored/);
  });

  it("reads a client that reports a failed send as failed, keeping its transaction hash", async () => {
    const r = await anchorBestEffort({ chainName: "arc-testnet", client: ok({ status: "failed", notes: "mined but not anchored" }) }, "0xhash", "v");
    expect(r).toMatchObject({ status: "failed", tx_hash: "0x01", notes: "mined but not anchored" });
  });

  it("never records a stub as an anchor", async () => {
    expect((await anchorBestEffort({ chainName: "arc-testnet", client: new StubAttestationClient() }, "0xhash", "v")).status).toBe("skipped");
  });
});

describe("FallbackAttestationClient", () => {
  const throws = (message: string): AttestationClient => ({ postPrint: async () => { throw new Error(message); } });
  const lands: AttestationClient = { postPrint: async () => ({ chain: "arc-testnet", status: "anchored", tx_hash: "0x02" }) };

  it("uses the first provider when it works, and does not touch the second", async () => {
    let second = 0;
    const counting: AttestationClient = { postPrint: async () => { second++; return { chain: "arc-testnet", status: "anchored" }; } };
    expect((await new FallbackAttestationClient([lands, counting]).postPrint("0x1", "v")).tx_hash).toBe("0x02");
    expect(second).toBe(0);
  });

  it("falls back to the second provider when the first throws", async () => {
    expect((await new FallbackAttestationClient([throws("provider one is down"), lands]).postPrint("0x1", "v")).tx_hash).toBe("0x02");
  });

  it("throws the last error when every provider fails, so the caller records a failure", async () => {
    await expect(new FallbackAttestationClient([throws("one"), throws("two")]).postPrint("0x1", "v")).rejects.toThrow("two");
  });

  it("does not try another provider after a deliberate skip", async () => {
    let tried = 0;
    const later: AttestationClient = { postPrint: async () => { tried++; return { chain: "arc-testnet", status: "anchored" }; } };
    await expect(new FallbackAttestationClient([new SkippingAttestationClient("low"), later]).postPrint("0x1", "v")).rejects.toBeInstanceOf(AnchorSkipped);
    expect(tried).toBe(0);
  });

  it("needs at least one provider", () => {
    expect(() => new FallbackAttestationClient([])).toThrow(/at least one/);
  });
});
