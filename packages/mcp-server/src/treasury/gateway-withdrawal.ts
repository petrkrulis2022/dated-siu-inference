import { encodeFunctionData, getAddress, isHex, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";

/**
 * Withdrawing the treasury's Circle Gateway balance, the money paid tools earn: batched
 * Nanopayments credit the treasury's Gateway balance, not its wallet. A withdrawal is Gateway's
 * "transfer" from that balance to the same chain, in three steps (Circle's Gateway technical guide
 * and EVM quickstart, checked against the live docs 2026-11-27):
 *
 *   1. the treasury signs an EIP-712 BurnIntent (domain {name: "GatewayWallet", version: "1"}) on
 *      its hardware wallet;
 *   2. POST /v1/transfer with that signature returns Circle's attestation and signature;
 *   3. the treasury sends gatewayMint(attestation, signature) to the GatewayMinter on that chain and
 *      receives the USDC.
 *
 * Circle's fee (the source chain's gas fee; a same-chain withdrawal carries no transfer fee) is
 * taken from the Gateway balance on top of the amount, up to the intent's maxFee. This module is
 * pure: it builds what is signed, checks it, and encodes the mint. The local page and its server
 * (withdraw-server.ts) do the rest. No key is ever held here: the wallet signs.
 */

export type GatewayEnvironment = "mainnet" | "testnet";

export interface GatewayChain {
  key: string;
  name: string;
  chainId: number;
  /** Circle's domain id for the chain (Gateway contract addresses page). */
  domain: number;
  usdc: Address;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export interface GatewayEnvironmentConfig {
  api: string;
  wallet: Address;
  minter: Address;
  chains: readonly GatewayChain[];
}

const ETH = { name: "Ether", symbol: "ETH", decimals: 18 };
// Arc's gas token is USDC itself: 18 decimals natively, 6 through its ERC-20 interface.
const ARC_GAS = { name: "USDC", symbol: "USDC", decimals: 18 };
const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";

export const GATEWAY: Record<GatewayEnvironment, GatewayEnvironmentConfig> = {
  mainnet: {
    api: "https://gateway-api.circle.com",
    wallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    minter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
    chains: [
      { key: "base", name: "Base", chainId: 8453, domain: 6, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", rpcUrl: "https://mainnet.base.org", explorer: "https://basescan.org", nativeCurrency: ETH },
      { key: "arc", name: "Arc", chainId: 5042, domain: 26, usdc: ARC_USDC, rpcUrl: "https://rpc.mainnet.arc.io", explorer: "https://explorer.arc.io", nativeCurrency: ARC_GAS },
    ],
  },
  testnet: {
    api: "https://gateway-api-testnet.circle.com",
    wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    chains: [
      { key: "base-sepolia", name: "Base Sepolia", chainId: 84532, domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", nativeCurrency: ETH },
      { key: "arc-testnet", name: "Arc Testnet", chainId: 5042002, domain: 26, usdc: ARC_USDC, rpcUrl: "https://rpc.testnet.arc.io", explorer: "https://explorer.testnet.arc.io", nativeCurrency: ARC_GAS },
    ],
  },
};

export function chainFor(env: GatewayEnvironment, key: string): GatewayChain {
  const chain = GATEWAY[env].chains.find((c) => c.key === key);
  if (!chain) throw new Error(`no ${JSON.stringify(key)} chain on ${env}; expected one of ${GATEWAY[env].chains.map((c) => c.key).join(", ")}`);
  return chain;
}

/** The burn intent's EIP-712 types, as Circle publishes them; EIP712Domain included for wallets. */
export const BURN_INTENT_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;

export interface BurnIntentMessage {
  /** Source-chain block after which Circle will not act on the signature. */
  maxBlockHeight: string;
  maxFee: string;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: string;
    salt: Hex;
    hookData: Hex;
  };
}

/** Exactly what the wallet is asked to sign (eth_signTypedData_v4) and Circle is sent. */
export interface BurnIntentTypedData {
  types: typeof BURN_INTENT_TYPES;
  domain: { name: string; version: string };
  primaryType: "BurnIntent";
  message: BurnIntentMessage;
}

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
/** A block height this large never comes: a signature carrying it would stay usable forever. */
const MAX_SANE_BLOCK_HEIGHT = 2n ** 64n;

function bytes32(address: string): Hex {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, "0")}`;
}

const USDC_AMOUNT = /^(0|[1-9]\d*)(\.\d{1,6})?$/;

/** "0.5" -> 500000n. Six decimals, string arithmetic only. */
export function parseUsdc(amount: string): bigint {
  if (!USDC_AMOUNT.test(amount)) throw new Error(`not a USDC amount (up to 6 decimals): ${JSON.stringify(amount)}`);
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** 3850n -> "0.003850". */
export function formatUsdc(atomic: bigint): string {
  const sign = atomic < 0n ? "-" : "";
  const s = (atomic < 0n ? -atomic : atomic).toString().padStart(7, "0");
  return `${sign}${s.slice(0, -6)}.${s.slice(-6)}`;
}

export interface WithdrawalParams {
  env: GatewayEnvironment;
  chain: string;
  treasury: string;
  value: bigint;
  maxFee: bigint;
  maxBlockHeight: bigint;
  salt: Hex;
}

/** A same-chain withdrawal from the treasury's Gateway balance to the treasury's own wallet. */
export function buildWithdrawal(p: WithdrawalParams): BurnIntentTypedData {
  const env = GATEWAY[p.env];
  const chain = chainFor(p.env, p.chain);
  const treasury = bytes32(p.treasury);
  return {
    types: BURN_INTENT_TYPES,
    domain: { name: "GatewayWallet", version: "1" },
    primaryType: "BurnIntent",
    message: {
      maxBlockHeight: p.maxBlockHeight.toString(),
      maxFee: p.maxFee.toString(),
      spec: {
        version: 1,
        sourceDomain: chain.domain,
        destinationDomain: chain.domain,
        sourceContract: bytes32(env.wallet),
        destinationContract: bytes32(env.minter),
        sourceToken: bytes32(chain.usdc),
        destinationToken: bytes32(chain.usdc),
        sourceDepositor: treasury,
        destinationRecipient: treasury,
        sourceSigner: treasury,
        destinationCaller: bytes32(ZERO_ADDRESS),
        value: p.value.toString(),
        salt: p.salt,
        hookData: "0x",
      },
    },
  };
}

function uint(name: string, s: unknown): bigint {
  if (typeof s !== "string" || !/^(0|[1-9]\d*)$/.test(s)) throw new Error(`unsafe burn intent: ${name} is not a whole number`);
  return BigInt(s);
}

/**
 * Throws unless `t` is exactly the withdrawal this page builds: same chain both ends, the treasury
 * as depositor, signer and recipient, Circle's contracts and USDC, no mint caller, no hook, and a
 * signature that expires. Run on what the page shows, and again on what is sent to Circle.
 */
export function assertSafeBurnIntent(
  t: BurnIntentTypedData,
  ctx: { env: GatewayEnvironment; chain: string; treasury: string },
): void {
  const m = t.message;
  const maxBlockHeight = uint("maxBlockHeight", m?.maxBlockHeight);
  if (maxBlockHeight >= MAX_SANE_BLOCK_HEIGHT) throw new Error("unsafe burn intent: maxBlockHeight never expires");
  if (typeof m.spec?.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.spec.salt)) throw new Error("unsafe burn intent: salt is not 32 bytes");
  const expected = buildWithdrawal({
    ...ctx,
    value: uint("value", m.spec.value),
    maxFee: uint("maxFee", m.maxFee),
    maxBlockHeight,
    salt: m.spec.salt,
  });
  const differs: string[] = [];
  if (JSON.stringify(t.types) !== JSON.stringify(expected.types)) differs.push("types");
  if (JSON.stringify(t.domain) !== JSON.stringify(expected.domain)) differs.push("domain");
  if (t.primaryType !== expected.primaryType) differs.push("primaryType");
  for (const [k, v] of Object.entries(expected.message.spec)) {
    const got = (m.spec as Record<string, unknown>)[k];
    if (typeof v === "string" ? String(got).toLowerCase() !== v.toLowerCase() : got !== v) differs.push(`spec.${k}`);
  }
  if (Object.keys(m.spec).length !== Object.keys(expected.message.spec).length) differs.push("spec (extra fields)");
  if (differs.length > 0) throw new Error(`unsafe burn intent: ${differs.join(", ")} not as expected for a same-chain withdrawal to the treasury`);
}

/** Why a withdrawal of `value` cannot go ahead (empty when it can). Amounts in atomic USDC. */
export function withdrawalRefusals({ value, maxFee, balance }: { value: bigint; maxFee: bigint; balance: bigint }): string[] {
  if (value <= 0n) return ["Enter an amount above zero."];
  const refusals: string[] = [];
  if (maxFee >= value)
    refusals.push(`Circle's fee on this withdrawal is up to ${formatUsdc(maxFee)} USDC, as much as the amount itself: withdraw more at once.`);
  if (value + maxFee > balance) {
    const most = balance > maxFee ? balance - maxFee : 0n;
    refusals.push(
      `The Gateway balance is ${formatUsdc(balance)} USDC and Circle's fee is up to ${formatUsdc(maxFee)} USDC on top, so at most ${formatUsdc(most)} USDC can be withdrawn.`,
    );
  }
  return refusals;
}

/** The address that signed `t`. */
export async function recoverBurnIntentSigner(t: BurnIntentTypedData, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: t.domain,
    types: { TransferSpec: t.types.TransferSpec, BurnIntent: t.types.BurnIntent },
    primaryType: "BurnIntent",
    message: {
      maxBlockHeight: BigInt(t.message.maxBlockHeight),
      maxFee: BigInt(t.message.maxFee),
      spec: { ...t.message.spec, value: BigInt(t.message.spec.value) },
    },
    signature,
  });
}

