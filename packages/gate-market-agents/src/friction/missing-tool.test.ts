import { describe, expect, it } from "vitest";
import { capabilityGapFrictions, missingToolFrictions } from "./missing-tool.js";
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

describe("capabilityGapFrictions — the half that never reached the report", () => {
  // WORKER-CODE, run 13 (2026-09-30), verbatim. It had redeemed a claim and wanted to confirm
  // the issuer served it; nothing does that, so it spent nine of window 3's ten turns on
  // get_balances and bought nothing in three windows.
  const RUN_13 = "No tool exists to check whether the issuer has actually served the redeemed claim";

  it("surfaces the run-13 entry that the grant detector could not see", () => {
    const found = capabilityGapFrictions([entry({ agent: "WORKER-CODE", turn: 3, could_not_express: RUN_13 })]);
    expect(found).toHaveLength(1);
    expect(found[0]?.agent).toBe("WORKER-CODE");
    expect(found[0]?.text).toBe(RUN_13);
  });

  it("documents WHY it was missed: it names no existing tool, so the grant detector drops it", () => {
    // This is the old behaviour, pinned. Not a bug in missingToolFrictions — the name of a tool
    // that does not exist cannot be in TOOLS — but the reason a second detector has to exist.
    expect(missingToolFrictions([entry({ could_not_express: RUN_13 })])).toEqual([]);
  });

  it("returns waiting and workflow gaps too, rather than judging which gaps are real", () => {
    const found = capabilityGapFrictions([
      entry({ could_not_express: "no idle/wait tool; polling get_print to stay in-window" }),
      entry({ could_not_express: "cannot submit_job and quote_forward in the same turn" }),
      entry({ could_not_express: null }),
    ]);
    expect(found).toHaveLength(2);
  });

  it("does not double-report a grant problem, which the louder detector already has", () => {
    const grant = entry({ turn: 4, could_not_express: "redeem_claim is not in the list of available tools this turn" });
    expect(missingToolFrictions([grant])).toHaveLength(1);
    expect(capabilityGapFrictions([grant])).toEqual([]);
  });
});
