import { describe, expect, it } from "vitest";
import { parseModelResponse } from "../loop/parse-tool-call.js";
import { EMPHASIS_GAP, decisionsOf, isPayment, rationaleCoverage, type DecisionRecord } from "./decisions.js";

const prompt = (round: number): string => `...\nTHE LAB — ROUND ${round} OF 3\n  You are TRADER-1.\n...`;
const turn = (n: number, rawText: string, round = 1) => ({ turn: n, rawText, promptText: prompt(round) });

describe("decisions, read from the model's raw reply by the loop's own parser", () => {
  it("records the tool as the agent named it, the request it names, its round, and its one-line reason", () => {
    const [d] = decisionsOf({
      ORCHESTRATOR: [turn(2, '{"tool":"pay_with_usdc","args":{"requestId":"qr-1"},"rationale":"to meet my first need"}', 2)],
    });
    expect(d).toEqual({ agentId: "ORCHESTRATOR", turn: 2, round: 2, tool: "pay_with_usdc", requestId: "qr-1", rationale: "to meet my first need" });
  });

  it("reads a reply in a code fence and one with trailing text the way the loop does, so what counts as a decision here counted in the run", () => {
    const fenced = decisionsOf({ A: [turn(1, '```json\n{"tool":"request_quote","args":{"sellerId":"s"},"rationale":"r"}\n```')] });
    expect(fenced[0]).toMatchObject({ tool: "request_quote", rationale: "r" });
  });

  it("treats a blank rationale and no rationale as the same thing, as the loop's record does", () => {
    const rows = decisionsOf({
      A: [turn(1, '{"tool":"issue_quote","args":{"requestId":"qr-1"}}'), turn(2, '{"tool":"issue_quote","args":{"requestId":"qr-2"},"rationale":"   "}'), turn(3, '{"tool":"issue_quote","args":{"requestId":"qr-3"},"rationale":7}')],
    });
    for (const d of rows) expect("rationale" in d).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("records waits and stops as decisions too, since a reason on a wait is as much a reading as one on a payment", () => {
    const rows = decisionsOf({ A: [turn(1, '{"wait":true,"rationale":"nothing to do yet"}'), turn(2, '{"done":true,"summary":"s","rationale":"finished"}')] });
    expect(rows.map((d) => [d.tool, d.rationale])).toEqual([["wait", "nothing to do yet"], ["done", "finished"]]);
  });

  it("keeps the friction fields that carry words, and only those", () => {
    const [d] = decisionsOf({
      A: [turn(1, '{"tool":"pay_with_usdc","args":{"requestId":"qr-1"},"friction":{"could_not_express":"no way to see my fSIU cost","forced_conversion":false,"conversion_reason":null,"missing_information":"  ","decision_confidence":"high"}}')],
    });
    expect(d.friction).toEqual({ could_not_express: "no way to see my fSIU cost" });
  });

  it("leaves out a reply the loop could not read: it is not a decision", () => {
    const rows = decisionsOf({ A: [turn(1, '{"issue_quote":{"requestId":"qr-2"}}'), turn(2, "I think I will wait."), { turn: 3 }] });
    expect(rows).toEqual([]);
  });

  it("does not change what a call parses to: a call with a rationale parses to the same call plus the rationale, and one without is exactly as before", () => {
    const bare = parseModelResponse('{"tool":"pay_with_usdc","args":{"requestId":"qr-1"}}');
    const said = parseModelResponse('{"tool":"pay_with_usdc","args":{"requestId":"qr-1"},"rationale":"because"}');
    expect(said).toEqual({ ...bare, rationale: "because" });
    expect("rationale" in bare).toBe(false);
    expect(decisionsOf({ A: [turn(1, '{"tool":"pay_with_usdc","args":{"requestId":"qr-1"}}')] })[0]).toMatchObject({ tool: "pay_with_usdc", requestId: "qr-1" });
  });

  it("reads the round from the prompt's own header, and leaves it out when there is none", () => {
    expect(decisionsOf({ A: [turn(1, '{"wait":true}', 3)] })[0].round).toBe(3);
    expect("round" in decisionsOf({ A: [{ turn: 1, rawText: '{"wait":true}', promptText: "no header" }] })[0]).toBe(false);
  });

  it("calls every route of paying a payment, by the lab's names and the loop's", () => {
    for (const t of ["pay", "pay_with_usdc", "pay_with_held_claim", "pay_split", "pay_with_new_claim", "transfer_claim", "settle_split", "settle_split_held"]) expect(isPayment(t), t).toBe(true);
    for (const t of ["request_quote", "issue_quote", "deliver_job", "get_balances", "wait", "done"]) expect(isPayment(t), t).toBe(false);
  });
});

describe("the emphasis check", () => {
  const dec = (tool: string, rationale: boolean): DecisionRecord => ({ agentId: "A", turn: 1, tool, ...(rationale ? { rationale: "r" } : {}) });
  const many = (tool: string, n: number, withRationale: number): DecisionRecord[] => Array.from({ length: n }, (_, i) => dec(tool, i < withRationale));

  it("counts how often a payment carries a rationale against every other call", () => {
    const c = rationaleCoverage([...many("pay_with_usdc", 6, 6), ...many("request_quote", 4, 3), ...many("wait", 2, 1)]);
    expect(c.payments).toEqual({ calls: 6, withRationale: 6 });
    expect(c.others).toEqual({ calls: 6, withRationale: 4 });
    expect(c.byTool.wait).toEqual({ calls: 2, withRationale: 1 });
  });

  it("raises the flag when payments carry one much more often than other calls — the emphasis effect", () => {
    const c = rationaleCoverage([...many("pay_with_usdc", 8, 8), ...many("request_quote", 8, 2)]);
    expect(c.emphasis).toBe(true);
  });

  it("does not when every call carries one, as in the runs so far, or when the gap is small", () => {
    expect(rationaleCoverage([...many("pay_with_usdc", 8, 8), ...many("request_quote", 8, 8)]).emphasis).toBe(false);
    expect(rationaleCoverage([...many("pay_with_usdc", 10, 10), ...many("request_quote", 10, 9)]).emphasis).toBe(false);
    expect(EMPHASIS_GAP).toBe(0.2);
  });

  it("does not flag on too few calls to say", () => {
    expect(rationaleCoverage([...many("pay_with_usdc", 3, 3), ...many("request_quote", 3, 0)]).emphasis).toBe(false);
  });
});
