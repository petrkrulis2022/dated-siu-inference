import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { TouchstoneQuote } from "@touchstone/sdk";

// The gate configuration still opens an escrow through `openAndFund`; the lab's direct settlement must never reach it.
const openAndFund = vi.fn(async () => "0xescrowopened");
vi.mock("@touchstone/agents", () => ({ openAndFund: (...a: unknown[]) => openAndFund(...(a as [])) }));

import { payTool } from "./pay.js";
import { getBalancesTool } from "./get-balances.js";
import { settleSplitHeldTool } from "./settle-split-held.js";
import type { ToolContext } from "../deps.js";

const USDC = "0x00000000000000000000000000000000000000a5";
const WORK_CLAIM = "0x00000000000000000000000000000000000000c1";
const SELLER = "0x00000000000000000000000000000000000000cd";
const BUYER = "0x00000000000000000000000000000000000000ab";
const NOW = 1_800_000_000;
const quote = (over: Partial<TouchstoneQuote> = {}): TouchstoneQuote =>
  ({
    schema_version: "2.0",
    siu: "1",
    pattern: "fixed",
    model: "m",
    rate_usd_per_siu: "0.0017244",
    amount_usd_max: "0.0017",
    index_version: "SIU-2026a",
    print_id: "p",
    print_hash: "0x00",
    seller_id: `erc8004:${SELLER}`,
    expiry: new Date((NOW + 3600) * 1000).toISOString(),
    // The address the SDK fills in for the chain: NOT the deployment's token here, as on a local devnet.
    settlement: [{ asset: "usdc", chain: "base-sepolia", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount_max: "1700" }],
    sig: "0xsig",
    ...over,
  }) as TouchstoneQuote;

interface Write {
  address: string;
  functionName: string;
  args: readonly unknown[];
}

function context(over: { direct?: boolean; failOn?: string } = {}): { ctx: ToolContext; writes: Write[] } {
  const writes: Write[] = [];
  const ctx = {
    agentId: "ORCHESTRATOR",
    deps: {
      directSettlement: over.direct ?? true,
      escrowAddress: "0xescrow",
      deployment: { usdc: { address: USDC }, workClaim: { address: WORK_CLAIM } },
      chainReader: {
        currentBlockTimestamp: async () => BigInt(NOW),
        usdcBalance: async () => 5000n,
        claimBalance: async () => 7n,
        escrowState: async () => ({ status: "None", buyer: BUYER, seller: SELLER, maxAmountMinorUnits: 0n, expiryUnix: 0n }),
      },
    },
    clients: {
      account: { address: BUYER },
      walletClient: {
        writeContract: async (w: Write) => {
          if (over.failOn !== undefined && w.functionName === over.failOn) throw new Error("the wallet does not hold enough USDC.\nmore detail");
          writes.push({ address: w.address, functionName: w.functionName, args: w.args });
          return `0xtx${writes.length}` as Hex;
        },
      },
      publicClient: { waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: "success", transactionHash: hash }) },
    },
    dualRenderer: { render: (usd: string) => ({ decimalUsd: usd, integerMinorUnits: "0", liveArm: "decimal" }) },
  } as unknown as ToolContext;
  return { ctx, writes };
}

const PRINT_NANO = "1437000";

beforeEach(() => openAndFund.mockClear());

