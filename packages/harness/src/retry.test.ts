import { describe, expect, it, vi } from "vitest";
import { AdapterHttpError } from "./adapters/types.js";
import { isRetryableError, withBackoff } from "./retry.js";

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
