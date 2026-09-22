import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runHeadroomExhaustion } from "./headroom-exhaustion.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

// Own fresh devnet: this scenario drains ISSUER-A's `code` headroom to exactly zero, which would
// break any other scenario sharing the same instance.
describe("WP-5 §4.5 — headroom exhaustion in one class", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("routing finds ISSUER-B once ISSUER-A's headroom is exhausted", async () => {
    const result = await runHeadroomExhaustion(devnet, runners);
    expect(result.issuerAHeadroomBefore).toBeGreaterThan(0n);
    expect(result.routedIssuerAfterExhaustion.toLowerCase()).toBe(
      devnet.agents["ISSUER-B"].address.toLowerCase(),
    );
  }, 90_000);
});
