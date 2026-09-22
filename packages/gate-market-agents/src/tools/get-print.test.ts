import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { getPrintTool } from "./get-print.js";
import type { ToolContext } from "../deps.js";

function fakeCtx(overrides: { isReconciled?: (id: string) => Promise<boolean> } = {}): ToolContext {
  return {
    deps: {
      chainReader: {
        usdcBalance: async () => 0n,
        claimBalance: async () => 0n,
        headroom: async () => 0n,
        issuanceLimit: async () => 0n,
      },
      deployment: {
        network: { name: "test", chainId: 0 },
        usdc: { address: "0x0" },
        capacityBond: { address: "0x0" },
        claimRouter: { address: "0x0" },
        workClaim: { address: "0x0" },
      },
      escrowAddress: "0x0",
      runGateHardeningChecks: async () => {
        throw new Error("not used in this test");
      },
      loadPrint: async (printId: string) =>
        ({ print_id: printId, status: "provisional" }) as unknown as Print,
      isReconciled: overrides.isReconciled ?? (async () => false),
    },
    clients: {} as ToolContext["clients"],
    dualRenderer: {} as ToolContext["dualRenderer"],
  };
}

describe("get_print — final-vs-provisional derivation", () => {
  it("reports final:true when the print id is in the reconciled set, never from print.status", async () => {
    const ctx = fakeCtx({ isReconciled: async () => true });
    const result = await getPrintTool.handler(ctx, { printId: "2026-09-13" }, "unused");
    // print.status stays "provisional" on the signed body forever (docs/methodology.md §7) —
    // final:true here must come from isReconciled, never from result.print.status.
    expect(result.print.status).toBe("provisional");
    expect(result.final).toBe(true);
  });

  it("reports final:false when the print id is not yet reconciled", async () => {
    const ctx = fakeCtx({ isReconciled: async () => false });
    const result = await getPrintTool.handler(ctx, { printId: "2026-09-22" }, "unused");
    expect(result.final).toBe(false);
  });
});
