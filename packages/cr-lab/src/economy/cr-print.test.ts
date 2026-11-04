import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import type { ModelPrice } from "../runner/prices.js";
import type { AnswerRecord } from "../runner/records.js";
import type { TaskId } from "../tasks/instances.js";
import { crPrint, dailyCosts, haircut, modelCost, QUALIFYING_PASS_RATE } from "./cr-print.js";

const PRICE: ModelPrice = { priceInUsdPer1M: "1", priceOutUsdPer1M: "2" };

let n = 0;
const rec = (
  o: Partial<AnswerRecord> & Pick<AnswerRecord, "model" | "task" | "passed" | "usd">,
): AnswerRecord => ({
  schema: 1,
  window: "2026-10-20",
  part: "snapshot",
  instance: `${o.task}-${o.window ?? "2026-10-20"}-${++n}`,
  provider: "anthropic",
  key: "CR_ANTHROPIC_API_KEY",
  at: "2026-10-20T12:00:00.000Z",
  data_sha256: "d".repeat(64),
  prompt_sha256: "p".repeat(64),
  day_sha256: "s".repeat(64),
  fenced: false,
  failure_classes: [],
  failures: [],
  tokens: { input: 100, output: 100, reasoning: 0, cached_input: 0 },
  latency_ms: 1,
  deviations: [],
  raw_output: "",
  ...o,
});

/** one pass per task at the given cost, for model `m` on `day` */
const fullDay = (m: string, day: string, usd: Record<TaskId, string>): AnswerRecord[] =>
  (Object.keys(usd) as TaskId[]).map((task) =>
    rec({ model: m, task, passed: true, usd: usd[task], window: day }),
  );

