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
});
