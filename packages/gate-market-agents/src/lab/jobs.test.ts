import { describe, expect, it } from "vitest";
import type { Adapter } from "@touchstone/harness";
import { buildEconomy } from "./economy.js";
import { jobFor, modelExecutor, referenceExecutor } from "./jobs.js";

const e = buildEconomy(11);
const PRICES = { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" };
const fake = (text: string, input = 1000, output = 100): Adapter =>
  async () => ({ text, usage: { input, output, cached_input: 0, reasoning: 0 }, latency_ms: 1, raw: {}, deviations: [] });

describe("jobFor", () => {
  it("is the same job for the same seed and need, and a different one for another need", () => {
    const [a, b] = e.needs;
    expect(jobFor(11, a).instance.prompt).toBe(jobFor(11, a).instance.prompt);
    expect(jobFor(11, a).instance.prompt).not.toBe(jobFor(11, b).instance.prompt);
    expect(jobFor(12, a).instance.prompt).not.toBe(jobFor(11, a).instance.prompt);
  });

  it("never puts the expected answer in what the model is shown", () => {
    const job = jobFor(11, e.needs[0]);
    const trackingId = job.instance.expected.tracking_id;
    // The record is in the document, as it must be to be extracted; the instance carries the answer
    // separately, for grading only, and the prompt is the only thing the executor sends.
    expect(job.instance.prompt).toContain(trackingId);
    expect(job.instance.prompt).not.toContain("expected");
  });
});

describe("modelExecutor — one call, graded deterministically", () => {
  const job = jobFor(11, e.needs[0]);

  it("passes a correct extraction and prices the call from the usage the provider reported", async () => {
    const r = await modelExecutor({ adapter: fake(JSON.stringify(job.instance.expected)), modelString: "m", prices: PRICES })(job);
    expect(r.passed).toBe(true);
    expect(r.reason).toBeUndefined();
    // 1000 in at $1/M and 100 out at $5/M = $0.001 + $0.0005
    expect(r.costUsd).toBe("0.0015");
    expect(r.usage).toEqual({ input: 1000, output: 100 });
  });

  it("accepts the answer inside a json code fence, as the grader does", async () => {
    const fenced = "```json\n" + JSON.stringify(job.instance.expected) + "\n```";
    expect((await modelExecutor({ adapter: fake(fenced), modelString: "m", prices: PRICES })(job)).passed).toBe(true);
  });

  it("fails a wrong extraction, with the grader's reason, and still costs what the call cost", async () => {
    const wrong = { ...job.instance.expected, weight_kg: job.instance.expected.weight_kg + 1 };
    const r = await modelExecutor({ adapter: fake(JSON.stringify(wrong)), modelString: "m", prices: PRICES })(job);
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.costUsd).toBe("0.0015");
  });

  it("fails an empty reply as such, and never reads it as a pass", async () => {
    const r = await modelExecutor({ adapter: fake("   "), modelString: "m", prices: PRICES })(job);
    expect(r).toMatchObject({ passed: false, reason: "the model returned no text" });
  });

  it("asks at temperature zero with the instance's own token limit", async () => {
    let seen: { temperature: number; max_tokens: number } | undefined;
    const spy: Adapter = async (_m, _p, params) => {
      seen = params;
      return { text: "{}", usage: { input: 1, output: 1, cached_input: 0, reasoning: 0 }, latency_ms: 1, raw: {}, deviations: [] };
    };
    await modelExecutor({ adapter: spy, modelString: "m", prices: PRICES })(job);
    expect(seen).toEqual({ temperature: 0, max_tokens: job.instance.params.max_tokens });
  });
});

describe("referenceExecutor", () => {
  it("passes every job at no cost, for scripted runs", async () => {
    for (const need of e.needs) {
      const r = await referenceExecutor(jobFor(11, need));
      expect(r).toEqual({ passed: true, usage: { input: 0, output: 0 }, costUsd: "0" });
    }
  });
});
