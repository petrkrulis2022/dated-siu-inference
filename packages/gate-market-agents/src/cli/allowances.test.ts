import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, erc20Abi, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import type { AgentId } from "../identity/resolve.js";
import { allowanceShortfalls, approveForSpender, assertAllowancesForRun, labRosterTargets, rosterKey, rosterTargets } from "./allowances.js";

describe("allowanceShortfalls", () => {
  it("names every holder whose allowance is below its minimum, and only those", () => {
    const rows = [
      { label: "ORCHESTRATOR", current: 0n, minimum: 200_000n },
      { label: "WORKER-CODE", current: 200_000n, minimum: 200_000n },
      { label: "operator", current: 99_999n, minimum: 100_000n },
    ];
    expect(allowanceShortfalls(rows).map((r) => r.label)).toEqual(["ORCHESTRATOR", "operator"]);
  });
});

describe("assertAllowancesForRun", () => {
  it("passes when every holder can cover the run", () => {
    expect(() => assertAllowancesForRun([{ label: "ORCHESTRATOR", current: 1n, minimum: 1n }], "cmd")).not.toThrow();
  });

  it("refuses to start a run that cannot mint, names who, and names the command that fixes it", () => {
    // The first debug run on a new deployment found this by failing — after a window had been paid
    // for, with the operator's drain and the external buyer both reverting `transfer amount exceeds
    // allowance`. A new WorkClaim starts with no allowance from anyone.
    const why = () =>
      assertAllowancesForRun(
        [
          { label: "ORCHESTRATOR", current: 0n, minimum: 200_000n },
          { label: "WORKER-CODE", current: 5_000_000n, minimum: 200_000n },
        ],
        "pnpm run approve-roster -- --deployment X --execute",
      );
    expect(why).toThrow(/ORCHESTRATOR/);
    expect(why).toThrow(/pnpm run approve-roster -- --deployment X --execute/);
    expect(why).not.toThrow(/WORKER-CODE/);
  });
});

describe("reading the roster's keys from the environment", () => {
  // `.env` stores private keys WITHOUT a 0x prefix (the runner normalises them). The first version of
  // this tool handed the operator's key to viem raw and died with "invalid private key".
  const raw = generatePrivateKey();
  const bare = raw.slice(2);
  const env = (key: string): NodeJS.ProcessEnv => ({
    DEPLOYER_PRIVATE_KEY: key,
    ORCHESTRATOR_ADDRESS: "0x00000000000000000000000000000000000000a1",
    WORKER_CODE_ADDRESS: "0x00000000000000000000000000000000000000b2",
    ORCHESTRATOR_PRIVATE_KEY: key,
  });

  it("accepts a key with or without the 0x prefix, and derives the same operator address", () => {
    const expected = privateKeyToAccount(raw).address;
    for (const key of [raw, bare]) {
      const op = rosterTargets(env(key)).find((t) => t.label === "operator");
      expect(op?.address, key.slice(0, 6)).toBe(expected);
      expect(rosterKey(env(key), "operator")).toBe(raw);
    }
  });

  it("approves only the mint-capable holders: the two buyers and the operator", () => {
    expect(rosterTargets(env(raw)).map((t) => t.label)).toEqual(["ORCHESTRATOR", "WORKER-CODE", "operator"]);
  });

  it("for the currency lab, approves all four traders and the operator — every one of them can mint", () => {
    const e = { ...env(raw), WORKER_EXTRACT_ADDRESS: "0x3", TRADER_4_ADDRESS: "0x4" };
    expect(labRosterTargets(e).map((t) => t.label)).toEqual(["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT", "TRADER-4", "operator"]);
    // TRADER-4 is its own wallet: ISSUER-A's is never read for the lab (D22), and its key follows the label.
    expect(labRosterTargets(e).find((t) => t.label === "TRADER-4")?.address).toBe("0x4");
    expect(labRosterTargets({ ...e, ISSUER_A_ADDRESS: "0xdead" }).some((t) => t.address === "0xdead")).toBe(false);
    expect(rosterKey({ ...env(raw), TRADER_4_PRIVATE_KEY: bare }, "TRADER-4")).toBe(raw);
    // The gate configuration's list is untouched.
    expect(rosterTargets(e).map((t) => t.label)).toEqual(["ORCHESTRATOR", "WORKER-CODE", "operator"]);
    expect(() => labRosterTargets(env(raw))).toThrow(/WORKER_EXTRACT_ADDRESS is not set/);
  });

  it("names a missing variable rather than failing somewhere inside viem", () => {
    expect(() => rosterTargets({ ORCHESTRATOR_ADDRESS: "0x1", WORKER_CODE_ADDRESS: "0x2" })).toThrow(/DEPLOYER_PRIVATE_KEY is not set/);
  });
});

