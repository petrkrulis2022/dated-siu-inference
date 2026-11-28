import { describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MAINNET_PAYMENT_NETWORKS } from "@touchstone/print";
import {
  GATEWAY,
  assertSafeBurnIntent,
  buildWithdrawal,
  chainFor,
  formatUsdc,
  gatewayMintCalldata,
  mintFacts,
  parseUsdc,
  plainMintProblems,
  recoverBurnIntentSigner,
  treasuryCodeProblem,
  withdrawalRefusals,
  type BurnIntentTypedData,
} from "./gateway-withdrawal.js";

const TREASURY = "0xB514882859f43DbF3df664C899D707f649E0CF4A";
const SALT = `0x${"ab".repeat(32)}` as const;

const build = (over: Partial<Parameters<typeof buildWithdrawal>[0]> = {}) =>
  buildWithdrawal({
    env: "mainnet",
    chain: "arc",
    treasury: TREASURY,
    value: 500_000n,
    maxFee: 3_850n,
    maxBlockHeight: 34_789_781n,
    salt: SALT,
    ...over,
  });

const b32 = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}` as const;

describe("the chains a withdrawal can use", () => {
  it("are on mainnet exactly the networks payments arrive on, with the same USDC contracts", () => {
    expect(GATEWAY.mainnet.chains.map((c) => [c.chainId, c.usdc.toLowerCase()])).toEqual(
      MAINNET_PAYMENT_NETWORKS.map((n) => [Number(n.caip2.split(":")[1]), n.assetAddress.toLowerCase()]),
    );
  });

  it("use Circle's published Gateway contracts and domains (Base 6, Arc 26)", () => {
    expect(GATEWAY.mainnet.wallet).toBe("0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE");
    expect(GATEWAY.mainnet.minter).toBe("0x2222222d7164433c4C09B0b0D809a9b52C04C205");
    expect(GATEWAY.testnet.wallet).toBe("0x0077777d7EBA4688BDeF3E311b846F25870A19B9");
    expect(GATEWAY.testnet.minter).toBe("0x0022222ABE238Cc2C7Bb1f21003F0a260052475B");
    for (const env of ["mainnet", "testnet"] as const)
      expect(GATEWAY[env].chains.map((c) => c.domain)).toEqual([6, 26]);
  });

  it("refuses a chain that belongs to the other environment", () => {
    expect(() => chainFor("mainnet", "base-sepolia")).toThrow(/base-sepolia/);
    expect(() => chainFor("testnet", "arc")).toThrow(/arc/);
  });
});

describe("parseUsdc / formatUsdc", () => {
  it("convert exactly, six decimals, no floats", () => {
    expect(parseUsdc("0.5")).toBe(500_000n);
    expect(parseUsdc("0.003000")).toBe(3_000n);
    expect(parseUsdc("12")).toBe(12_000_000n);
    expect(formatUsdc(3_850n)).toBe("0.003850");
    expect(formatUsdc(12_000_001n)).toBe("12.000001");
  });

  it("refuse anything that is not a plain USDC amount", () => {
    for (const bad of ["", "-1", "1.1234567", "1e3", ".5", "1,5", " 1"]) expect(() => parseUsdc(bad)).toThrow(/USDC amount/);
  });
});

describe("buildWithdrawal", () => {
  it("is a same-chain burn intent from the treasury's Gateway balance to the treasury itself", () => {
    const t = build();
    expect(t.domain).toEqual({ name: "GatewayWallet", version: "1" });
    expect(t.primaryType).toBe("BurnIntent");
    expect(t.message).toEqual({
      maxBlockHeight: "34789781",
      maxFee: "3850",
      spec: {
        version: 1,
        sourceDomain: 26,
        destinationDomain: 26,
        sourceContract: b32(GATEWAY.mainnet.wallet),
        destinationContract: b32(GATEWAY.mainnet.minter),
        sourceToken: b32("0x3600000000000000000000000000000000000000"),
        destinationToken: b32("0x3600000000000000000000000000000000000000"),
        sourceDepositor: b32(TREASURY),
        destinationRecipient: b32(TREASURY),
        sourceSigner: b32(TREASURY),
        destinationCaller: b32(TREASURY),
        value: "500000",
        salt: SALT,
        hookData: "0x",
      },
    });
  });

  it("passes its own safety check", () => {
    expect(() => assertSafeBurnIntent(build(), { env: "mainnet", chain: "arc", treasury: TREASURY })).not.toThrow();
  });
});

describe("assertSafeBurnIntent", () => {
  const ctx = { env: "mainnet" as const, chain: "arc", treasury: TREASURY };
  const tamper = (f: (t: BurnIntentTypedData) => void): BurnIntentTypedData => {
    const t = structuredClone(build());
    f(t);
    return t;
  };

  it.each([
    ["another recipient", (t: BurnIntentTypedData) => void (t.message.spec.destinationRecipient = b32("0x000000000000000000000000000000000000dEaD"))],
    ["another chain as destination", (t: BurnIntentTypedData) => void (t.message.spec.destinationDomain = 6)],
    ["another minter", (t: BurnIntentTypedData) => void (t.message.spec.destinationContract = b32("0x000000000000000000000000000000000000dEaD"))],
    ["another depositor", (t: BurnIntentTypedData) => void (t.message.spec.sourceDepositor = b32("0x000000000000000000000000000000000000dEaD"))],
    ["a mint caller other than the treasury", (t: BurnIntentTypedData) => void (t.message.spec.destinationCaller = b32("0x000000000000000000000000000000000000dEaD"))],
    ["a mint anyone may send (zero caller)", (t: BurnIntentTypedData) => void (t.message.spec.destinationCaller = b32("0x0000000000000000000000000000000000000000"))],
    ["hook data", (t: BurnIntentTypedData) => void (t.message.spec.hookData = "0x01")],
    ["a signature that never expires", (t: BurnIntentTypedData) => void (t.message.maxBlockHeight = (2n ** 256n - 1n).toString())],
    ["another EIP-712 domain", (t: BurnIntentTypedData) => void (t.domain.name = "Something")],
    ["another token", (t: BurnIntentTypedData) => void (t.message.spec.destinationToken = b32("0x000000000000000000000000000000000000dEaD"))],
  ])("refuses %s", (_name, f) => {
    expect(() => assertSafeBurnIntent(tamper(f), ctx)).toThrow(/unsafe burn intent/);
  });
});

describe("withdrawalRefusals", () => {
  it("accepts an amount whose fee fits in the balance beside it", () => {
    expect(withdrawalRefusals({ value: 500_000n, maxFee: 3_850n, balance: 1_000_000n })).toEqual([]);
    expect(withdrawalRefusals({ value: 996_150n, maxFee: 3_850n, balance: 1_000_000n })).toEqual([]);
  });

  it("refuses zero, a fee as large as the amount, and more than the balance can carry with its fee", () => {
    expect(withdrawalRefusals({ value: 0n, maxFee: 3_850n, balance: 1_000_000n })[0]).toMatch(/above zero/);
    expect(withdrawalRefusals({ value: 3_000n, maxFee: 3_850n, balance: 1_000_000n })[0]).toMatch(/fee/);
    expect(withdrawalRefusals({ value: 996_151n, maxFee: 3_850n, balance: 1_000_000n })[0]).toMatch(/at most 0\.996150/);
  });

  it("refuses today's treasury balance on Arc: 0.003 cannot carry Circle's 0.00385 fee", () => {
    expect(withdrawalRefusals({ value: 3_000n, maxFee: 3_850n, balance: 3_000n }).length).toBeGreaterThan(0);
  });
});

describe("recoverBurnIntentSigner", () => {
  it("recovers the account that signed the typed data, and no other", async () => {
    const signer = privateKeyToAccount(generatePrivateKey());
    const t = build({ treasury: signer.address });
    const signature = await signer.signTypedData({
      domain: t.domain,
      types: { TransferSpec: t.types.TransferSpec, BurnIntent: t.types.BurnIntent },
      primaryType: "BurnIntent",
      message: {
        maxBlockHeight: BigInt(t.message.maxBlockHeight),
        maxFee: BigInt(t.message.maxFee),
        spec: { ...t.message.spec, value: BigInt(t.message.spec.value) },
      },
    });
    expect((await recoverBurnIntentSigner(t, signature)).toLowerCase()).toBe(signer.address.toLowerCase());
    const other = build({ treasury: signer.address, value: 500_001n });
    expect((await recoverBurnIntentSigner(other, signature)).toLowerCase()).not.toBe(signer.address.toLowerCase());
  });
});

describe("treasuryCodeProblem", () => {
  it("passes a plain account, which has no code", () => {
    expect(treasuryCodeProblem("0x", "Base")).toBeUndefined();
  });

  it("stops on an EIP-7702 delegation and names the contract it delegates to", () => {
    // The treasury's code on Base Sepolia after MetaMask's smart-account upgrade, 2026-11-27.
    const problem = treasuryCodeProblem("0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b", "Base Sepolia");
    expect(problem).toMatch(/^Stop: on Base Sepolia the treasury is not a plain account/);
    expect(problem).toContain("0x63c0c19a282a1b52b07dd5a65b58948a07dae32b");
  });

  it("stops on any other code too", () => {
    expect(treasuryCodeProblem("0x6080604052", "Arc")).toMatch(/^Stop: on Arc the treasury address holds contract code/);
  });
});

describe("plainMintProblems", () => {
  const MINTER = GATEWAY.testnet.minter;
  const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const DATA = gatewayMintCalldata("0x1234", "0xabcd");
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
  const mintLog = { address: USDC_BASE_SEPOLIA.toLowerCase(), topics: [TRANSFER, topic("0x0000000000000000000000000000000000000000"), topic(TREASURY)], data: `0x${(500_000).toString(16).padStart(64, "0")}` };
  const expected = { treasury: TREASURY, minter: MINTER, data: DATA, usdc: USDC_BASE_SEPOLIA, value: 500_000n };
  const plainTx = { type: "0x2", from: TREASURY.toLowerCase(), to: MINTER.toLowerCase(), input: DATA, value: "0x0" };
  const okReceipt = { status: "0x1", logs: [mintLog] };

  it("finds nothing wrong with a plain transaction from the treasury to the GatewayMinter that minted the amount", () => {
    expect(plainMintProblems(plainTx, okReceipt, expected)).toEqual([]);
  });

  it("reports the Base Sepolia mint of 2026-11-27, relayed through MetaMask's Delegation Manager, in plain words", () => {
    const relayed = {
      type: "0x4",
      from: "0xb42f812a44c22cc6b861478900401ee759ebead6",
      to: "0xdb9b1e94b5b69df7e401ddbede43491141047db3",
      input: "0xcef6d209" + "00".repeat(64),
      value: "0x0",
      authorizationList: [{ address: "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b" }],
    };
    const problems = plainMintProblems(relayed, okReceipt, expected);
    expect(problems.join(" ")).toMatch(/type-4 \(EIP-7702\)/);
    expect(problems.join(" ")).toMatch(/sent by 0xb42f812a44c22cc6b861478900401ee759ebead6, not by the treasury/);
    expect(problems.join(" ")).toMatch(/went to 0xdb9b1e94b5b69df7e401ddbede43491141047db3, not to the GatewayMinter/);
    expect(problems.join(" ")).toMatch(/data is not the mint this page prepared/);
  });

  it("reports a reverted mint, a missing transaction and a mint that paid the treasury nothing", () => {
    expect(plainMintProblems(plainTx, { status: "0x0", logs: [] }, expected).join(" ")).toMatch(/failed on chain/);
    expect(plainMintProblems(undefined, undefined, expected).join(" ")).toMatch(/not found on the chain/);
    expect(plainMintProblems(plainTx, { status: "0x1", logs: [] }, expected).join(" ")).toMatch(/No mint of 0\.500000 USDC to the treasury/);
  });

  it("reports value sent along with the call", () => {
    expect(plainMintProblems({ ...plainTx, value: "0x1" }, okReceipt, expected).join(" ")).toMatch(/carried a value/);
  });
});

describe("mintFacts", () => {
  const MINTER = GATEWAY.testnet.minter;
  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const DATA = gatewayMintCalldata("0x1234", "0xabcd");
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;
  const mintLog = (value: number) => ({ address: USDC.toLowerCase(), topics: [TRANSFER, topic("0x0000000000000000000000000000000000000000"), topic(TREASURY)], data: `0x${value.toString(16).padStart(64, "0")}` });
  const expected = { treasury: TREASURY, minter: MINTER, data: DATA, usdc: USDC, value: 100_000n };

  it("states exactly what happened in a plain mint", () => {
    const facts = mintFacts({ type: "0x2", from: TREASURY.toLowerCase(), to: MINTER.toLowerCase(), input: DATA, value: "0x0" }, { status: "0x1", logs: [mintLog(100_000)] }, expected);
    expect(facts).toEqual({
      status: "succeeded",
      sender: `${TREASURY.toLowerCase()} (the treasury)`,
      type: "0x2 (ordinary)",
      target: `${MINTER.toLowerCase()} (the GatewayMinter)`,
      data: "exactly the prepared mint",
      receivedByTreasury: "0.100000 USDC",
    });
  });

  it("states exactly what happened in the relayed Base Sepolia mint of 2026-11-27", () => {
    const facts = mintFacts(
      { type: "0x4", from: "0xb01caea8c6c47bbf4f4b4c5080ca642043359c2e", to: "0xdb9b1e94b5b69df7e401ddbede43491141047db3", input: "0xcef6d209", value: "0x0", authorizationList: [{ address: "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b" }] },
      { status: "0x1", logs: [mintLog(100_000)] },
      expected,
    );
    expect(facts.sender).toBe("0xb01caea8c6c47bbf4f4b4c5080ca642043359c2e (not the treasury: a relayer)");
    expect(facts.type).toBe("0x4 (EIP-7702, authorising 0x63c0c19a282a1b52b07dd5a65b58948a07dae32b)");
    expect(facts.target).toBe("0xdb9b1e94b5b69df7e401ddbede43491141047db3 (not the GatewayMinter)");
    expect(facts.data).toBe("not the prepared mint");
    expect(facts.receivedByTreasury).toBe("0.100000 USDC");
  });

  it("says when the transaction was not found or reverted", () => {
    expect(mintFacts(null, null, expected)).toEqual({ status: "not found on the chain" });
    expect(mintFacts({ type: "0x2", from: TREASURY, to: MINTER, input: DATA, value: "0x0" }, { status: "0x0", logs: [] }, expected).status).toBe("reverted");
  });
});

describe("gatewayMintCalldata", () => {
  it("calls gatewayMint(bytes,bytes) with Circle's attestation and signature, unchanged", () => {
    const data = gatewayMintCalldata("0x1234", "0xabcdef");
    expect(data.slice(0, 10)).toBe(toFunctionSelector("gatewayMint(bytes,bytes)"));
    const decoded = decodeFunctionData({ abi: parseAbi(["function gatewayMint(bytes attestationPayload, bytes signature)"]), data });
    expect(decoded.args).toEqual(["0x1234", "0xabcdef"]);
  });

  it("refuses anything that is not hex", () => {
    expect(() => gatewayMintCalldata("1234", "0xab")).toThrow(/hex/);
  });
});
