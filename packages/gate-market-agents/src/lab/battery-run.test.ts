import { describe, expect, it } from "vitest";
import { BATTERY_MODELS, CAPS, HAIKU_THINKING_BUDGET, addUsd, callCostUsd, evaluateStop, paramsFor, pilotPlan, planCalls, replicationPlan, stage1Plan, stage2Plan, type BatteryCall } from "./battery-run.js";
import { CELL_IDS } from "./probe-battery.js";

const call = (over: Partial<BatteryCall> = {}): BatteryCall => ({
  key: "k",
  label: "t",
  cell: "P0",
  arm: "A",
  model: "claude-haiku-4-5",
  sample: 1,
  at: "2026-10-09T00:00:00Z",
  promptSha256: "x",
  latencyMs: 1,
  reply: "{}",
  parsed: { outcome: "payment", route: "usdc", tool: "pay_with_usdc" },
  usage: { input: 3000, output: 100, cached_input: 0, reasoning: 0 },
  usd: "0.0035",
  deviations: [],
  ...over,
});

describe("the plans", () => {
  it("stage 1 is 780 calls: 13 cells x 12 samples x (A and B for two models, C for sonnet)", () => {
    const p = stage1Plan("s1");
    expect(p).toHaveLength(780);
    expect(p.filter((c) => c.arm === "C").every((c) => c.model === "claude-sonnet-5")).toBe(true);
    expect(p.filter((c) => c.arm === "C")).toHaveLength(156);
    for (const cell of CELL_IDS) for (const model of BATTERY_MODELS) expect(p.filter((c) => c.cell === cell && c.model === model && c.arm === "A")).toHaveLength(12);
  });

  it("stage 2 is 156 calls, all haiku arm C", () => {
    const p = stage2Plan("s2");
    expect(p).toHaveLength(156);
    expect(p.every((c) => c.model === "claude-haiku-4-5" && c.arm === "C")).toBe(true);
  });

  it("the pilot is six calls on P0, one per arm per model, haiku's arm C included", () => {
    const p = pilotPlan("pilot");
    expect(p).toHaveLength(6);
    expect(p.every((c) => c.cell === "P0")).toBe(true);
    expect(p.some((c) => c.model === "claude-haiku-4-5" && c.arm === "C")).toBe(true);
  });

  it("has unique keys, is the same every time for a label, and differs between labels", () => {
    const a = stage1Plan("s1");
    expect(new Set(a.map((c) => c.key)).size).toBe(a.length);
    expect(stage1Plan("s1").map((c) => c.key)).toEqual(a.map((c) => c.key));
    expect(stage1Plan("other").map((c) => c.sample)).not.toEqual(a.map((c) => c.sample));
  });

  it("interleaves arms: no arm runs in a block", () => {
    const p = stage1Plan("s1");
    let longest = 1;
    let run = 1;
    for (let i = 1; i < p.length; i++) {
      run = p[i].arm === p[i - 1].arm && p[i].model === p[i - 1].model ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThan(25);
    // The first hundred calls already touch most cells, arms and models.
    expect(new Set(p.slice(0, 100).map((c) => c.arm)).size).toBe(3);
    expect(new Set(p.slice(0, 100).map((c) => c.cell)).size).toBeGreaterThan(8);
  });

  it("builds a replication batch for chosen cells, arms and models", () => {
    const p = replicationPlan("rep1", ["P5", "P0"], ["claude-haiku-4-5"], ["A"]);
    expect(p).toHaveLength(24);
    expect(planCalls({ label: "x", cells: ["P0"], models: ["claude-sonnet-5"], arms: () => ["A", "B"], samples: 3 })).toHaveLength(6);
  });
});

describe("what an arm sends", () => {
  it("never sends a temperature, for either model or arm", () => {
    for (const m of BATTERY_MODELS) for (const arm of ["A", "B", "C"] as const) expect(paramsFor(m, arm).omit_temperature).toBe(true);
  });

  it("asks for no thinking in A and B, a summary for sonnet in C and a manual budget for haiku in C", () => {
    expect(paramsFor("claude-sonnet-5", "A").thinking).toBeUndefined();
    expect(paramsFor("claude-haiku-4-5", "B").thinking).toBeUndefined();
    expect(paramsFor("claude-sonnet-5", "C").thinking).toEqual({ mode: "summarized" });
    expect(paramsFor("claude-haiku-4-5", "C").thinking).toEqual({ mode: "manual", budget_tokens: HAIKU_THINKING_BUDGET });
    expect(HAIKU_THINKING_BUDGET).toBeGreaterThanOrEqual(1024);
    expect(HAIKU_THINKING_BUDGET).toBeLessThan(paramsFor("claude-haiku-4-5", "C").max_tokens);
  });
});

describe("cost", () => {
  it("is exact decimal arithmetic from token counts", () => {
    expect(callCostUsd({ input: 3000, output: 100 }, "1", "5")).toBe("0.0035");
    expect(callCostUsd({ input: 3000, output: 100 }, "2", "10")).toBe("0.007");
    expect(callCostUsd({ input: 1, output: 0 }, "2", "10")).toBe("0.000002");
    expect(addUsd("0.1", "0.2")).toBe("0.3");
  });
});

describe("evaluateStop", () => {
  it("continues while nothing is wrong", () => {
    expect(evaluateStop([call(), call({ key: "k2" })], "10")).toEqual({ stop: false });
  });

  it("stops at the cap", () => {
    expect(evaluateStop([call({ usd: "0.2" }), call({ usd: "0.1" })], CAPS.pilot).stop).toBe(true);
    expect(evaluateStop([call({ usd: "0.2" })], CAPS.pilot).stop).toBe(false);
  });

  it("stops on an error that is not a reply, and on a refusal", () => {
    expect(evaluateStop([call({ error: "HTTP 400" })], "10").reason).toMatch(/error/);
    expect(evaluateStop([call({ stopReason: "refusal" })], "10").reason).toMatch(/refused/);
  });

  it("stops when an arm fails to parse more than a fifth of at least twenty replies, and not before twenty", () => {
    const bad = Array.from({ length: 6 }, (_, i) => call({ key: `b${i}`, parsed: { outcome: "unparsed" } }));
    const good = Array.from({ length: 14 }, (_, i) => call({ key: `g${i}` }));
    expect(evaluateStop([...bad, ...good], "10").stop).toBe(true);
    expect(evaluateStop([...bad.slice(0, 3), ...good.slice(0, 5)], "10").stop).toBe(false);
    expect(evaluateStop([...bad.slice(0, 4), ...good.slice(0, 16)], "10").stop).toBe(false);
  });
});