/**
 * Why the treasury must not withdraw on a chain, from its code there (eth_getCode), or undefined for
 * a plain account. On 2026-11-27 MetaMask turned the treasury into an EIP-7702 smart account on Base
 * Sepolia during a mint and had its own relayer send it; the owner's rule is that withdrawals come
 * from a plain account and the treasury sends its own mint.
 */
export function treasuryCodeProblem(code: string, chainName: string): string | undefined {
  if (code === "0x" || code === "") return undefined;
  const delegate = /^0xef0100([0-9a-fA-F]{40})$/.exec(code)?.[1];
  return delegate
    ? `Stop: on ${chainName} the treasury is not a plain account. It delegates to 0x${delegate.toLowerCase()} (an EIP-7702 ` +
        `smart account, which a wallet's "smart account" setting creates). Switch it back to a standard account in the ` +
        `wallet, then prepare the withdrawal again.`
    : `Stop: on ${chainName} the treasury address holds contract code, so it is not a plain account. Do not withdraw there until that is understood.`;
}

/** A transaction and its receipt as JSON-RPC returns them (only the fields checked here). */
export interface ChainTransaction {
  type?: string;
  from?: string;
  to?: string | null;
  input?: string;
  value?: string;
  authorizationList?: unknown[];
}
export interface ChainReceipt {
  status?: string;
  logs?: { address: string; topics: string[]; data: string }[];
}

