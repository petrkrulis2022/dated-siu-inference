import { createWalletClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry as anvilChain } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANVIL_TEST_MNEMONIC,
  ChainReplay,
  foundryAvailable,
  replayOnAnvil,
  scriptedWindows,
  type ReplayResult,
} from "./chain-replay.js";
import { MemoryChain } from "./memory-chain.js";
import type { World } from "./world.js";

// DW1 needs a local anvil and forge (the real contracts, deployed by their own script); without them the suite is skipped, never faked
const foundry = await foundryAvailable();
const title = foundry
  ? "development window DW1: a scripted window replayed onto the real contracts on anvil"
  : "development window DW1 (SKIPPED: anvil and forge are not on PATH; install Foundry to run it)";

describe.skipIf(!foundry)(title, () => {
  let world: World;
  let replay: ChainReplay;
  let result: ReplayResult;

  beforeAll(async () => {
    world = await scriptedWindows("dw1-test", [1, 2, 3]);
    replay = await ChainReplay.open(world.chain);
    result = await replay.replay();
  }, 600_000);
  afterAll(async () => {
    await replay?.close();
  });

  it("carries out every journal entry on the chain, with no finding", () => {
    expect(result.entries).toBe(world.chain.journal.length);
    expect(result.findings, JSON.stringify(result.findings, null, 1)).toEqual([]);
    expect(result.replayed).toBe(result.entries);
    // the window exercised every kind of call the economy makes on the chain
    const ops = new Set(world.chain.journal.map((e) => e.op));
    for (const op of [
      "createLot",
      "seedBuffer",
      "mint",
      "create",
      "roll",
      "escrowOpen",
      "escrowSettle",
      "present",
      "serve",
      "settleWindowClose",
      "redeem",
      "transfer",
    ] as const)
      expect(ops.has(op), op).toBe(true);
  });

  it("ends with the same balances on both ledgers: an empty diff", () => {
    expect(result.diff, JSON.stringify(result.diff, null, 1)).toEqual([]);
  });

  it("reports a deliberately altered memory balance, claim and supply", async () => {
    const m = world.chain;
    const usdc = m.balance("DEMAND-1", "USDC");
    const tokenId = [...m.claimTypes.keys()].find((t) => m.claimBalance("reserve", t) > 0n);
    if (tokenId === undefined) throw new Error("the reserve holds no claim to alter");
    const holders = m.claims.get(tokenId) as Map<string, bigint>;
    const face = holders.get("reserve") as bigint;
    m.usdc.set("DEMAND-1", usdc + 1n);
    holders.set("reserve", face - 1n);
    m.aguSupply += 7n;
    try {
      const diff = await replay.compare(m);
      expect(diff).toContainEqual({
        what: "usdc",
        key: "DEMAND-1",
        memory: (usdc + 1n).toString(),
        chain: usdc.toString(),
      });
      expect(diff).toContainEqual({
        what: "claim",
        key: `${tokenId} @ reserve`,
        memory: (face - 1n).toString(),
        chain: face.toString(),
      });
      expect(diff.some((r) => r.what === "supply")).toBe(true);
      expect(diff.some((r) => r.what === "live face")).toBe(true);
    } finally {
      m.usdc.set("DEMAND-1", usdc);
      holders.set("reserve", face);
      m.aguSupply -= 7n;
    }
    expect(await replay.compare(m)).toEqual([]);
  });
});

describe.skipIf(!foundry)(
  "DW1's replayer stops at the first disagreement and reports both sides",
  () => {
    it("stops at the first entry whose balances differ, naming the entry and both sides' balances", async () => {
      const world = await scriptedWindows("dw1-stop", [1]);
      const replay = await ChainReplay.open(world.chain);
      try {
        // the chain is changed behind the replay's back: one extra test-USDC base unit for DEMAND-1
        const wallet = createWalletClient({
          account: mnemonicToAccount(ANVIL_TEST_MNEMONIC),
          chain: anvilChain,
          transport: http(replay.rpcUrl),
        });
        await wallet.writeContract({
          address: replay.contracts.dollar,
          abi: parseAbi(["function mint(address to, uint256 amount)"]),
          functionName: "mint",
          args: [replay.addressOf("DEMAND-1"), 1n],
        });
        const r = await replay.replay();
        const first = world.chain.journal.findIndex((e) => e.args.includes("DEMAND-1"));
        expect(r.findings).toHaveLength(1);
        const f = r.findings[0];
        expect(f?.kind).toBe("different balances");
        expect(f?.entry).toBe(first);
        expect(r.replayed).toBe(first);
        const b = f?.balances.find((x) => x.account === "DEMAND-1" && x.asset === "USDC");
        expect(BigInt(b?.chain ?? "0")).toBe(BigInt(b?.memoryAfter ?? "0") + 1n);
      } finally {
        await replay.close();
      }
    }, 300_000);

    it("agrees with AguLab that the participant may not buy front claims in the roll (R6; the replay's finding, fixed in the memory model 2026-11-05)", async () => {
      const T0 = 1_800_000_000 - (1_800_000_000 % 86_400);
      const D = 86_400;
      const rate = 13_163_480n;
      const clock = { now: T0 };
      const m = new MemoryChain(
        {
          reserveSeries: "commodity",
          minTenorSeconds: 43_200,
          discountBps: 1_000n,
          bufferTarget: 2_000_000n,
        },
        "AGU-ISSUER",
        () => clock.now,
      );
      m.mintTestUsdc("I1", 10_000_000n);
      m.createLot("I1", "CR-PL", 1n, 100_000n, 1_000_000n);
      m.mintTestUsdc("participant", 10_000_000n);
      m.mintTestUsdc("OWNER", 2_000_000n);
      m.seedBuffer("OWNER", 2_000_000n);
      const front = m.mint("participant", "CR-PL", "commodity", 1_000n, T0 + D, T0 + 2 * D, rate);
      m.create("participant", front, 1_000n);
      clock.now = T0 + D + 8_640;
      expect(() =>
        m.roll("AGU-ISSUER", {
          rate,
          frontLots: [front],
          sales: [{ buyer: "participant", tokenId: front, milli: 250n }],
          buys: [{ classId: "CR-PL", milli: 1_000n }],
          buyFrom: T0 + 4 * D,
          buyTo: T0 + 5 * D,
        }),
      ).toThrow(/IneligibleBuyer/);
      // what memory did carry out replays onto the contracts with nothing different
      const r = await replayOnAnvil(m, { build: false });
      expect(r.findings).toEqual([]);
      expect(r.diff).toEqual([]);
    }, 120_000);
  },
);
