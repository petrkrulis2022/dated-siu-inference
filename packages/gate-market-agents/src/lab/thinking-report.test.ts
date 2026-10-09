import { describe, expect, it } from "vitest";
import { samplingOf, thinkingCaptureOf } from "./thinking-report.js";

const SEATS = { "TRADER-1": "ORCHESTRATOR", "TRADER-2": "WORKER-CODE" };
const MODELS = { "TRADER-1": "claude-haiku-4-5", "TRADER-2": "claude-sonnet-5" };

describe("what sampling each trader's requests were actually sent with (D59)", () => {
  it("lists the temperatures seen per trader, 'provider-default' where none was sent", () => {
    const out = samplingOf(
      {
        ORCHESTRATOR: [{ rawText: "x", sent: { temperature: 0.7 } }, { rawText: "y", sent: { temperature: 0.7 } }],
        "WORKER-CODE": [{ rawText: "x", sent: { temperature: "provider-default" } }, { rawText: "y", sent: { temperature: "provider-default" } }],
      },
      SEATS,
      MODELS,
    );
    expect(out["TRADER-1"]).toEqual({ model: "claude-haiku-4-5", turns: 2, temperatures: ["0.7"], turnsNotReported: 0 });
    expect(out["TRADER-2"]).toEqual({ model: "claude-sonnet-5", turns: 2, temperatures: ["provider-default"], turnsNotReported: 0 });
  });

  it("counts a turn whose adapter reported nothing, rather than assuming what it sent", () => {
    const out = samplingOf({ ORCHESTRATOR: [{ rawText: "x" }, { rawText: "y", sent: { temperature: 0.7 } }] }, SEATS, MODELS);
    expect(out["TRADER-1"]).toMatchObject({ turns: 2, temperatures: ["0.7"], turnsNotReported: 1 });
  });

  it("leaves out a turn that never got a reply (a provider failure) and names no sampling for a trader with none", () => {
    const out = samplingOf({ ORCHESTRATOR: [{}] }, SEATS, MODELS);
    expect(out["TRADER-1"]).toEqual({ model: "claude-haiku-4-5", turns: 0, temperatures: [], turnsNotReported: 0 });
    expect(out["TRADER-2"].turns).toBe(0);
  });

  it("is a separate record from what reasoning was captured", () => {
    const cap = thinkingCaptureOf({ ORCHESTRATOR: [{ rawText: "x", usage: { input: 1, output: 1, cached_input: 0, reasoning: 0 } }] }, SEATS, MODELS);
    expect(cap["TRADER-1"].turns).toBe(1);
  });
});
