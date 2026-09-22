import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runHappyPath } from "./happy-path.js";
import { runFailingSubmission } from "./failing-submission.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

// WP-5's P3 exit condition (docs/gate-market-spec.md §9.1): "A complete receipt at depth 1 with
// claim_retired: true, and a failed-gate receipt with claim_retired: false." Both scenarios run
// against one shared real devnet (anvil startup cost is real, ~seconds).
describe("WP-5 dry loop — mint -> transfer -> present_for_redemption -> harness -> serve", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 60_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("happy path: gate passes -> claim retired, headroom restored, receipt emitted", async () => {
    const result = await runHappyPath(devnet, runners);

    expect(result.gateResult.passed).toBe(true);
    expect(result.receipt.claim_retired).toBe(true);
    expect(result.holderBalanceAfterServe).toBe(0n); // burned on a genuine pass
    expect(result.headroomAfterServe).toBe(result.headroomBeforeMint); // fully restored
    expect(result.headroomAfterMint).toBeLessThan(result.headroomBeforeMint); // really consumed at mint

    // Every G1-G5 result really ran (a real sandboxed evaluation, not a stub).
    expect(result.gateResult.g1.passed).toBe(true);
    expect(result.gateResult.g2.passed).toBe(true);
    expect(result.gateResult.g3.passed).toBe(true);
    expect(result.gateResult.g5.passed).toBe(true);
  }, 30_000);

  it("failing submission: claim_retired == false and headroom unchanged — failed work counts zero", async () => {
    const result = await runFailingSubmission(devnet, runners);

    expect(result.gateResult.passed).toBe(false);
    expect(result.gateResult.g2.passed).toBe(false); // the specific, confirmed failure mode
    expect(result.receipt.claim_retired).toBe(false);
    expect(result.holderBalanceAfterServe).toBeGreaterThan(0n); // NOT burned — holder keeps it
    expect(result.headroomAfterServe).toBe(result.headroomAfterMint); // unchanged by the failed serve
    expect(result.headroomAfterServe).toBeLessThan(result.headroomBeforeMint); // still consumed by the mint itself
  }, 30_000);
});
