import { describe, expect, it } from "vitest";
import { createLimiter } from "./concurrency.js";

describe("createLimiter", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      });

    await Promise.all(Array.from({ length: 6 }, task));
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("runs every task exactly once and returns each result", async () => {
    const limit = createLimiter(3);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => limit(async () => i * 2)),
    );
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
  });

  it("propagates a task's rejection without blocking the others", async () => {
    const limit = createLimiter(2);
    const results = await Promise.allSettled([
      limit(async () => "ok-1"),
      limit(async () => {
        throw new Error("boom");
      }),
      limit(async () => "ok-2"),
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok-1" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "ok-2" });
  });
});
