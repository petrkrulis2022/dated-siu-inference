import { describe, expect, it, vi } from "vitest";
import { retryUntilConclusive } from "./retry.js";

describe("retryUntilConclusive", () => {
  it("returns immediately when the first read is already conclusive", async () => {
    const read = vi.fn().mockResolvedValue(42);
    const result = await retryUntilConclusive(read, (v) => v > 0, { delayMs: 0 });
    expect(result).toBe(42);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retries until a read is conclusive, within the attempt budget", async () => {
    const read = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(7);
    const result = await retryUntilConclusive(read, (v) => v > 0, {
      attempts: 5,
      delayMs: 0,
    });
    expect(result).toBe(7);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("exhausts its attempts and returns the last non-conclusive value, rather than throwing", async () => {
    const read = vi.fn().mockResolvedValue(0);
    const result = await retryUntilConclusive(read, (v) => v > 0, {
      attempts: 3,
      delayMs: 0,
    });
    expect(result).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("defaults to 5 attempts when none is given", async () => {
    const read = vi.fn().mockResolvedValue(0);
    await retryUntilConclusive(read, (v) => v > 0, { delayMs: 0 });
    expect(read).toHaveBeenCalledTimes(5);
  });

  it("respects a custom delayMs between attempts", async () => {
    let calls = 0;
    const read = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(calls >= 2);
    });
    const start = Date.now();
    await retryUntilConclusive(read, (v) => v, { attempts: 2, delayMs: 50 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});