describe("a model's cost per SIU", () => {
  it("is the sum over the four types of cost ÷ passes, counting failed answers' cost", () => {
    const rs = [
      ...fullDay("m", "2026-10-20", {
        "CR-VS": "0.30",
        "CR-PL": "0.10",
        "CR-UO": "0.02",
        "CR-SM": "0.02",
      }),
      rec({ model: "m", task: "CR-VS", passed: false, usd: "0.30" }),
    ];
    const c = modelCost(rs, "m", "frontier", ["2026-10-20"], PRICE);
    // CR-VS: 0.60 over 1 pass; the rest one pass each
    expect(c.costPerSiu?.toFixed(6)).toBe("0.740000");
    expect(c.measuredRate?.toFixed(6)).toBe(new D(1).div("0.74").toFixed(6));
    expect(c.perType["CR-VS"]).toMatchObject({ answers: 2, passes: 1 });
    expect(c.perType["CR-VS"].passRate?.toFixed(2)).toBe("0.50");
  });

  it("has no cost per SIU, and no measured rate, when one type has no pass", () => {
    const rs = [
      ...fullDay("m", "2026-10-20", { "CR-PL": "0.1", "CR-UO": "0.1", "CR-SM": "0.1" } as Record<
        TaskId,
        string
      >),
      rec({ model: "m", task: "CR-VS", passed: false, usd: "0.1" }),
    ];
    const c = modelCost(rs, "m", "commodity", ["2026-10-20"], PRICE);
    expect(c.costPerSiu).toBeUndefined();
    expect(c.measuredRate).toBeUndefined();
  });

  it("qualifies a type at exactly 80% and not below (read per type, D124)", () => {
    expect(QUALIFYING_PASS_RATE.toFixed(1)).toBe("0.8");
    const rs: AnswerRecord[] = [];
    for (let i = 0; i < 5; i++)
      rs.push(rec({ model: "m", task: "CR-PL", passed: i < 4, usd: "0.01" })); // 4/5 = 80%
    for (let i = 0; i < 10; i++)
      rs.push(rec({ model: "m", task: "CR-VS", passed: i < 7, usd: "0.01" })); // 7/10 = 70%
    const c = modelCost(rs, "m", "commodity", ["2026-10-20"], PRICE);
    expect(c.perType["CR-PL"].qualified).toBe(true);
    expect(c.perType["CR-VS"].qualified).toBe(false);
    expect(c.perType["CR-UO"].qualified).toBe(false); // no answer is not a qualification
    expect(c.qualifiedTasks).toEqual(["CR-PL"]);
  });

  it("counts snapshot-mode answers only: MCP sessions, other days and other models never enter", () => {
    const rs = [
      ...fullDay("m", "2026-10-20", {
        "CR-VS": "0.1",
        "CR-PL": "0.1",
        "CR-UO": "0.1",
        "CR-SM": "0.1",
      }),
      rec({ model: "m", task: "CR-PL", passed: false, usd: "9", part: "mcp" }),
      rec({ model: "m", task: "CR-PL", passed: false, usd: "9", window: "2026-10-21" }),
      rec({ model: "other", task: "CR-PL", passed: false, usd: "9" }),
      rec({ model: "m", task: "CR-PL", passed: false, usd: "0.1", part: "dry-run" }),
    ];
    const c = modelCost(rs, "m", "frontier", ["2026-10-20"], PRICE);
    expect(c.perType["CR-PL"]).toMatchObject({ answers: 2, passes: 1 });
    expect(c.perType["CR-PL"].costUsd.toFixed(2)).toBe("0.20");
  });

  it("uses the headline cost: a retried answer under the print's allowance has its cut-off first call taken off", () => {
    const retried = rec({
      model: "m",
      task: "CR-PL",
      passed: true,
      usd: "1",
      tokens: { input: 2000, output: 6000, reasoning: 5000, cached_input: 0 },
      deviations: ["retried with reasoning accommodated"],
      stop_reason: "end_turn",
    });
    const rs = [
      ...fullDay("m", "2026-10-20", { "CR-VS": "0", "CR-UO": "0", "CR-SM": "0" } as Record<
        TaskId,
        string
      >),
      retried,
    ];
    const c = modelCost(rs, "m", "frontier", ["2026-10-20"], PRICE);
    // waste = half the input (1000 tokens at $1/M) plus the print's CR-PL allowance (4000 tokens at $2/M) = 0.001 + 0.008
    expect(c.perType["CR-PL"].costUsd.toFixed(6)).toBe("0.991000");
  });

  it("leaves out, and counts, an answer whose headline cost cannot be derived", () => {
    const cutTwice = rec({
      model: "m",
      task: "CR-PL",
      passed: false,
      usd: "1",
      deviations: ["retried with reasoning accommodated"],
      stop_reason: "max_tokens",
    });
    const rs = [
      ...fullDay("m", "2026-10-20", {
        "CR-VS": "0.1",
        "CR-PL": "0.1",
        "CR-UO": "0.1",
        "CR-SM": "0.1",
      }),
      cutTwice,
    ];
    const c = modelCost(rs, "m", "frontier", ["2026-10-20"], PRICE);
    expect(c.perType["CR-PL"]).toMatchObject({ answers: 1, passes: 1, notDerivable: 1 });
    expect(c.perType["CR-PL"].costUsd.toFixed(2)).toBe("0.10");
  });
});

