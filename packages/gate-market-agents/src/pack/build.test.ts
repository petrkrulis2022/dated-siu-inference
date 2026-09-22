import { describe, expect, it } from "vitest";
import { CODE_COMMERCIAL_INTENT, CODE_GATE_3_HARDENED } from "@touchstone/gate-market";
import { buildCommonPack } from "./build.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";

describe("buildCommonPack — spec §8.1", () => {
  it("embeds the canonical asset description verbatim", () => {
    const pack = buildCommonPack({
      agentId: "WORKER-CODE",
      walletAddress: "0x1111111111111111111111111111111111111a",
      erc8004Id: "erc8004:0x1111111111111111111111111111111111111a",
      usdcBalanceUsd: "5.00",
      claimBalancesSummary: "0 claims held",
      classes: [
        {
          taskClass: "code",
          gateSource: CODE_GATE_3_HARDENED.source,
          commercialIntent: CODE_COMMERCIAL_INTENT,
        },
      ],
      printsByClass: {},
    });
    expect(pack).toContain(CANONICAL_ASSET_DESCRIPTION);
  });

  it("embeds the real gate source and commercial intent for each listed class", () => {
    const pack = buildCommonPack({
      agentId: "WORKER-CODE",
      walletAddress: "0x1111111111111111111111111111111111111a",
      erc8004Id: "erc8004:0x1111111111111111111111111111111111111a",
      usdcBalanceUsd: "5.00",
      claimBalancesSummary: "0 claims held",
      classes: [
        {
          taskClass: "code",
          gateSource: CODE_GATE_3_HARDENED.source,
          commercialIntent: CODE_COMMERCIAL_INTENT,
        },
      ],
      printsByClass: {},
    });
    expect(pack).toContain(CODE_GATE_3_HARDENED.source);
    expect(pack).toContain(CODE_COMMERCIAL_INTENT);
  });

  it("says honestly when no print has been measured for a class, rather than fabricating one", () => {
    const pack = buildCommonPack({
      agentId: "WORKER-CODE",
      walletAddress: "0x1111111111111111111111111111111111111a",
      erc8004Id: "erc8004:0x1111111111111111111111111111111111111a",
      usdcBalanceUsd: "5.00",
      claimBalancesSummary: "0 claims held",
      classes: [
        {
          taskClass: "code",
          gateSource: CODE_GATE_3_HARDENED.source,
          commercialIntent: CODE_COMMERCIAL_INTENT,
        },
      ],
      printsByClass: {}, // no real per-class print exists yet — spec phase P2, unbuilt
    });
    expect(pack).toContain("code: no print measured yet");
  });

  it("reports a real injected print when one is supplied", () => {
    const pack = buildCommonPack({
      agentId: "WORKER-CODE",
      walletAddress: "0x1111111111111111111111111111111111111a",
      erc8004Id: "erc8004:0x1111111111111111111111111111111111111a",
      usdcBalanceUsd: "5.00",
      claimBalancesSummary: "0 claims held",
      classes: [
        {
          taskClass: "code",
          gateSource: CODE_GATE_3_HARDENED.source,
          commercialIntent: CODE_COMMERCIAL_INTENT,
        },
      ],
      printsByClass: { code: { printId: "2026-09-22-code", rateUsdPerSiu: "0.0107" } },
    });
    expect(pack).toContain("print 2026-09-22-code, 0.0107 USD/SIU");
  });

  it("never mentions the monetary design doc or the gate-market spec by name", () => {
    const pack = buildCommonPack({
      agentId: "ISSUER-A",
      walletAddress: "0x1111111111111111111111111111111111111a",
      erc8004Id: "erc8004:0x1111111111111111111111111111111111111a",
      usdcBalanceUsd: "5.00",
      claimBalancesSummary: "0 claims held",
      classes: [],
      printsByClass: {},
    });
    expect(pack).not.toMatch(/monetary.design|gate-market-spec/i);
  });
});
