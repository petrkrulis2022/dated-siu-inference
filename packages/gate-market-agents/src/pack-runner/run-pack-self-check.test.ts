import { describe, expect, it } from "vitest";
import { CODE_GATE_HARDENING_PACK, EXTRACT_GATE_HARDENING_PACK } from "@touchstone/task-pack-gate-hardening";
import { TRIVIAL_ACCEPT_PACK } from "@touchstone/task-pack-trivial-accept";
import { runPackSelfCheck } from "./run-pack-self-check.js";

/**
 * WP-9 item 2's literal test: a second, trivial pack must load and run end to end with zero
 * changes outside its own directory. This suite feeds the real gate-hardening packs (built in
 * WP-1, relocated here in WP-9 Slice 1) and the trivial pack (new in Slice 1, its own package
 * only — nothing here or in @touchstone/task-pack-sdk changed to accommodate it) through the
 * exact same `runPackSelfCheck` — proof the bench doesn't need to know what the task is.
 */
describe.each([
  ["code gate-hardening", CODE_GATE_HARDENING_PACK],
  ["extract gate-hardening", EXTRACT_GATE_HARDENING_PACK],
  ["trivial-accept", TRIVIAL_ACCEPT_PACK],
] as const)("runPackSelfCheck against %s", (_label, pack) => {
  it("passes: known-good accepted, every adversarial fixture rejected", async () => {
    const result = await runPackSelfCheck(pack);
    expect(result.packName).toBe(pack.name);
    expect(result.knownGoodAccepted).toBe(true);
    expect(result.adversarialRejectedCount).toBe(result.adversarialTotalCount);
    expect(result.passed).toBe(true);
  }, 30_000);
});
