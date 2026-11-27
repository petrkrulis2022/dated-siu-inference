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
  parseUsdc,
  recoverBurnIntentSigner,
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
        destinationCaller: b32("0x0000000000000000000000000000000000000000"),
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
    ["a named mint caller", (t: BurnIntentTypedData) => void (t.message.spec.destinationCaller = b32("0x000000000000000000000000000000000000dEaD"))],
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