const ERC20_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const same = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/**
 * Everything about a mined mint that makes it other than the plain transaction the treasury was meant
 * to send: from the treasury, to the GatewayMinter, with exactly the prepared data, no value, not a
 * type-4 (EIP-7702) transaction, succeeded, and minted the amount to the treasury. Empty when plain.
 */
export function plainMintProblems(
  tx: ChainTransaction | null | undefined,
  receipt: ChainReceipt | null | undefined,
  expected: { treasury: string; minter: string; data: string; usdc: string; value: bigint },
): string[] {
  if (!tx || !receipt) return ["The transaction was not found on the chain."];
  const problems: string[] = [];
  if (receipt.status !== "0x1") problems.push("It failed on chain (reverted).");
  if (tx.type === "0x4" || (tx.authorizationList?.length ?? 0) > 0)
    problems.push("It was a type-4 (EIP-7702) transaction: it carried an authorisation that changes what the treasury account is.");
  if (!same(tx.from, expected.treasury)) problems.push(`It was sent by ${tx.from}, not by the treasury: a relayed call.`);
  if (!same(tx.to, expected.minter)) problems.push(`It went to ${tx.to}, not to the GatewayMinter ${expected.minter}.`);
  if (!same(tx.input, expected.data)) problems.push("Its data is not the mint this page prepared.");
  if (tx.value !== undefined && BigInt(tx.value) !== 0n) problems.push("It carried a value.");
  if (receipt.status === "0x1") {
    const minted = (receipt.logs ?? []).some(
      (l) =>
        same(l.address, expected.usdc) &&
        same(l.topics[0], ERC20_TRANSFER) &&
        BigInt(l.topics[1] ?? "0x1") === 0n &&
        BigInt(l.topics[2] ?? "0x0") === BigInt(expected.treasury) &&
        BigInt(l.data) === expected.value,
    );
    if (!minted) problems.push(`No mint of ${formatUsdc(expected.value)} USDC to the treasury appears in its logs.`);
  }
  return problems;
}

const GATEWAY_MINTER_ABI = parseAbi(["function gatewayMint(bytes attestationPayload, bytes signature)"]);

/** Calldata for GatewayMinter.gatewayMint, from Circle's /v1/transfer answer. */
export function gatewayMintCalldata(attestation: string, signature: string): Hex {
  if (!isHex(attestation) || !isHex(signature)) throw new Error("Circle's attestation and signature must be hex");
  return encodeFunctionData({ abi: GATEWAY_MINTER_ABI, functionName: "gatewayMint", args: [attestation, signature] });
}
