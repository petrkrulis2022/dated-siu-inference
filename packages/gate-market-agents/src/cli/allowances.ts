/**
 * USDC allowances to a deployment's WorkClaim — what a new deployment needs before anything can mint.
 *
 * **Why this exists.** `WorkClaim.mint` pulls the minter's USDC with `transferFrom`, so every wallet
 * that mints — the two buyers, and the operator's external buyer and drain — must have approved the
 * WorkClaim. A NEW WorkClaim starts with no allowance from anyone, and nothing set them: the fifth
 * trio's were one-off hand approvals that cannot carry over to a new address. The first debug run on
 * the sixth trio found out by failing: ORCHESTRATOR's USDC payment worked (the escrow's allowance is
 * set per call), then the operator's scheduled mint and the drain both reverted `transfer amount
 * exceeds allowance`, aborting the run after a window had been paid for.
 *
 * Two parts, deliberately: `approveForSpender` fixes it (dry run by default, simulate before send,
 * wait for the write's effect — the same discipline as `bond-lots`), and `assertAllowancesForRun`
 * is what the runner calls at launch so the next new deployment is refused at the door, naming the
 * command, instead of discovered mid-run.
 *
 * Chain-agnostic (no `chain` on the clients), so the same code runs on the devnet and on Base Sepolia.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { repoRoot } from "../chain/deployment.js";
import { untilVisible } from "../chain/until-visible.js";

/** What a full run needs at LEAST: three windows of payments by each buyer, and the operator's
 *  external buyer plus drain. Orders of magnitude over a run's real spend (a few cents), so a
 *  holder that passes cannot run dry mid-run, and well below what the tool approves. */
export const RUN_MINIMUM_ALLOWANCE_MINOR_UNITS = { agent: 200_000n, operator: 100_000n } as const;

export interface AllowanceRow {
  label: string;
  current: bigint;
  minimum: bigint;
}

export function allowanceShortfalls<T extends AllowanceRow>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.current < r.minimum);
}

/** Throws, naming each holder that cannot cover a run and the command that fixes it. */
export function assertAllowancesForRun(rows: readonly AllowanceRow[], fixCommand: string): void {
  const short = allowanceShortfalls(rows);
  if (short.length === 0) return;
  throw new Error(
    "this deployment's WorkClaim has not been approved to pull USDC from: " +
      short.map((r) => `${r.label} (allowance ${r.current}, needs at least ${r.minimum})`).join("; ") +
      `. Nothing can mint without it, and the run would abort after paying for a window. Fix: ${fixCommand}`,
  );
}

export interface AllowanceTarget {
  label: string;
  address: Hex;
  /** Below this, the holder is brought up to `target`. At or above it, it is left alone. */
  minimum: bigint;
  target: bigint;
}

export interface ApprovalResult {
  label: string;
  status: "sufficient" | "would_approve" | "approved";
  current: string;
  txHash?: string;
}

export async function readAllowances(input: {
  usdc: Hex;
  spender: Hex;
  owners: readonly { label: string; address: Hex; minimum: bigint }[];
  rpcUrl: string;
}): Promise<(AllowanceRow & { owner: Hex })[]> {
  const client = createPublicClient({ transport: http(input.rpcUrl) });
  return Promise.all(
    input.owners.map(async (o) => ({
      label: o.label,
      owner: o.address,
      minimum: o.minimum,
      current: await client.readContract({
        address: input.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [o.address, input.spender],
      }),
    })),
  );
}

export async function approveForSpender(input: {
  targets: readonly AllowanceTarget[];
  usdc: Hex;
  spender: Hex;
  rpcUrl: string;
  keyFor: (label: string) => Hex;
  /** Default true: nothing is sent unless the caller says so. */
  dryRun?: boolean;
  pollMs?: number;
  log?: (line: string) => void;
}): Promise<ApprovalResult[]> {
  const log = input.log ?? (() => {});
  const dryRun = input.dryRun ?? true;
  const pollMs = input.pollMs ?? 2_000;
  const publicClient = createPublicClient({ transport: http(input.rpcUrl) });
  const readAllowance = (owner: Hex) =>
    publicClient.readContract({ address: input.usdc, abi: erc20Abi, functionName: "allowance", args: [owner, input.spender] });

  // Every key is checked against its address before anything is sent.
  for (const t of input.targets) {
    const account = privateKeyToAccount(input.keyFor(t.label));
    if (account.address.toLowerCase() !== t.address.toLowerCase()) {
      throw new Error(`the key supplied for ${t.label} controls ${account.address}, but the target names ${t.address}`);
    }
  }

  const results: ApprovalResult[] = [];
  for (const t of input.targets) {
    const current = await readAllowance(t.address);
    if (current >= t.minimum) {
      results.push({ label: t.label, status: "sufficient", current: current.toString() });
      log(`${t.label}: allowance ${current} is at or above ${t.minimum}; left alone`);
      continue;
    }
    const account = privateKeyToAccount(input.keyFor(t.label));
    const sim = await publicClient.simulateContract({
      account,
      address: input.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [input.spender, t.target],
    });
    if (dryRun) {
      results.push({ label: t.label, status: "would_approve", current: current.toString() });
      log(`${t.label}: allowance ${current} -> would approve ${t.target} (simulated ok)`);
      continue;
    }
    const wallet = createWalletClient({ account, transport: http(input.rpcUrl) });
    const txHash = await wallet.writeContract({ ...sim.request, chain: undefined });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    // A receipt is not the effect: wait until the allowance itself reads as asked.
    await untilVisible(() => readAllowance(t.address), (a) => a >= t.target, `${t.label}'s approval`, pollMs);
    results.push({ label: t.label, status: "approved", current: current.toString(), txHash });
    log(`${t.label}: approved ${t.target}, ${txHash}`);
  }
  return results;
}

