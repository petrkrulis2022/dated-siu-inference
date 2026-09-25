import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToBytes,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { assertFoundryToolchainAvailable } from "./capability.js";
import { ANVIL_DEFAULT_PRIVATE_KEY, startAnvil, type LocalDevnet } from "./anvil.js";
import { CAPACITY_BOND_PROVISIONING_ABI, MOCK_USDC_ABI } from "./abi.js";
import { AGENT_IDS, type AgentId } from "../identity/resolve.js";
import type { GateMarketDeployment } from "../chain/deployment.js";

const execFileAsync = promisify(execFile);

/** `keccak256(bytes("code"))`/`keccak256(bytes("extract"))` — matches
 * `keccak256("code")`/`keccak256("extract")` in the Solidity test suite exactly (Solidity's
 * `keccak256("code")` hashes the UTF-8 bytes of the string literal, same as
 * `keccak256(stringToBytes("code"))` here). */
export const CLASS_CODE: Hex = keccak256(stringToBytes("code"));
export const CLASS_EXTRACT: Hex = keccak256(stringToBytes("extract"));

function contractsDir(): string {
  // packages/gate-market-agents/src/devnet/deploy.ts -> packages/contracts is a sibling package.
  return path.resolve(fileURLToPath(import.meta.url), "../../../../contracts");
}

async function runForgeBuild(): Promise<void> {
  await execFileAsync("forge", ["build"], { cwd: contractsDir() });
}

interface RawDeployment {
  mockUsdc: Hex;
  capacityBond: Hex;
  claimRouter: Hex;
  workClaim: Hex;
}

async function runForgeScriptDeploy(rpcUrl: string, publisherAddress: Hex): Promise<RawDeployment> {
  await execFileAsync(
    "forge",
    [
      "script",
      "script/DeployGateMarketLocal.s.sol",
      "--rpc-url",
      rpcUrl,
      "--broadcast",
      "--private-key",
      ANVIL_DEFAULT_PRIVATE_KEY,
    ],
    { cwd: contractsDir(), env: { ...process.env, TOUCHSTONE_PUBLISHER_ADDRESS: publisherAddress } },
  );

  const broadcastPath = path.join(
    contractsDir(),
    "broadcast",
    "DeployGateMarketLocal.s.sol",
    "31337",
    "run-latest.json",
  );
  const raw = JSON.parse(await readFile(broadcastPath, "utf-8")) as {
    transactions: Array<{ contractName: string; contractAddress: Hex }>;
  };

  const addressFor = (name: string): Hex => {
    const tx = raw.transactions.find((t) => t.contractName === name);
    if (!tx) throw new Error(`DeployGateMarketLocal broadcast: no "${name}" deployment found.`);
    return tx.contractAddress;
  };

  return {
    mockUsdc: addressFor("MockUSDC"),
    capacityBond: addressFor("CapacityBond"),
    claimRouter: addressFor("ClaimRouter"),
    workClaim: addressFor("WorkClaim"),
  };
}

export interface ProvisionedAgent {
  agentId: AgentId;
  privateKeyHex: Hex;
  address: Hex;
}

const STARTING_ETH = 10n ** 18n; // 1 ETH — gas only, never spent on anything else here
const STARTING_USDC = 1_000_000_000n; // 1,000 USDC (6 decimals) — plenty for dry-loop mint/pay amounts

/** `issuanceLimit = committedCapacityHours * measuredRateMilliSiuPerHour * 0.5` (CapacityBond's
 * `ISSUANCE_RATIO_BPS`) — `bondedUsdc` plays no part in it at all (confirmed by reading
 * `issuanceLimit()` directly; a real mistake this file's own first draft made, sizing lots by
 * `bondedUsdc` and getting identical headroom for both issuers). ISSUER-B's `code`
 * `committedCapacityHours` is deliberately small — this package's WP-5 plan's
 * headroom-exhaustion scenario needs it exhausted after a small number of mints. These hour/rate
 * figures are illustrative devnet fixture values, not derived from any real print or probe
 * workload measurement — this is a dry loop, not a rate-measurement exercise (that's spec phase
 * P2, out of scope here). `bondedUsdc` is fixed and generous for both — it only needs to be
 * nonzero and large enough to cover a real default payout, not sized to the issuance limit. */
const FIXED_MEASURED_RATE_MILLI_SIU_PER_HOUR = 100n;
const FIXED_BONDED_USDC = STARTING_USDC / 2n; // half of each issuer's starting balance

const LOT_HOURS: Record<AgentId, { code: bigint; extract: bigint } | null> = {
  "ISSUER-A": { code: 1000n, extract: 1000n },
  "ISSUER-B": { code: 20n, extract: 1000n }, // small `code` capacity — headroom exhausts fast
  ORCHESTRATOR: null,
  "WORKER-CODE": null,
  "WORKER-EXTRACT": null,
  HEDGER: null,
};

export interface DevnetHandle {
  rpcUrl: string;
  deployment: GateMarketDeployment;
  agents: Record<AgentId, ProvisionedAgent>;
  /** The private key `WorkClaim`'s immutable `publisher` was deployed with on this devnet —
   * freshly generated per run, same as every agent's own key. A dry-loop scenario signs a real
   * rate attestation with this (chain/rate-attestation.ts's `signRateAttestation`) before any
   * `mint_claim`/`settle_window_close` call that will actually Default. */
  publisherPrivateKeyHex: Hex;
  stop: () => Promise<void>;
}