describe("the CR lab print", () => {
  const cost = (model: string, grade: "frontier" | "commodity", usd?: string) => ({
    model,
    grade,
    days: ["2026-10-20"],
    perType: {} as never,
    qualifiedTasks: [],
    ...(usd !== undefined ? { costPerSiu: new D(usd) } : {}),
  });

  it("is the mean cost per SIU of the grade's issuers that have one, rounded once, half up, to nano-USD", () => {
    const p = crPrint(
      [
        cost("a", "commodity", "0.0000000010"),
        cost("b", "commodity", "0.0000000021"),
        cost("f", "frontier", "5"),
      ],
      "commodity",
    );
    // mean 0.00000000155 → 1.55 nano → half up → 2 nano
    expect(p.nanoUsdPerSiu).toBe(2n);
    expect(p.usdPerSiu).toBe("0.000000002");
    expect(p.issuers).toEqual(["a", "b"]);
  });

  it("rounds a half down-side value down (half up, not up)", () => {
    const p = crPrint([cost("a", "commodity", "0.0000000014999")], "commodity");
    expect(p.nanoUsdPerSiu).toBe(1n);
  });

  it("names issuers without a cost and leaves them out of the mean", () => {
    const p = crPrint([cost("a", "commodity", "0.003"), cost("x", "commodity")], "commodity");
    expect(p.withoutCost).toEqual(["x"]);
    expect(p.nanoUsdPerSiu).toBe(3_000_000n);
  });

  it("does not exist for a grade with no issuer that has a cost", () => {
    const p = crPrint([cost("x", "commodity"), cost("f", "frontier", "1")], "commodity");
    expect(p.usdPerSiu).toBeUndefined();
    expect(p.nanoUsdPerSiu).toBeUndefined();
  });
});

describe("the haircut", () => {
  it("is budget ÷ (1 + the nearest-rank 95th-percentile rise), falls counting as zero", () => {
    const h = haircut(
      [
        { day: "2026-10-17", costPerSiu: new D("1.00") },
        { day: "2026-10-18", costPerSiu: new D("1.10") }, // +10%
        { day: "2026-10-19", costPerSiu: new D("0.99") }, // -10% → 0
        { day: "2026-10-20", costPerSiu: new D("1.188") }, // +20%
      ],
      new D("12"),
    );
    expect(h.pairs).toBe(3);
    // three rises: with fewer than twenty, the nearest rank is the largest
    expect(h.p95Rise.toFixed(4)).toBe("0.2000");
    expect(h.budgetAfterHaircutUsd.toFixed(4)).toBe("10.0000");
    expect(h.rises.map((r) => r.toFixed(2))).toEqual(["0.10", "0.00", "0.20"]);
  });

  it("pairs only consecutive days that both have a cost", () => {
    const h = haircut(
      [
        { day: "2026-10-17", costPerSiu: new D("1") },
        { day: "2026-10-18" },
        { day: "2026-10-19", costPerSiu: new D("3") },
        { day: "2026-10-21", costPerSiu: new D("9") },
      ],
      new D("10"),
    );
    expect(h.pairs).toBe(0);
    expect(h.p95Rise.toFixed(1)).toBe("0.0");
    expect(h.budgetAfterHaircutUsd.toFixed(1)).toBe("10.0");
  });

  it("takes the 19th of twenty rises as the 95th percentile", () => {
    const daily = [{ day: "2026-09-30", costPerSiu: new D(1) }];
    let cost = new D(1);
    for (let i = 1; i <= 20; i++) {
      cost = cost.times(new D(1).plus(new D(i).div(100))); // rises of 1%..20%
      const d = new Date(Date.UTC(2026, 9, i));
      daily.push({ day: d.toISOString().slice(0, 10), costPerSiu: cost });
    }
    const h = haircut(daily, new D(1));
    expect(h.pairs).toBe(20);
    expect(h.p95Rise.toFixed(2)).toBe("0.19");
  });
});

describe("daily costs", () => {
  it("gives each day its own cost per SIU, or none when a type had no pass that day", () => {
    const rs = [
      ...fullDay("m", "2026-10-20", {
        "CR-VS": "0.1",
        "CR-PL": "0.1",
        "CR-UO": "0.1",
        "CR-SM": "0.1",
      }),
      ...fullDay("m", "2026-10-21", { "CR-PL": "0.1", "CR-UO": "0.1", "CR-SM": "0.1" } as Record<
        TaskId,
        string
      >),
    ];
    const d = dailyCosts(rs, "m", "commodity", ["2026-10-20", "2026-10-21"], PRICE);
    expect(d[0]?.costPerSiu?.toFixed(1)).toBe("0.4");
    expect(d[1]?.costPerSiu).toBeUndefined();
  });
});
