import { describe, expect, it, vi } from "vitest";
import { AdapterHttpError } from "./adapters/types.js";
import { classifyFailure, isRetryableError, withBackoff } from "./retry.js";

describe("isRetryableError", () => {
  it("treats 429 and 5xx as retryable", () => {
    expect(isRetryableError(new AdapterHttpError("rate limited", 429, {}))).toBe(true);
    expect(isRetryableError(new AdapterHttpError("server error", 500, {}))).toBe(true);
    expect(isRetryableError(new AdapterHttpError("server error", 503, {}))).toBe(true);
  });

  it("treats other 4xx as not retryable", () => {
    expect(isRetryableError(new AdapterHttpError("bad request", 400, {}))).toBe(false);
    expect(isRetryableError(new AdapterHttpError("unauthorized", 401, {}))).toBe(false);
  });

  it("treats a raw network failure as retryable", () => {
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("connect ECONNRESET"))).toBe(true);
  });

  it("treats an unrelated error as not retryable", () => {
    expect(isRetryableError(new Error("unexpected token in JSON"))).toBe(false);
  });

  it("treats a credit-exhaustion 400 as not retryable, even though other 4xx-adjacent statuses can be", () => {
    expect(
      isRetryableError(
        new AdapterHttpError("Anthropic request failed: 400", 400, {
          error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. ..." },
        }),
      ),
    ).toBe(false);
  });

  it("treats a 402 as not retryable even though it would otherwise fall outside the 429/5xx band", () => {
    expect(isRetryableError(new AdapterHttpError("payment required", 402, {}))).toBe(false);
  });

  it("treats an insufficient_quota 429 as not retryable, unlike a genuine rate-limit 429", () => {
    expect(
      isRetryableError(
        new AdapterHttpError("quota exceeded", 429, { error: { type: "insufficient_quota" } }),
      ),
    ).toBe(false);
  });
});

describe("classifyFailure", () => {
  it("classifies Anthropic's real credit-exhaustion 400 as billing_exhausted, not auth_or_bad_request", () => {
    const err = new AdapterHttpError("Anthropic request failed: 400", 400, {
      error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. ..." },
    });
    expect(classifyFailure(err)).toBe("billing_exhausted");
  });

  it("classifies a 402 as billing_exhausted", () => {
    expect(classifyFailure(new AdapterHttpError("payment required", 402, {}))).toBe("billing_exhausted");
  });

  it("classifies an insufficient_quota 429 as billing_exhausted rather than rate_limit", () => {
    const err = new AdapterHttpError("quota exceeded", 429, { error: { type: "insufficient_quota" } });
    expect(classifyFailure(err)).toBe("billing_exhausted");
  });

  it("still classifies a genuine rate-limit 429 as rate_limit", () => {
    expect(classifyFailure(new AdapterHttpError("rate limited", 429, { error: { type: "rate_limit_error" } }))).toBe(
      "rate_limit",
    );
  });

  it("still classifies an unrelated 400 as auth_or_bad_request", () => {
    expect(classifyFailure(new AdapterHttpError("bad request", 400, { error: "malformed prompt" }))).toBe(
      "auth_or_bad_request",
    );
  });
});

describe("withBackoff", () => {
  const fastOpts = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5 };

  it("returns the result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withBackoff(fn, fastOpts);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a retryable error until it succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        throw new AdapterHttpError("rate limited", 429, {});
      }
      return "ok";
    });
    const result = await withBackoff(fn, fastOpts);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fn = vi.fn(async () => {
      throw new AdapterHttpError("server error", 500, {});
    });
    await expect(withBackoff(fn, fastOpts)).rejects.toThrow(/server error/);
    expect(fn).toHaveBeenCalledTimes(fastOpts.maxRetries + 1);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn(async () => {
      throw new AdapterHttpError("bad api key", 401, {});
    });
    await expect(withBackoff(fn, fastOpts)).rejects.toThrow(/bad api key/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
