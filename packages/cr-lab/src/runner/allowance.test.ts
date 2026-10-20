/**
 * The output-allowance rule and the two cost bases (D113). The records below are synthetic and labelled so: token counts and prices chosen to make the arithmetic checkable by hand.
 * Prices: $2 per million input tokens, $10 per million output tokens; the print's allowance for CR-PL is 4,000 tokens and its retry budget is 4,000 x (1 + 3) = 16,000.
 */
import { readFileSync } from "node:fs";
import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import {
  ALLOWANCES_PATH,
  PRINT_ALLOWANCE,
  deriveAllowances,
  headlineCost,
  loadAllowances,
  observationOf,
  printMethodCost,
  type AllowanceFile,
} from "./allowance.js";
import type { ModelPrice } from "./prices.js";
import type { AnswerRecord } from "./records.js";
import { costBasisTable } from "./tables.js";

const PRICE: ModelPrice = { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" };
const RETRY_NOTE =
  "completion truncated by mandatory reasoning (stop_reason max_tokens, 4000 reasoning tokens against a 4000-token task budget): retried with reasoning accommodated above the task budget";

const rec = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  schema: 1,
  window: "2026-10-19",
  part: "snapshot",
  task: "CR-PL",
  instance: "CR-PL-1",
  model: "m",
  provider: "anthropic",
  key: "CR_ANTHROPIC_API_KEY",
  at: "2026-10-19T12:00:00Z",
  data_sha256: "a",
  prompt_sha256: "b",
  day_sha256: "c",
  passed: true,
  fenced: false,
  failure_classes: [],
  failures: [],
  usd: "0",
  tokens: { input: 0, output: 0, reasoning: 0, cached_input: 0 },
  latency_ms: 1,
  deviations: [],
  raw_output: "{}",
  ...over,
});
/** cost of one call at the test prices, as a decimal string */
const cost = (input: number, output: number): string =>
  new D(input).times(2).plus(new D(output).times(10)).div(1_000_000).toFixed();

/** An answer run under the print's allowance and retried: two calls, each with a 7,500-token prompt, a cut-off first call of 4,000 and a second call of 6,001. */
const aRunRetried = (): AnswerRecord =>
  rec({
    usd: cost(15_000, 10_001),
    tokens: { input: 15_000, output: 10_001, reasoning: 9_990, cached_input: 0 },
    deviations: [RETRY_NOTE],
  });
/** The same answer run under the headline allowance: one call of 6,001 tokens. */
const bRun = (over: Partial<AnswerRecord> = {}): AnswerRecord =>
  rec({
    allowance_tokens: 20_000,
    usd: cost(7_500, 6_001),
    tokens: { input: 7_500, output: 6_001, reasoning: 5_990, cached_input: 0 },
    ...over,
  });

describe("what one answer needed", () => {
  it("is its output when nothing was retried", () => {
    expect(
      observationOf(rec({ tokens: { input: 1, output: 1_500, reasoning: 0, cached_input: 0 } })),
    ).toEqual({ task: "CR-PL", need: 1_500, censored: false });
  });

  it("is the second call alone when the first was cut off at the allowance and retried", () => {
    expect(observationOf(aRunRetried())).toEqual({ task: "CR-PL", need: 6_001, censored: false });
  });

  it("is a lower bound when the retry was cut off too", () => {
    const r = rec({
      tokens: { input: 15_000, output: 20_000, reasoning: 20_000, cached_input: 0 },
      deviations: [RETRY_NOTE],
      stop_reason: "max_tokens",
    });
    expect(observationOf(r)).toEqual({ task: "CR-PL", need: 16_000, censored: true });
  });

  it("reads the allowance an answer ran under, so a headline-allowance retry is subtracted correctly", () => {
    const r = rec({
      allowance_tokens: 20_000,
      tokens: { input: 1, output: 70_000, reasoning: 1, cached_input: 0 },
      deviations: [RETRY_NOTE],
    });
    expect(observationOf(r)?.need).toBe(50_000);
  });

  it("is nothing for an MCP session or a call that produced no output", () => {
    expect(observationOf(rec({ part: "mcp" }))).toBeUndefined();
    expect(
      observationOf(rec({ tokens: { input: 5, output: 0, reasoning: 0, cached_input: 0 } })),
    ).toBeUndefined();
  });
});

describe("the allowance rule", () => {
  const obs = (task: "CR-VS" | "CR-PL" | "CR-UO" | "CR-SM", need: number) => ({
    task,
    need,
    censored: false,
  });

  it("takes 6/5 of the most one call needed, rounded up to a multiple of 2,000", () => {
    expect(deriveAllowances([obs("CR-VS", 26_259)])["CR-VS"]).toBe(32_000);
    expect(deriveAllowances([obs("CR-PL", 16_666)])["CR-PL"]).toBe(20_000); // 19,999.2 -> 20,000
    expect(deriveAllowances([obs("CR-PL", 16_667)])["CR-PL"]).toBe(22_000); // 20,000.4 -> 22,000
  });

  it("never goes below the print's own allowance, and keeps it for a task with no observation", () => {
    const a = deriveAllowances([obs("CR-UO", 2_848)]);
    expect(a["CR-UO"]).toBe(4_000);
    expect(a["CR-VS"]).toBe(PRINT_ALLOWANCE["CR-VS"]);
    expect(deriveAllowances([])).toEqual(PRINT_ALLOWANCE);
  });

  it("is the same for every model: it looks only at the task and the need, never at who made the call", () => {
    expect(deriveAllowances([obs("CR-PL", 9_000), obs("CR-PL", 300)])).toEqual(
      deriveAllowances([obs("CR-PL", 300), obs("CR-PL", 9_000)]),
    );
  });

  it("is frozen in a committed file that agrees with the rule applied to the numbers it records", () => {
    const f = JSON.parse(readFileSync(ALLOWANCES_PATH, "utf-8")) as AllowanceFile;
    const fromRecorded = deriveAllowances(
      Object.entries(f.observed).map(([task, o]) => ({
        task: task as keyof typeof f.allowance,
        need: o.maxNeed,
        censored: o.censored > 0,
      })),
    );
    expect(f.allowance).toEqual(fromRecorded);
    expect(loadAllowances()).toEqual(f.allowance);
  });
});