/** The roster's mint-capable holders: the two buyers and the operator. Seats that never buy are
 *  not approved — an allowance a wallet does not need is authority it should not have. */
export function rosterTargets(env: NodeJS.ProcessEnv): AllowanceTarget[] {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set.`);
    return v;
  };
  const operatorKey = asPrefixedKey(need("DEPLOYER_PRIVATE_KEY"));
  return [
    { label: "ORCHESTRATOR", address: need("ORCHESTRATOR_ADDRESS") as Hex, minimum: 500_000n, target: 1_000_000n },
    { label: "WORKER-CODE", address: need("WORKER_CODE_ADDRESS") as Hex, minimum: 500_000n, target: 1_000_000n },
    { label: "operator", address: privateKeyToAccount(operatorKey).address, minimum: 1_000_000n, target: 2_000_000n },
  ];
}

/**
 * The currency lab's holders. All four traders can pay by minting a claim (`pay_with_claim`), so all four
 * need the WorkClaim approved — the gate configuration's list stops at the two buyers because nobody else
 * mints there. TRADER-3 and TRADER-4 stand on WORKER-EXTRACT's and ISSUER-A's wallets (plan D4).
 */
export function labRosterTargets(env: NodeJS.ProcessEnv): AllowanceTarget[] {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set.`);
    return v;
  };
  const operatorKey = asPrefixedKey(need("DEPLOYER_PRIVATE_KEY"));
  const trader = (label: string, variable: string): AllowanceTarget => ({
    label,
    address: need(variable) as Hex,
    minimum: 500_000n,
    target: 1_000_000n,
  });
  return [
    trader("ORCHESTRATOR", "ORCHESTRATOR_ADDRESS"),
    trader("WORKER-CODE", "WORKER_CODE_ADDRESS"),
    trader("WORKER-EXTRACT", "WORKER_EXTRACT_ADDRESS"),
    trader("ISSUER-A", "ISSUER_A_ADDRESS"),
    { label: "operator", address: privateKeyToAccount(operatorKey).address, minimum: 1_000_000n, target: 2_000_000n },
  ];
}

/** `.env` stores private keys without the 0x prefix; viem wants it. */
function asPrefixedKey(key: string): Hex {
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

export function rosterKey(env: NodeJS.ProcessEnv, label: string): Hex {
  const name = label === "operator" ? "DEPLOYER_PRIVATE_KEY" : `${label.replace("-", "_")}_PRIVATE_KEY`;
  const key = env[name];
  if (!key) throw new Error(`${name} is not set.`);
  return asPrefixedKey(key);
}

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--deployment");
  const file = at === -1 ? undefined : argv[at + 1];
  if (!file || file.startsWith("--")) {
    // No default: approving the wrong deployment's WorkClaim is how authority lands in the wrong place.
    throw new Error("--deployment <path> is required (relative to the repo root).");
  }
  const execute = argv.includes("--execute");
  const record = JSON.parse(readFileSync(path.join(repoRoot(), file), "utf-8"));
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "";
  if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL is not set.");
  console.log(
    `${execute ? "EXECUTING" : "DRY RUN (nothing is sent; pass --execute to approve)"} — USDC allowances to ` +
      `${record.workClaim.address} (the WorkClaim in ${file}):`,
  );
  approveForSpender({
    targets: argv.includes("--lab") ? labRosterTargets(process.env) : rosterTargets(process.env),
    usdc: record.usdc.address as Hex,
    spender: record.workClaim.address as Hex,
    rpcUrl,
    dryRun: !execute,
    keyFor: (label) => rosterKey(process.env, label),
    log: (line) => console.log(`  ${line}`),
  }).then(
    (results) => console.log(JSON.stringify(results, null, 2)),
    (err) => {
      console.error(`approve-roster refused: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) main();