describe("approveForSpender on real bytecode", () => {
  let devnet: DevnetHandle;
  let blockNumber: () => Promise<bigint>;
  let spender: Hex;
  let usdc: Hex;

  const keyFor = (label: string): Hex => devnet.agents[label as AgentId].privateKeyHex;
  const allowanceOf = (label: string): Promise<bigint> =>
    createPublicClient({ transport: http(devnet.rpcUrl) }).readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [devnet.agents[label as AgentId].address, spender],
    });
  const targets = () => [
    { label: "ORCHESTRATOR", address: devnet.agents.ORCHESTRATOR.address, minimum: 500_000n, target: 1_000_000n },
    { label: "WORKER-CODE", address: devnet.agents["WORKER-CODE"].address, minimum: 500_000n, target: 1_000_000n },
  ];
  const run = (over: Partial<Parameters<typeof approveForSpender>[0]> = {}) =>
    approveForSpender({ targets: targets(), usdc, spender, rpcUrl: devnet.rpcUrl, keyFor, pollMs: 25, ...over });

  beforeAll(async () => {
    devnet = await setupDevnet();
    usdc = devnet.deployment.usdc.address as Hex;
    spender = devnet.deployment.workClaim.address as Hex;
    blockNumber = () => createPublicClient({ transport: http(devnet.rpcUrl) }).getBlockNumber();
    // A fresh deployment: nobody has approved its WorkClaim. (The devnet pre-approves, so undo it.)
    for (const label of ["ORCHESTRATOR", "WORKER-CODE"]) {
      const account = privateKeyToAccount(keyFor(label));
      const wallet = createWalletClient({ account, transport: http(devnet.rpcUrl) });
      const hash = await wallet.writeContract({ account, chain: undefined, address: usdc, abi: erc20Abi, functionName: "approve", args: [spender, 0n] });
      await createPublicClient({ transport: http(devnet.rpcUrl) }).waitForTransactionReceipt({ hash });
    }
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("starts from a deployment nobody has approved", async () => {
    expect(await allowanceOf("ORCHESTRATOR")).toBe(0n);
    expect(await allowanceOf("WORKER-CODE")).toBe(0n);
  });

  it("sends nothing by default: a dry run reports what it would approve and mines no block", async () => {
    const before = await blockNumber();
    const results = await run();
    expect(results.map((r) => r.status)).toEqual(["would_approve", "would_approve"]);
    expect(await blockNumber()).toBe(before);
    expect(await allowanceOf("ORCHESTRATOR")).toBe(0n);
  });

  it("refuses a key that does not control the address, before sending anything", async () => {
    const before = await blockNumber();
    await expect(run({ dryRun: false, keyFor: () => keyFor("WORKER-EXTRACT") })).rejects.toThrow(/controls .* but the target names/);
    expect(await blockNumber()).toBe(before);
  });

  it("approves each holder's target, and the allowance is then what was asked for", async () => {
    const results = await run({ dryRun: false });
    expect(results.map((r) => r.status)).toEqual(["approved", "approved"]);
    expect(results.every((r) => r.txHash !== undefined)).toBe(true);
    expect(await allowanceOf("ORCHESTRATOR")).toBe(1_000_000n);
    expect(await allowanceOf("WORKER-CODE")).toBe(1_000_000n);
  }, 120_000);

  it("is idempotent, and leaves alone an allowance that is already above its minimum", async () => {
    const before = await blockNumber();
    const results = await run({ dryRun: false });
    expect(results.map((r) => r.status)).toEqual(["sufficient", "sufficient"]);
    expect(await blockNumber()).toBe(before);
    expect(await allowanceOf("ORCHESTRATOR")).toBe(1_000_000n);
  });
});
