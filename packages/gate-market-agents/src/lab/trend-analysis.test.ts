import { describe, expect, it } from "vitest";
import type { BatteryCall } from "./battery-run.js";
import { CONTINUATION, MIN_PAYMENTS, compareShares, sharePercent, trendRows } from "./trend-analysis.js";
import type { CellId } from "./probe-battery.js";

let n = 0;
const call = (cell: CellId, action: BatteryCall["parsed"]["action"], reason?: string): BatteryCall => ({
  key: `k${n++}`,
  label: "t",
  cell,
  arm: "A",
  model: "claude-sonnet-5",
  sample: 1,
  at: "",
  promptSha256: "",
  latencyMs: 1,
  reply: "",
  parsed: {
    outcome: action.startsWith("pay_") ? "payment" : "not_payment",
    action,
    ...(action.startsWith("pay_") ? { route: action === "pay_usdc" ? ("usdc" as const) : action === "pay_fsiu" ? ("fsiu" as const) : ("split" as const) } : {}),
    ...(reason !== undefined ? { statedReason: reason } : {}),
  },
  usage: { input: 0, output: 0, cached_input: 0, reasoning: 0 },
  usd: "0",
  deviations: [],
});

describe("trendRows", () => {
  const rows = trendRows([
    // rising cell: keeping fSIU (paying USDC) follows the assumption, spending it goes against
    call("T1", "pay_usdc", "Preserving fSIU which has been appreciating with the print."),
    call("T1", "pay_usdc", "Simple."),
    call("T1", "pay_fsiu", "The print rose so USDC costs more dollars."),
    call("T1", "pay_split"),
    // falling cell: spending fSIU follows, paying USDC goes against
    call("T2", "pay_fsiu", "Spending fSIU which is depreciating as the print falls."),
    call("T2", "pay_usdc", "Keep it."),
    call("T2", "request_raw_work", "Buy raw work first."),
    // flat cell makes no assumption
    call("T3", "pay_fsiu", "Fine."),
  ]);
  const get = (cell: string) => rows.find((r) => r.cell === cell)!;

  it("reads a rising cell as: pay USDC follows, pay fSIU goes against, a split is neither", () => {
    const t1 = get("T1");
    expect(t1).toMatchObject({ replies: 4, payments: 4, usdc: 2, fsiu: 1, split: 1 });
    expect(t1.choiceAll).toEqual({ follows: 2, against: 1, neither: 1 });
  });

  it("reads a falling cell the other way round and leaves a non-payment out of the choice", () => {
    const t2 = get("T2");
    expect(t2).toMatchObject({ replies: 3, payments: 2 });
    expect(t2.choiceAll).toEqual({ follows: 1, against: 1, neither: 0 });
  });

  it("makes no assumption in the flat cell", () => {
    expect(get("T3").choiceAll).toEqual({ follows: 0, against: 0, neither: 1 });
  });

  it("counts reasons that cite the direction (frozen category 2) and ones that assume it continues, and reads the choice among them", () => {
    const t1 = get("T1");
    expect(t1.citesDirection).toBeGreaterThanOrEqual(2);
    expect(t1.assumesContinuation).toBe(1);
    expect(t1.choiceAssuming).toEqual({ follows: 1, against: 0, neither: 0 });
    expect(get("T2").assumesContinuation).toBe(1);
    expect(get("T2").choiceAssuming).toEqual({ follows: 1, against: 0, neither: 0 });
  });

  it("matches the two reasons the person quoted", () => {
    expect(CONTINUATION.test("preserving fSIU which has been appreciating with the print")).toBe(true);
    expect(CONTINUATION.test("using fSIU (which is depreciating as the print falls each round)")).toBe(true);
    expect(CONTINUATION.test("the print rose 15% so USDC costs more dollars")).toBe(false);
  });
});

describe("compareShares", () => {
  const rowsOf = (t1: [number, number], t3: [number, number], t2: [number, number]) =>
    trendRows([
      ...Array.from({ length: t1[0] }, () => call("T1", "pay_fsiu")),
      ...Array.from({ length: t1[1] }, () => call("T1", "pay_usdc")),
      ...Array.from({ length: t3[0] }, () => call("T3", "pay_fsiu")),
      ...Array.from({ length: t3[1] }, () => call("T3", "pay_usdc")),
      ...Array.from({ length: t2[0] }, () => call("T2", "pay_fsiu")),
      ...Array.from({ length: t2[1] }, () => call("T2", "pay_usdc")),
    ]);

  it("gives shares as whole percentages and differences in points", () => {
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(0, 0)).toBeUndefined();
    const cmp = compareShares(rowsOf([2, 10], [6, 6], [10, 2]));
    const fall = cmp.find((c) => c.pair === "T2 falling against T1 rising")!;
    expect(fall.deltaPoints).toBe(83 - 17);
    expect(fall.crossesThreshold).toBe(true);
    expect(fall.signAsExtrapolationPredicts).toBe(true);
  });

  it("marks a pair with fewer than the minimum payments on a side as too few to read", () => {
    const cmp = compareShares(rowsOf([1, 2], [6, 6], [10, 2]));
    expect(MIN_PAYMENTS).toBe(4);
    const rise = cmp.find((c) => c.pair === "T1 rising against T3 flat")!;
    expect(rise.readable).toBe(false);
    expect(rise.crossesThreshold).toBe(false);
  });

  it("calls a sign the opposite of the extrapolation reading when falling is lower than rising", () => {
    const cmp = compareShares(rowsOf([10, 2], [6, 6], [2, 10]));
    expect(cmp.find((c) => c.pair === "T2 falling against T1 rising")!.signAsExtrapolationPredicts).toBe(false);
  });
});
