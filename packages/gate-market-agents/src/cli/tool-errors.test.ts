import { describe, expect, it } from "vitest";
import { toolErrorsOf } from "./tool-errors.js";

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
