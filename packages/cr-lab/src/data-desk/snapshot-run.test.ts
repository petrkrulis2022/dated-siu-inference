import { describe, expect, it } from "vitest";
import { BLOCKWORKS_PER_HOUR, snapshotGovernor, snapshotGroupFor } from "./snapshot-run.js";

describe("the snapshot's pacing (Blockworks' trial limit: 25 per clock hour, every route shared, refusals counted)", () => {
  it("sends every request through one group and never more than 24 in a rolling hour, waiting rather than stopping", async () => {
    let now = 1_800_000_000_000;
    const slept: number[] = [];
    const g = snapshotGovernor({
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    const starts: number[] = [];
    const call = async () =>
      g.run(snapshotGroupFor(), () => {
        starts.push(now);
        return Promise.resolve({ status: 200, value: null });
      });
    for (let i = 0; i < 30; i++) await call();
    expect(starts).toHaveLength(30);
    // in every rolling hour, at most 24 started
    for (const t of starts)
      expect(starts.filter((x) => x >= t && x < t + 3_600_000).length).toBeLessThanOrEqual(
        BLOCKWORKS_PER_HOUR,
      );
    // the 25th waited until the first was an hour old
    expect((starts[24] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(3_600_000);
    expect(BLOCKWORKS_PER_HOUR).toBe(24);
  });

  it("counts a refused request (429) and its retry against the same hourly budget", async () => {
    let now = 1_800_000_000_000;
    const g = snapshotGovernor({
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    let n = 0;
    await g.run(snapshotGroupFor(), () =>
      Promise.resolve(n++ === 0 ? { status: 429, value: null } : { status: 200, value: null }),
    );
    const r = g.report().find((x) => x.group === snapshotGroupFor());
    expect(r?.requestsToday).toBe(2);
    expect(g.report()).toHaveLength(1);
  });
});