/**
 * Full WP-5 devnet setup: real anvil, real (unmodified) contract bytecode, six freshly-keyed
 * roster agents funded with ETH (gas) and USDC, with ISSUER-A/ISSUER-B each bonding a lot in
 * both classes. Everything downstream (the dry-loop scenarios) drives this exclusively through
 * `Runner.callTool` — this function's job stops at "the devnet is ready to be used," not at
 * exercising any of the actual economic loop.
 */
export async function setupDevnet(): Promise<DevnetHandle> {
  await assertFoundryToolchainAvailable();
  await runForgeBuild();

  const devnet: LocalDevnet = await startAnvil();
  try {
    return await provisionDevnet(devnet);
  } catch (err) {
    // A failure anywhere in provisioning (a bad forge script run, a reverted funding tx) must
    // not leak the anvil child process — found live: a crashed concurrent run (the same race
    // fileParallelism: false above fixes) left one running after its test process exited.
    await devnet.stop();
    throw err;
  }
}

async function provisionDevnet(devnet: LocalDevnet): Promise<DevnetHandle> {
  // Freshly generated per run, same as every agent's own key below — its matching address is
  // WorkClaim's immutable `publisher`, deployed by DeployGateMarketLocal.s.sol from the
  // TOUCHSTONE_PUBLISHER_ADDRESS env var runForgeScriptDeploy sets, not a fixed local constant,
  // so a dry-loop scenario holding only this handle can actually sign valid attestations.
  const publisherPrivateKeyHex = generatePrivateKey();
  const publisherAddress = privateKeyToAccount(publisherPrivateKeyHex).address;
  const raw = await runForgeScriptDeploy(devnet.rpcUrl, publisherAddress);

  const deployerAccount = privateKeyToAccount(ANVIL_DEFAULT_PRIVATE_KEY);
  const publicClient = createPublicClient({ transport: http(devnet.rpcUrl) });
  const deployerWallet = createWalletClient({
    account: deployerAccount,
    transport: http(devnet.rpcUrl),
  });

  const agents = {} as Record<AgentId, ProvisionedAgent>;
  for (const agentId of AGENT_IDS) {
    const privateKeyHex = generatePrivateKey();
    const address = privateKeyToAccount(privateKeyHex).address;
    agents[agentId] = { agentId, privateKeyHex, address };

    const ethTx = await deployerWallet.sendTransaction({
      account: deployerAccount,
      chain: undefined,
      to: address,
      value: STARTING_ETH,
    });
    await publicClient.waitForTransactionReceipt({ hash: ethTx });

    const mintTx = await deployerWallet.writeContract({
      account: deployerAccount,
      chain: undefined,
      address: raw.mockUsdc,
      abi: MOCK_USDC_ABI,
      functionName: "mint",
      args: [address, STARTING_USDC],
    });
    await publicClient.waitForTransactionReceipt({ hash: mintTx });

    // Every agent can act as a buyer (`WorkClaim.mint` pulls USDC via safeTransferFrom) — approve
    // up front for all six, matching WorkClaim.t.sol's own setUp() pattern, rather than only the
    // agents this run happens to use as a buyer.
    const agentAccount = privateKeyToAccount(privateKeyHex);
    const agentWallet = createWalletClient({
      account: agentAccount,
      transport: http(devnet.rpcUrl),
    });
    const approveWorkClaimTx = await agentWallet.writeContract({
      account: agentAccount,
      chain: undefined,
      address: raw.mockUsdc,
      abi: MOCK_USDC_ABI,
      functionName: "approve",
      args: [raw.workClaim, STARTING_USDC],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveWorkClaimTx });
  }

  for (const agentId of AGENT_IDS) {
    const hours = LOT_HOURS[agentId];
    if (!hours) continue;

    const agent = agents[agentId];
    const issuerAccount = privateKeyToAccount(agent.privateKeyHex);
    const issuerWallet = createWalletClient({
      account: issuerAccount,
      transport: http(devnet.rpcUrl),
    });

    const approveTx = await issuerWallet.writeContract({
      account: issuerAccount,
      chain: undefined,
      address: raw.mockUsdc,
      abi: MOCK_USDC_ABI,
      functionName: "approve",
      args: [raw.capacityBond, FIXED_BONDED_USDC * 2n],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    for (const [classId, committedCapacityHours] of [
      [CLASS_CODE, hours.code],
      [CLASS_EXTRACT, hours.extract],
    ] as const) {
      const createLotTx = await issuerWallet.writeContract({
        account: issuerAccount,
        chain: undefined,
        address: raw.capacityBond,
        abi: CAPACITY_BOND_PROVISIONING_ABI,
        functionName: "createLot",
        args: [
          classId,
          committedCapacityHours,
          FIXED_MEASURED_RATE_MILLI_SIU_PER_HOUR,
          FIXED_BONDED_USDC,
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash: createLotTx });
    }
  }

  const deployment: GateMarketDeployment = {
    network: { name: "anvil-local", chainId: 31337 },
    usdc: { address: raw.mockUsdc },
    capacityBond: { address: raw.capacityBond },
    claimRouter: { address: raw.claimRouter },
    workClaim: { address: raw.workClaim },
  };

  return { rpcUrl: devnet.rpcUrl, deployment, agents, publisherPrivateKeyHex, stop: devnet.stop };
}
