import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runCrossClassUnavailability } from "./cross-class-unavailability.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

describe("WP-5 §4.5 — cross-class unavailability", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("exhausting extract headroom leaves the same issuer's code headroom completely untouched", async () => {
    const result = await runCrossClassUnavailability(devnet, runners);
    expect(result.codeHeadroomBefore).toBeGreaterThan(0n);
    expect(result.codeHeadroomAfter).toBe(result.codeHeadroomBefore);
  }, 90_000);
});