describe("pay — direct settlement (D30)", () => {
  it("transfers the quote's price to its seller in the DEPLOYMENT's USDC, whatever address the quote names, and opens no escrow", async () => {
    const { ctx, writes } = context();
    const args = payTool.argsSchema.parse({ quote: quote(), settler: "0x0" });
    const result = await payTool.handler(ctx, args, "0xkey");
    expect(writes).toEqual([{ address: USDC, functionName: "transfer", args: [SELLER, 1700n] }]);
    expect(result).toEqual({ txHash: "0xtx1" });
    expect(openAndFund).not.toHaveBeenCalled();
  });

  it("still opens an escrow when the run does not settle directly — the gate configuration is unchanged", async () => {
    const { ctx, writes } = context({ direct: false });
    await payTool.handler(ctx, payTool.argsSchema.parse({ quote: quote(), settler: "0x0" }), "0xkey");
    expect(openAndFund).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it("refuses a quote that has expired, as the escrow would, and a seller id that is not an address", async () => {
    const { ctx, writes } = context();
    await expect(
      payTool.handler(ctx, payTool.argsSchema.parse({ quote: quote({ expiry: new Date((NOW - 1) * 1000).toISOString() }), settler: "0x0" }), "0xkey"),
    ).rejects.toThrow(/pay: this quote expired at/);
    await expect(
      payTool.handler(ctx, payTool.argsSchema.parse({ quote: quote({ seller_id: "someone" }), settler: "0x0" }), "0xkey"),
    ).rejects.toThrow(/expected an "erc8004:0x..." seller_id/);
    expect(writes).toEqual([]); // nothing was sent
  });
});

describe("settle_split_held — a claim you hold and USDC, both direct (D32)", () => {
  const args = (claim: string, over: Record<string, unknown> = {}) =>
    settleSplitHeldTool.argsSchema.parse({ quote: quote(), to: SELLER, tokenId: "7", claimQuantityMilliSiu: claim, nanoUsdPerSiu: PRINT_NANO, ...over });

  it("transfers the claim part and then the rest of the price in USDC, to the seller, and nothing else", async () => {
    const { ctx, writes } = context();
    const result = await settleSplitHeldTool.handler(ctx, args("592"), "0xkey");
    // 592 mSIU at 1,437,000 nano-USD per SIU is worth 850 minor units; the other 850 of the 1,700 is paid in dollars.
    expect(writes).toEqual([
      { address: WORK_CLAIM, functionName: "safeTransferFrom", args: [BUYER, SELLER, 7n, 592n, "0x"] },
      { address: USDC, functionName: "transfer", args: [SELLER, 850n] },
    ]);
    expect(result).toMatchObject({
      tokenId: "7",
      claimQuantityMilliSiu: "592",
      claimValueUsdcMinorUnits: "850",
      usdcMinorUnits: "850",
      claimTxHash: "0xtx1",
      usdcTxHash: "0xtx2",
      claimShare: "0.5000",
    });
    // The two parts add up to the price, exactly.
    expect(BigInt(result.claimValueUsdcMinorUnits) + BigInt(result.usdcMinorUnits)).toBe(1700n);
    expect(openAndFund).not.toHaveBeenCalled();
  });

  it("charges only the USDC part against the spend ceiling", () => {
    expect(settleSplitHeldTool.spendUsd!(args("592"))).toBe("0.000850");
  });

  it("is only a tool of a run that settles directly", async () => {
    const { ctx, writes } = context({ direct: false });
    await expect(settleSplitHeldTool.handler(ctx, args("592"), "0xkey")).rejects.toThrow(/only a run that settles by direct transfer/);
    expect(writes).toEqual([]);
  });

  it("refuses a claim part that is not a split — worth nothing, or the whole price or more — before anything moves", async () => {
    const { ctx, writes } = context();
    for (const bad of ["0", "-1", "1.5", "x"]) {
      await expect(settleSplitHeldTool.handler(ctx, args(bad), "0xkey"), bad).rejects.toThrow(/positive whole number of milli-SIU/);
    }
    await expect(settleSplitHeldTool.handler(ctx, args("1184"), "0xkey")).rejects.toThrow(/worth 1701 USDC minor units at the print; the claim part of a split must be worth less than the quote's 1700/);
    // One milli-SIU is worth less than one minor unit at a print below 1,000,000 nano-USD per SIU: a claim part worth nothing.
    await expect(settleSplitHeldTool.handler(ctx, args("1", { nanoUsdPerSiu: "999999" }), "0xkey")).rejects.toThrow(/is worth nothing at the print/);
    expect(writes).toEqual([]); // every refusal came before anything moved
  });

  it("refuses an expired quote before moving anything", async () => {
    const { ctx, writes } = context();
    await expect(
      settleSplitHeldTool.handler(ctx, args("592", { quote: quote({ expiry: new Date((NOW - 1) * 1000).toISOString() }) }), "0xkey"),
    ).rejects.toThrow(/this quote expired/);
    expect(writes).toEqual([]);
  });

  it("says plainly what moved if the USDC part fails after the claim part did — a half-made payment is never reported as made", async () => {
    const { ctx, writes } = context({ failOn: "transfer" });
    await expect(settleSplitHeldTool.handler(ctx, args("592"), "0xkey")).rejects.toThrow(
      /the claim part moved \(592 mSIU, tx 0xtx1\); the USDC part \(850 minor units\) did not: the wallet does not hold enough USDC\./,
    );
    expect(writes).toHaveLength(1);
  });
});

describe("get_balances — direct settlement has no escrow to report", () => {
  const call = { account: BUYER, tokenIds: ["7"], escrowQuoteHashes: [] as string[] };

  it("omits escrows when payments settle directly, and reports them in the gate configuration", async () => {
    const direct = await getBalancesTool.handler(context({ direct: true }).ctx, getBalancesTool.argsSchema.parse(call), "0xkey");
    expect(direct).not.toHaveProperty("escrows");
    expect(direct.claims).toEqual([{ tokenId: "7", balance: "7" }]);
    const gate = await getBalancesTool.handler(context({ direct: false }).ctx, getBalancesTool.argsSchema.parse(call), "0xkey");
    expect(gate.escrows).toEqual([]);
  });
});
