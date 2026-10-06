import { describe, expect, it } from "vitest";
import { refusalsOf, toolErrorsOf } from "./tool-errors.js";

const log = (turn: number, over: Record<string, unknown> = {}) =>
  ({ turn, promptChars: 0, projectedUsd: "0", realizedUsd: "0", latencyMs: 0, parsed: "ok", ...over }) as never;

describe("toolErrorsOf", () => {
  it("lists every tool call that errored, with the sentence the agent was shown", () => {
    const errors = toolErrorsOf({
      ISSUER_B: [
        log(1, { toolCall: { name: "submit_job", ok: true } }),
        log(2, {
          toolCall: { name: "serve_redemption", ok: false },
          parsed: '{"tool":"serve_redemption","args":{}} -> tool call error: you asked to serve more than the holder holds.',
        }),
      ],
    });
    expect(errors).toEqual([
      {
        agentId: "ISSUER_B",
        turn: 2,
        tool: "serve_redemption",
        error: "you asked to serve more than the holder holds.",
      },
    ]);
  });

  it("is empty for a window in which every call worked, and ignores turns that called nothing", () => {
    expect(toolErrorsOf({ A: [log(1, { toolCall: { name: "pay", ok: true } }), log(2)] })).toEqual([]);
  });

  it("keeps the whole line when it carries no recognisable error marker", () => {
    expect(toolErrorsOf({ A: [log(1, { toolCall: { name: "pay", ok: false }, parsed: "something else" })] })[0].error).toBe(
      "something else",
    );
  });
});

describe("refusalsOf — calls refused before they ran", () => {
  it("separates a malformed call from a well-formed one the lab declined", () => {
    const refusals = refusalsOf({
      A: [
        log(1, { parsed: '{"tool":"pay_with_usdc","args":{}} -> args error: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units.' }),
        log(2, { parsed: '{"tool":"pay_with_usdc","args":{"requestId":"qr-3"}} -> args error: qr-3 is not yours to pay: it was asked for by TRADER-1.' }),
        log(3, { parsed: '{"tool":"pay_with_new_claim","args":{"forWindow":"x"}} -> args error: pay_with_new_claim: "forWindow" must be a number.' }),
        log(4, { parsed: "Unparseable model response: no JSON object found" }),
        log(5, { parsed: '{"tool":"wait","args":{}} -> tool call error: A is not permitted to call "wait".' }),
        log(6, { parsed: '{"tool":"pay_with_usdc","args":{}}', toolCall: { name: "pay", ok: true } }),
      ],
    });
    expect(refusals.map((r) => [r.turn, r.kind])).toEqual([[1, "refused"], [2, "refused"], [3, "format"], [4, "format"], [5, "format"]]);
    expect(refusals[0].sentence).toBe("This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units.");
  });

  it("is empty when every call was well formed and allowed", () => {
    expect(refusalsOf({ A: [log(1, { toolCall: { name: "pay", ok: true } }), log(2)] })).toEqual([]);
  });

  it("does not count a call that ran and errored: that is a tool error", () => {
    expect(refusalsOf({ A: [log(1, { toolCall: { name: "pay", ok: false }, parsed: '{} -> tool call error: the paying wallet does not hold enough USDC.' })] })).toEqual([]);
  });
});
