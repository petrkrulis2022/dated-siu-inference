import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { WhoamiResult } from "../tools/whoami.js";

/**
 * `whoami` against real bonded lots. Added 2026-09-28 after a run in which ISSUER-B spent nine of
 * its fifteen turns, and its whole inference ceiling, trying to establish who it was — deriving
 * its own address from issuance-limit arithmetic because nothing would tell it.
 */
describe("whoami — an agent's own identity and bonded position", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("tells a real issuer it is one, and reports its real lots and headroom", async () => {
    const record = await runners["ISSUER-A"].callTool(
      "whoami",
      { address: devnet.agents["ISSUER-A"].address },
      { turn: 1, jobId: "whoami" },
    );
    const result = record.result as WhoamiResult;

    expect(result.address.toLowerCase()).toBe(devnet.agents["ISSUER-A"].address.toLowerCase());
    expect(result.isIssuer).toBe(true);
    // The devnet bonds both classes for ISSUER-A (devnet/deploy.ts's LOT_HOURS).
    expect(result.lots.map((l) => l.taskClass).sort()).toEqual(["code", "extract"]);
    for (const lot of result.lots) {
      expect(BigInt(lot.issuanceLimitMilliSiu)).toBeGreaterThan(0n);
      expect(lot.classId).toMatch(/^0x[0-9a-f]{64}$/);
    }
  }, 120_000);

  it("tells a non-issuer it is not one, rather than returning an empty-looking success", async () => {
    const record = await runners.ORCHESTRATOR.callTool(
      "whoami",
      { address: devnet.agents.ORCHESTRATOR.address },
      { turn: 1, jobId: "whoami" },
    );
    const result = record.result as WhoamiResult;
    expect(result.isIssuer).toBe(false);
    expect(result.lots).toEqual([]);
  }, 120_000);
});