describe("the headline cost (B), from an answer run under the print's allowance", () => {
  it("takes the cut-off first call off a retried answer: the prompt once and the whole allowance as output", () => {
    const h = headlineCost(aRunRetried(), PRICE);
    // billed 0.13001; the wasted first call is 7,500 in + 4,000 out = 0.055
    expect(h).toMatchObject({ passed: true, derivable: true });
    expect(h.usd.toFixed()).toBe("0.07501");
  });

  it("leaves an answer that needed no retry as billed", () => {
    const r = rec({
      usd: cost(7_500, 1_500),
      tokens: { input: 7_500, output: 1_500, reasoning: 0, cached_input: 0 },
    });
    expect(headlineCost(r, PRICE).usd.toFixed()).toBe(r.usd);
  });

  it("does not guess when the retry was itself cut off: the true need is unknown", () => {
    const r = rec({
      usd: "0.23",
      tokens: { input: 15_000, output: 20_000, reasoning: 20_000, cached_input: 0 },
      deviations: [RETRY_NOTE],
      stop_reason: "max_tokens",
      passed: false,
    });
    expect(headlineCost(r, PRICE).derivable).toBe(false);
  });

  it("is simply the billed cost for an answer that ran under the headline allowance", () => {
    expect(headlineCost(bRun(), PRICE).usd.toFixed()).toBe(bRun().usd);
  });
});

describe("the print's method (A), from an answer run under the headline allowance", () => {
  it("is the same cost when the answer fits the print's allowance", () => {
    const r = bRun({
      usd: cost(7_500, 3_000),
      tokens: { input: 7_500, output: 3_000, reasoning: 2_900, cached_input: 0 },
    });
    expect(printMethodCost(r, PRICE).usd.toFixed()).toBe(r.usd);
    expect(printMethodCost(r, PRICE).passed).toBe(true);
  });

  it("adds the wasted first call when the print's retry would have rescued it", () => {
    const a = printMethodCost(bRun(), PRICE);
    expect(a.passed).toBe(true);
    expect(a.usd.toFixed()).toBe("0.13001");
  });

  it("round trip: the derived figure equals what a real run under the print's method billed for the same answer", () => {
    expect(printMethodCost(bRun(), PRICE).usd.toFixed()).toBe(aRunRetried().usd);
    // and taking the waste off that real run gives back the headline run's own cost
    expect(headlineCost(aRunRetried(), PRICE).usd.toFixed()).toBe(bRun().usd);
  });

  it("fails the answer, with both calls billed in full, when even the retry budget is too small", () => {
    const big = bRun({
      usd: cost(7_500, 17_000),
      tokens: { input: 7_500, output: 17_000, reasoning: 16_900, cached_input: 0 },
    });
    const a = printMethodCost(big, PRICE);
    expect(a.passed).toBe(false);
    // two prompts of 7,500; 4,000 out for the first call and the 16,000 budget for the second
    expect(a.usd.toFixed()).toBe(cost(15_000, 20_000));
  });

  it("fails a model that does not think after one billed call, because the adapters do not retry it", () => {
    const plain = bRun({
      usd: cost(7_500, 5_000),
      tokens: { input: 7_500, output: 5_000, reasoning: 0, cached_input: 0 },
    });
    const a = printMethodCost(plain, PRICE);
    expect(a.passed).toBe(false);
    expect(a.usd.toFixed()).toBe(cost(7_500, 4_000));
  });

  it("is the billed cost for an answer that ran under the print's allowance", () => {
    expect(printMethodCost(aRunRetried(), PRICE).usd.toFixed()).toBe(aRunRetried().usd);
  });
});

describe("the cost-basis table", () => {
  it("shows both bases, writes 'none correct' rather than a number, and counts what it leaves out", () => {
    const records = [
      bRun({ model: "thinker" }),
      bRun({ model: "thinker", instance: "CR-PL-2", passed: false }),
      aRunRetried(),
      rec({
        model: "plain",
        passed: false,
        usd: cost(7_500, 800),
        tokens: { input: 7_500, output: 800, reasoning: 0, cached_input: 0 },
      }),
      rec({
        model: "cutoff",
        passed: false,
        usd: "0.23",
        tokens: { input: 15_000, output: 20_000, reasoning: 20_000, cached_input: 0 },
        deviations: [RETRY_NOTE],
        stop_reason: "max_tokens",
      }),
    ];
    const t = costBasisTable(records, () => PRICE);
    expect(t).toContain("Headline: cost per correct");
    expect(t).toContain("Print's method: cost per correct");
    expect(t).toMatch(/\| plain \| CR-PL \| 1 \| 0 \| none correct \| 0 \| none correct \| 0 \|/);
    // the answer whose retry was cut off is left out of the headline columns and counted in the last one
    expect(t).toMatch(/\| cutoff \| CR-PL \| 1 \| 0 \| none correct \| 0 \| none correct \| 1 \|/);
    // the thinker's headline is cheaper than its print-method cost
    const line = t.split("\n").find((l) => l.startsWith("| thinker "))!;
    const cells = line.split("|").map((c) => c.trim());
    expect(Number(cells[5])).toBeLessThan(Number(cells[7]));
  });
});
