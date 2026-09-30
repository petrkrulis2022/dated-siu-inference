import { describe, expect, it } from "vitest";
import { missingToolFrictions } from "./missing-tool.js";
import type { FrictionLogEntry } from "./log.js";

const entry = (over: Partial<FrictionLogEntry>): FrictionLogEntry => ({
  agent: "WORKER-EXTRACT",
  turn: 7,
  job_id: "j",
  attempted: "get_balances",
  outcome: "ok",
  could_not_express: null,
  forced_conversion: false,
  conversion_reason: null,
  missing_information: null,
  decision_confidence: "medium",
  time_to_expiry_seconds: null,
  ...over,
}) as FrictionLogEntry;

describe("missingToolFrictions", () => {
  it("catches the real run-10 entry that went unread for two runs", () => {
    const found = missingToolFrictions([
      entry({ could_not_express: "redeem_claim is not in the list of available tools this turn" }),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.tool).toBe("redeem_claim");
    expect(found[0]?.agent).toBe("WORKER-EXTRACT");
  });

  it("catches the run-9 phrasing too, which differs word for word", () => {
    const found = missingToolFrictions([
      entry({
        agent: "ISSUER-A",
        could_not_express:
          "serve_redemption is required for the pending redemption but was not listed among available tools this turn",
      }),
    ]);
    expect(found.map((f) => f.tool)).toEqual(["serve_redemption"]);
  });

  it("does NOT flag friction about workflow or waiting — a different severity", () => {
    // Real entries from runs 8 and 10. These are design gaps worth reading; they do not mean an
    // agent was handed an asset it could not use.
    expect(
      missingToolFrictions([
        entry({ could_not_express: "no idle/wait tool; polling get_print to stay in-window" }),
        entry({ could_not_express: "wanted to also mint_claim this turn but only one tool call is allowed" }),
        entry({ could_not_express: null }),
      ]),
    ).toEqual([]);
  });
});
