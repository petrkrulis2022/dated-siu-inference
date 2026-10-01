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

describe("the optional per-decision rationale (spec §7.4)", () => {
  // The field is available on EVERY call, not only payments. A payment-only rationale field
  // would mark payment turns as the ones worth thinking about and change the decision being
  // measured — §4.6q's shape on a new surface.

  it("does not change parsing for a call that omits it — today's behaviour, byte for byte", () => {
    const before = parseModelResponse('{"tool": "pay", "args": {"requestId": "qr-1"}}');
    expect(before).toEqual({ tool: "pay", args: { requestId: "qr-1" } });
    expect("rationale" in before).toBe(false);
  });

  it("omits the key entirely when absent, as friction does — absence is data, not an empty string", () => {
    // A buyer that settled without recording one was not deliberating. `rationale: ""` and "no
    // rationale" must stay distinguishable in the record.
    const call = parseModelResponse('{"tool": "redeem_claim", "args": {"tokenId": "1"}}');
    expect(Object.keys(call)).toEqual(["tool", "args"]);
  });

  it("carries it through on any tool, not a privileged subset", () => {
    for (const tool of ["pay", "whoami", "submit_job", "quote_forward", "check_delivery"]) {
      const call = parseModelResponse(`{"tool": "${tool}", "args": {}, "rationale": "because X"}`);
      expect(call).toMatchObject({ tool, rationale: "because X" });
    }
  });

  it("carries it on a done intent too — leaving is a decision as much as acting is", () => {
    expect(parseModelResponse('{"done": true, "summary": "s", "rationale": "nothing left to buy"}')).toEqual(
      { done: true, summary: "s", rationale: "nothing left to buy" },
    );
  });

  it("accepts it alongside friction without either displacing the other", () => {
    const call = parseModelResponse(
      '{"tool": "pay", "args": {}, "friction": {"decision_confidence": "low"}, "rationale": "r"}',
    );
    expect(call).toMatchObject({ tool: "pay", rationale: "r", friction: { decision_confidence: "low" } });
  });

  it("ignores a non-string rationale rather than failing the turn", () => {
    // Never validated, never required. A model that puts an object there loses the rationale,
    // not the turn — the same forgiveness friction gets, for the same reason.
    const call = parseModelResponse('{"tool": "pay", "args": {}, "rationale": {"not": "a string"}}');
    expect(call).toMatchObject({ tool: "pay" });
    expect("rationale" in call).toBe(false);
  });

  it("ignores an empty-string rationale — it is indistinguishable from not having one", () => {
    const call = parseModelResponse('{"tool": "pay", "args": {}, "rationale": "   "}');
    expect("rationale" in call).toBe(false);
  });
});
