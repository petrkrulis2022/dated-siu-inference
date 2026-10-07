import { describe, expect, it } from "vitest";
import type { TurnLog } from "../loop/full-run.js";
import { waitedWithWork, waitsOf } from "./waits.js";

const turn = (n: number, parsed: string, promptText: string): TurnLog =>
  ({ turn: n, promptChars: promptText.length, projectedUsd: "0", realizedUsd: "0", latencyMs: 0, parsed, promptText }) as TurnLog;

const OPEN = "THE LAB — ROUND 1 OF 3\n  …\n\nOPEN FOR YOU NOW\n  Needs you can buy now:\n    TRADER-2#1: TYPE-3 from TRADER-4 (round 1)\n";
const REQUESTS = "MARKET BOARD\nOpen quote requests addressed to you (call issue_quote with { requestId } to answer one):\n  qr-1: from TRADER-1, 1 SIU\n";
const QUOTES = "MARKET BOARD\nQuotes you have received (settle one by naming its requestId, in whichever asset you choose):\n  qr-2: quote from seller erc8004:0xab, amount_usd_max 0.0017\n";
const NOTHING = "THE LAB — ROUND 1 OF 3\n  You are TRADER-2. …\n";

describe("waits taken while there was something to do (D34)", () => {
  it("records a wait as one with something on its screen when its prompt carried an actionable section", () => {
    const logs = {
      "WORKER-CODE": [
        turn(1, '{"wait":true}', OPEN),
        turn(2, '{"wait":true}', REQUESTS),
        turn(3, '{"wait":true}', QUOTES),
        turn(4, '{"wait":true}', OPEN + REQUESTS + QUOTES),
      ],
    };
    const waits = waitsOf(logs);
    expect(waits.map((w) => w.hadWork.length)).toEqual([1, 1, 1, 3]);
    expect(waits[0].hadWork).toEqual(["a need to buy, a job owed, or raw work to buy"]);
    expect(waits[1].hadWork).toEqual(["a request addressed to it"]);
    expect(waits[2].hadWork).toEqual(["a quote it was sent and has not paid"]);
  });

  it("records a wait with nothing on its screen as a wait with no work, and counts only the first kind", () => {
    const logs = {
      "WORKER-CODE": [turn(1, '{"wait":true}', NOTHING), turn(2, '{"wait":true}', OPEN)],
      "ISSUER-A": [turn(1, '{"wait":true}', QUOTES)],
    };
    const waits = waitsOf(logs);
    expect(waits.find((w) => w.agentId === "WORKER-CODE" && w.turn === 1)?.hadWork).toEqual([]);
    expect(waitedWithWork(waits)).toEqual({ "WORKER-CODE": 1, "ISSUER-A": 1 });
  });

  it("ignores every turn that was not a wait: a tool call, a refusal, a stop", () => {
    const logs = {
      "WORKER-CODE": [
        turn(1, '{"tool":"pay_with_usdc","args":{"requestId":"qr-2"}}', QUOTES),
        turn(2, '{"tool":"pay_with_usdc","args":{}} -> args error: x', QUOTES),
        turn(3, '{"done":true,"summary":"x"}', OPEN),
      ],
    };
    expect(waitsOf(logs)).toEqual([]);
  });

  it("reads the headings only at the start of a line, so a history line quoting the words does not count", () => {
    const quoting = `${NOTHING}\nTurn 1 — called get_balances({}) -> {"note":"see OPEN FOR YOU NOW and Quotes you have received"}\n`;
    expect(waitsOf({ "WORKER-CODE": [turn(1, '{"wait":true}', quoting)] })[0].hadWork).toEqual([]);
  });

  it("treats a turn with no recorded prompt as having shown nothing rather than guessing", () => {
    const bare = { turn: 1, promptChars: 0, projectedUsd: "0", realizedUsd: "0", latencyMs: 0, parsed: '{"wait":true}' } as TurnLog;
    expect(waitsOf({ "WORKER-CODE": [bare] })[0].hadWork).toEqual([]);
  });
});
