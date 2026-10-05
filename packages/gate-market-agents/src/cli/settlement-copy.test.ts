import { describe, expect, it } from "vitest";
import { settlementCopyShown } from "./settlement-copy.js";

const settle = (agentId: string, turn: number, outcome?: "Defaulted" | "Expired", tokenId = "7") =>
  ({ agentId, turn, kind: "settle_window_close", tokenId, ...(outcome ? { settlementOutcome: outcome } : {}) }) as never;
const log = (turn: number, promptText?: string) => ({ turn, ...(promptText !== undefined ? { promptText } : {}) }) as never;

describe("settlementCopyShown — was the settler told what its settlement did?", () => {
  it("is true when the settler's next prompt names the outcome", () => {
    const rows = settlementCopyShown(
      [settle("WORKER-CODE", 6, "Defaulted")],
      { "WORKER-CODE": [log(6, "before"), log(7, 'Turn 6 — called settle_window_close({...}) -> {"outcome":"Defaulted","bondPaidMinorUnits":"14400"}')] },
    );
    expect(rows).toEqual([{ agentId: "WORKER-CODE", turn: 6, tokenId: "7", outcome: "Defaulted", shownToSettler: true }]);
  });

  it("is false when the next prompt exists and does not name it", () => {
    const [row] = settlementCopyShown([settle("WORKER-CODE", 6, "Expired")], { "WORKER-CODE": [log(7, "nothing about it")] });
    expect(row.shownToSettler).toBe(false);
  });

  it("is null when the settler had no later turn in which to be told — not shown, and not refused either", () => {
    const [row] = settlementCopyShown([settle("WORKER-CODE", 6, "Expired")], { "WORKER-CODE": [log(6)] });
    expect(row.shownToSettler).toBeNull();
  });

  it("reads only the SETTLER's own prompts, not another agent's", () => {
    const [row] = settlementCopyShown(
      [settle("WORKER-EXTRACT", 1, "Expired")],
      { "WORKER-CODE": [log(2, '"outcome":"Expired"')], "WORKER-EXTRACT": [log(2, "no outcome here")] },
    );
    expect(row.shownToSettler).toBe(false);
  });

  it("uses the very next turn, not any later one", () => {
    const [row] = settlementCopyShown(
      [settle("A", 2, "Defaulted")],
      { A: [log(3, "silent"), log(4, '"outcome":"Defaulted"')] },
    );
    expect(row.shownToSettler).toBe(false);
  });

  it("reports an outcome that was never decoded as unknown rather than as shown", () => {
    const [row] = settlementCopyShown([settle("A", 2)], { A: [log(3, "anything")] });
    expect(row.outcome).toBeUndefined();
    expect(row.shownToSettler).toBeNull();
  });

  it("ignores events that are not settlements", () => {
    expect(settlementCopyShown([{ agentId: "A", turn: 1, kind: "redeem_claim" } as never], { A: [log(2, "x")] })).toEqual([]);
  });
});
