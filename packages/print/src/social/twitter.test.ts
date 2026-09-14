import { describe, expect, it, vi, afterEach } from "vitest";
import { buildOAuth1Header, postTweet, type TwitterCredentials } from "./twitter.js";

describe("buildOAuth1Header", () => {
  it("is deterministic: identical inputs (including nonce/timestamp) give an identical signature", () => {
    // Not a claim of correctness against an external reference (see this repo's own note in
    // postTweet's real-live verification step instead — a wrong signature is rejected outright
    // by the real API, the actual ground truth here) — this pins down that the function is a
    // pure computation over its inputs, not something that varies run to run for no reason.
    const credentials: TwitterCredentials = { apiKey: "k", apiKeySecret: "s", accessToken: "t", accessTokenSecret: "ts" };
    const a = buildOAuth1Header("POST", "https://api.twitter.com/2/tweets", credentials, {}, "fixed-nonce", "1700000000");
    const b = buildOAuth1Header("POST", "https://api.twitter.com/2/tweets", credentials, {}, "fixed-nonce", "1700000000");
    expect(a).toBe(b);
  });

  it("includes every required OAuth 1.0a field in the header", () => {
    const credentials: TwitterCredentials = {
      apiKey: "consumer-key",
      apiKeySecret: "s",
      accessToken: "user-token",
      accessTokenSecret: "ts",
    };
    const header = buildOAuth1Header("POST", "https://api.twitter.com/2/tweets", credentials, {}, "n", "1");
    expect(header).toMatch(/^OAuth /);
    for (const field of [
      'oauth_consumer_key="consumer-key"',
      'oauth_nonce="n"',
      'oauth_signature_method="HMAC-SHA1"',
      'oauth_timestamp="1"',
      'oauth_token="user-token"',
      'oauth_version="1.0"',
    ]) {
      expect(header).toContain(field);
    }
    expect(header).toMatch(/oauth_signature="[^"]+"/);
  });

  it("percent-encodes the signature's own base64 characters in the header", () => {
    const credentials: TwitterCredentials = {
      apiKey: "k",
      apiKeySecret: "s",
      accessToken: "t",
      accessTokenSecret: "ts",
    };
    const header = buildOAuth1Header("POST", "https://api.twitter.com/2/tweets", credentials, {}, "n", "1");
    // A raw base64 signature can contain +, /, = — none of those may appear unescaped in the
    // header's oauth_signature="..." value.
    const sigMatch = header.match(/oauth_signature="([^"]*)"/);
    expect(sigMatch).not.toBeNull();
    expect(sigMatch?.[1]).not.toMatch(/[+/=]/);
  });

  it("produces a different signature for a different nonce, all else equal", () => {
    const credentials: TwitterCredentials = { apiKey: "k", apiKeySecret: "s", accessToken: "t", accessTokenSecret: "ts" };
    const a = buildOAuth1Header("POST", "https://api.twitter.com/2/tweets", credentials, {}, "nonce-a", "1");
    const b = buildOAuth1Header("POST", "https://api.twitter.com/2/tweets", credentials, {}, "nonce-b", "1");
    expect(a).not.toBe(b);
  });
});

describe("postTweet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const credentials: TwitterCredentials = { apiKey: "k", apiKeySecret: "s", accessToken: "t", accessTokenSecret: "ts" };

  it("returns the real tweet id and a working status URL on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 201,
        json: async () => ({ data: { id: "1234567890", text: "hi" } }),
      })),
    );
    const result = await postTweet("hi", credentials);
    expect(result).toEqual({ id: "1234567890", url: "https://x.com/touchstoneassay/status/1234567890" });
  });

  it("throws with the real API error body, never silently swallowing a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ errors: [{ message: "Unauthorized" }] }),
      })),
    );
    await expect(postTweet("hi", credentials)).rejects.toThrow(/401/);
  });
});
