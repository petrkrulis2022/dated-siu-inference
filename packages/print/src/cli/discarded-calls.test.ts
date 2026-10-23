import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { loadDiscardedFirstCalls, successfulCallVariants, usageOfRawResponse } from "./discarded-calls.js";

let dir: string;
let later: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "discarded-"));
  later = mkdtempSync(join(tmpdir(), "discarded-later-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(later, { recursive: true, force: true });
});

const GOOGLE_FIRST = { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2, thoughtsTokenCount: 95, cachedContentTokenCount: 4 } };
const GOOGLE_FINAL = { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, thoughtsTokenCount: 90 } };
const SUM = { input: 100, output: 10, cached_input: 4, reasoning: 185 };
const FIRST = { input: 50, output: 2, cached_input: 4, reasoning: 95 };
const FINAL_ONLY = { input: 50, output: 8, cached_input: 0, reasoning: 90 };

const rec = (id: string, usage: RunRecord["usage"], over: Partial<RunRecord> = {}): RunRecord => ({
  run_id: id,
  model_id: "gemini-3.1-pro-preview",
  task_class: "T1",
  instance_id: "T1-01",
  seed: 1,
  attempt: 1,
  usage,
  latency_ms: 1,
  gate_passed: true,
  raw_response_ref: `${id}.raw.json`,
  deviations: ["completion truncated by mandatory reasoning (finishReason MAX_TOKENS)"],
  ...over,
});
const raw = (where: string, id: string, body: unknown) => writeFileSync(join(where, `${id}.raw.json`), JSON.stringify(body));

describe("the usage a raw response reports, in the record's terms", () => {
  it("reads the three shapes the adapters keep", () => {
    expect(usageOfRawResponse(GOOGLE_FIRST)).toEqual(FIRST);
    expect(
      usageOfRawResponse({ usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2, output_tokens_details: { thinking_tokens: 3 } } }),
    ).toEqual({ input: 5, output: 7, cached_input: 2, reasoning: 3 });
    expect(
      usageOfRawResponse({ usage: { prompt_tokens: 9, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 2 } } }),
    ).toEqual({ input: 9, output: 4, cached_input: 1, reasoning: 2 });
    expect(usageOfRawResponse({ choices: [] })).toBeUndefined();
    expect(usageOfRawResponse(null)).toBeUndefined();
  });
});

describe("finding each retried run's discarded first call", () => {
  it("finds it when the record's usage is exactly the sum of the two calls the raw file holds", async () => {
    raw(dir, "a", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    const found = await loadDiscardedFirstCalls([rec("a", SUM)], [dir]);
    expect(found.get("a")).toEqual(FIRST);
  });

  it("leaves a record from before the fix alone: its usage is the final call only, so there is nothing to take off", async () => {
    raw(dir, "old", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    expect((await loadDiscardedFirstCalls([rec("old", FINAL_ONLY)], [dir])).size).toBe(0);
    // and a raw file that holds only the final response (what the adapter kept before the fix)
    raw(dir, "older", GOOGLE_FINAL);
    expect((await loadDiscardedFirstCalls([rec("older", FINAL_ONLY)], [dir])).size).toBe(0);
  });

  it("leaves out a record with no retry, a missing raw file, an unreadable one, or usage that is neither sum nor final", async () => {
    raw(dir, "noretry", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    writeFileSync(join(dir, "bad.raw.json"), "{not json");
    raw(dir, "odd", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    const found = await loadDiscardedFirstCalls(
      [
        rec("noretry", SUM, { deviations: [] }),
        rec("missing", SUM),
        rec("bad", SUM),
        rec("odd", { ...SUM, output: 11 }),
      ],
      [dir],
    );
    expect(found.size).toBe(0);
  });

  it("looks in later directories too, for a carried-forward row's raw file", async () => {
    raw(later, "c", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    expect((await loadDiscardedFirstCalls([rec("c", SUM)], [dir, later])).get("c")).toEqual(FIRST);
  });
});

describe("the variant a print publishes", () => {
  it("applies to the models that have a discarded call, and to no other", async () => {
    raw(dir, "a", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    const records = [rec("a", SUM), rec("b", SUM, { model_id: "other", deviations: [] })];
    const [v] = await successfulCallVariants(records, [dir], ["gemini-3.1-pro-preview", "other"]);
    expect(v?.appliesTo).toEqual(["gemini-3.1-pro-preview"]);
  });

  it("is no variant at all when nothing was discarded, since nothing would differ", async () => {
    expect(await successfulCallVariants([rec("a", FINAL_ONLY, { deviations: [] })], [dir], ["gemini-3.1-pro-preview"])).toEqual([]);
  });

  it("looks only at the models the print includes (a tier series does not see the other tier's runs)", async () => {
    raw(dir, "a", { truncated: GOOGLE_FIRST, final: GOOGLE_FINAL });
    expect(await successfulCallVariants([rec("a", SUM)], [dir], ["some-open-model"])).toEqual([]);
  });
});
