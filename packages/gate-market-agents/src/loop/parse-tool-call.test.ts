import { describe, expect, it } from "vitest";
import { ModelResponseParseError, parseModelResponse } from "./parse-tool-call.js";

describe("parseModelResponse", () => {
  it("parses a clean tool-call JSON response", () => {
    const result = parseModelResponse('{"tool": "get_print", "args": {"printId": "2026-09-22"}}');
    expect(result).toEqual({ tool: "get_print", args: { printId: "2026-09-22" } });
  });

  it("parses a tool call embedded in surrounding prose — real models don't always return JSON only", () => {
    const result = parseModelResponse(
      'I will check the current print first.\n\n{"tool": "get_print", "args": {"printId": "2026-09-22"}}\n\nLet me see what comes back.',
    );
    expect(result).toEqual({ tool: "get_print", args: { printId: "2026-09-22" } });
  });

  it("parses a done response", () => {
    const result = parseModelResponse('{"done": true, "summary": "job delivered and served"}');
    expect(result).toEqual({ done: true, summary: "job delivered and served" });
  });

  it("throws ModelResponseParseError on garbage input rather than guessing", () => {
    expect(() => parseModelResponse("I'm not sure what to do next.")).toThrow(
      ModelResponseParseError,
    );
  });

  it("throws on a JSON object missing both 'tool' and 'done'", () => {
    expect(() => parseModelResponse('{"foo": "bar"}')).toThrow(ModelResponseParseError);
  });

  it("throws on malformed JSON braces", () => {
    expect(() => parseModelResponse('{"tool": "get_print", "args": {}')).toThrow(
      ModelResponseParseError,
    );
  });

  it("throws on done:true with a missing summary", () => {
    expect(() => parseModelResponse('{"done": true}')).toThrow(ModelResponseParseError);
  });

  it("parses an optional friction report alongside a tool call", () => {
    const result = parseModelResponse(
      '{"tool": "get_print", "args": {"printId": "2026-09-22"}, "friction": ' +
        '{"could_not_express": "wanted to see the other issuer\'s rate", "forced_conversion": false, ' +
        '"conversion_reason": null, "missing_information": null, "decision_confidence": "medium"}}',
    );
    expect(result).toEqual({
      tool: "get_print",
      args: { printId: "2026-09-22" },
      friction: {
        could_not_express: "wanted to see the other issuer's rate",
        forced_conversion: false,
        conversion_reason: null,
        missing_information: null,
        decision_confidence: "medium",
      },
    });
  });

  it("parses an optional friction report alongside a done response", () => {
    const result = parseModelResponse(
      '{"done": true, "summary": "finished", "friction": {"forced_conversion": true, "conversion_reason": "only USDC was quoted"}}',
    );
    expect(result).toEqual({
      done: true,
      summary: "finished",
      friction: { forced_conversion: true, conversion_reason: "only USDC was quoted" },
    });
  });

  it("omits friction entirely when the model doesn't include it — never invented", () => {
    const result = parseModelResponse('{"tool": "get_print", "args": {}}');
    expect(result).not.toHaveProperty("friction");
  });

  it("recovers the real tool call when the model appends a stray, unmerged friction object after it", () => {
    // Found live (WORKER-CODE/claude-sonnet-5, P5 window 1, 2026-09-26): the model closed its
    // own real tool-call object cleanly, then appended ", \"friction\": {...}" outside it rather
    // than merging "friction" in as a sibling key — the naive first-brace/last-brace span then
    // isn't valid JSON at all. The real tool call is still recoverable from its own matching span.
    const result = parseModelResponse(
      '{"tool": "get_balances", "args": {"account": "0xabc", "tokenIds": []}}, ' +
        '"friction": {"could_not_express": null, "forced_conversion": false, ' +
        '"conversion_reason": null, "missing_information": "no request yet", "decision_confidence": "high"}',
    );
    expect(result).toEqual({
      tool: "get_balances",
      args: { account: "0xabc", tokenIds: [] },
    });
  });

  it("does not miscount braces inside a submit_job source string when recovering from a stray trailing fragment", () => {
    const result = parseModelResponse(
      '{"tool": "submit_job", "args": {"source": "export async function gate({ a }) { return { accept: true }; }"}}, ' +
        '"friction": {"decision_confidence": "high"}',
    );
    expect(result).toEqual({
      tool: "submit_job",
      args: { source: "export async function gate({ a }) { return { accept: true }; }" },
    });
  });
});
