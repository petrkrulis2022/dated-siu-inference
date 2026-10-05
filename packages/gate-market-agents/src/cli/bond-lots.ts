/**
 * Bonds the capacity lots a deployment record declares, in the order its topology declares them.
 *
 * **Why this exists.** `createLot` appears nowhere else outside the devnet deployer and a local
 * Foundry script; the fifth trio's live lots were bonded by one-off scripts nobody can re-run.
 * The single-issuer instrument makes that a real gap, because registration order IS routing
 * priority (`CapacityBond._issuersForClass` is append-only and `ClaimRouter.route` is first-fit
 * over it), so the order lots are bonded in is part of what the instrument measures. It has to be
 * declared in the record and executed by something that checks it, not inferred from whichever
 * transactions happened to land first.
 *
 * **What it never does.** It does not move a lot that exists: `createLot` reverts `LotExists` and
 * there is no removal, so a lot already on chain with different figures, or a registration list
 * already in the wrong order, is reported and left alone — those are facts about a deployment that
 * cannot be fixed from here, and pretending otherwise would hide that the record and the chain
 * disagree. It does not default to broadcasting: without `--execute` it reads, checks and
 * simulates, and sends nothing.
 *
 * Chain-agnostic on purpose (no `chain` on the clients), so the same code is exercised on the
 * local real-bytecode devnet and run on Base Sepolia — and could run on Arc — unchanged.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { repoRoot } from "../chain/deployment.js";
import { instrumentOf } from "./instrument.js";

/** `CapacityBond.ISSUANCE_RATIO_BPS` — read from the contract's own constant, not re-derived. */
const ISSUANCE_RATIO_BPS = 5_000n;
const BPS = 10_000n;

const CAPACITY_BOND_LOT_ABI = parseAbi([
  "function lots(address issuer, bytes32 classId) view returns (uint256 committedCapacityHours, uint256 measuredRateMilliSiuPerHour, uint256 bondedUsdc, uint256 outstanding, bool exists)",
  "function createLot(bytes32 classId, uint256 committedCapacityHours, uint256 measuredRateMilliSiuPerHour, uint256 bondedUsdc)",
  "function issuersForClass(bytes32 classId) view returns (address[])",
]);

export type ClassLabel = "code" | "extract";

export interface LotPlanEntry {
  issuer: string;
  address: Hex;
  classLabel: ClassLabel;
  classId: Hex;
  committedCapacityHours: bigint;
  measuredRateMilliSiuPerHour: bigint;
  bondedUsdc: bigint;
  /** hours × rate × issuance ratio — what the lot will allow to be minted against it. */
  issuanceLimitMilliSiu: bigint;
}

interface IssuerLotRecord {
  address: string;
  committedCapacityHours: number | string;
  measuredRateMilliSiuPerHour: number | string;
  bondedUsdcPerClass: number | string;
  issuanceLimitPerClass?: number | string;
}

/**
 * The lots to create, in creation order, from a deployment record.
 *
 * Pure. Order comes from `topology.lotCreationOrder` — validated by the same `instrumentOf` the
 * runner uses, so the tool and the run cannot disagree about what the record says. A record with
 * no topology has no declared order and is refused rather than given one: inventing the order is
 * exactly the inference this tool exists to replace.
 *
 * The record's own `issuanceLimitPerClass`, where present, is checked against the arithmetic. A
 * record whose figures disagree with its own inputs describes a market nobody deployed.
 */
export function planLots(record: unknown): LotPlanEntry[] {
  const spec = instrumentOf(record);
  if (spec.topology === undefined) {
    throw new Error(
      "this deployment record declares no topology.lotCreationOrder, so there is no declared " +
        "order to bond in. Registration order is routing priority; it is not inferred.",
    );
  }
  const lots = (record as { capacityLots?: Record<string, unknown> }).capacityLots;
  const classIds = lots?.classIds as Record<ClassLabel, Hex> | undefined;
  if (lots === undefined || classIds?.code === undefined || classIds?.extract === undefined) {
    throw new Error("deployment record: capacityLots.classIds.{code,extract} are required.");
  }

  const plan: LotPlanEntry[] = [];
  for (const issuer of spec.topology.lotCreationOrder) {
    const entry = lots[issuer] as IssuerLotRecord | undefined;
    if (entry === undefined) {
      throw new Error(`deployment record: capacityLots has no entry for ${issuer}.`);
    }
    const hours = BigInt(entry.committedCapacityHours);
    const rate = BigInt(entry.measuredRateMilliSiuPerHour);
    const bond = BigInt(entry.bondedUsdcPerClass);
    if (hours <= 0n || rate <= 0n || bond <= 0n) {
      throw new Error(`deployment record: ${issuer} has a zero lot figure; createLot refuses zeros.`);
    }
    const limit = (hours * rate * ISSUANCE_RATIO_BPS) / BPS;
    if (entry.issuanceLimitPerClass !== undefined && BigInt(entry.issuanceLimitPerClass) !== limit) {
      throw new Error(
        `deployment record: ${issuer} states issuanceLimitPerClass ${entry.issuanceLimitPerClass} ` +
          `but ${hours} h × ${rate} mSIU/h × 0.5 is ${limit}.`,
      );
    }
    for (const classLabel of ["code", "extract"] as const) {
      plan.push({
        issuer,
        address: entry.address as Hex,
        classLabel,
        classId: classIds[classLabel],
        committedCapacityHours: hours,
        measuredRateMilliSiuPerHour: rate,
        bondedUsdc: bond,
        issuanceLimitMilliSiu: limit,
      });
    }
  }
  return plan;
}

/**
 * Does the chain's registration list for one class agree with the declared order?
 *
 * Only issuers the topology names are compared, in the order the chain lists them; an issuer the
 * record does not name sitting in the list is a failure, because first-fit would route to it.
 */
export function verifyRegistrationOrder(
  onChain: readonly string[],
  declaredOrder: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const have = onChain.map((a) => a.toLowerCase());
  const want = declaredOrder.map((a) => a.toLowerCase());
  const stranger = have.find((a) => !want.includes(a));
  if (stranger !== undefined) {
    return { ok: false, reason: `${stranger} is registered but the record does not declare it` };
  }
  // A prefix of the declared order is a legitimate half-finished bonding; anything else is not.
  for (let i = 0; i < have.length; i++) {
    if (have[i] !== want[i]) {
      return {
        ok: false,
        reason: `registration position ${i + 1} is ${have[i]}, the record declares ${want[i]} — first-fit would route to the wrong issuer, and the list is append-only`,
      };
    }
  }
  return { ok: true };
}

export type BondStatus = "already_bonded" | "would_create" | "created";

export interface BondResult {
  issuer: string;
  classLabel: ClassLabel;
  status: BondStatus;
  approveTx?: string;
  createLotTx?: string;
}

export interface BondInput {
  plan: readonly LotPlanEntry[];
  capacityBond: Hex;
  usdc: Hex;
  rpcUrl: string;
  /** Resolved by the caller from the environment; checked here against the plan's address. */
  keyFor: (issuer: string) => Hex;
  /** Default true. Nothing is sent unless the caller says so. */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Delay between visibility polls. Default 2000 ms; tests shorten it. */
  pollMs?: number;
}

/**
 * Polls until `ok(value)` holds, then returns the value; throws if it never does.
 *
 * **Why a receipt is not enough.** A load-balanced public endpoint can serve a pre-write view AFTER
 * a transaction's receipt confirms (the sixth documented instance of that pattern, found live: the
 * `createLot` simulation ran straight after the approval's receipt and saw no allowance). So after
 * every write the tool waits for the write's own EFFECT to be readable before depending on it.
 * It waits for the effect and not for the value to stop changing — two consecutive stale reads
 * agree with each other and are still wrong. A read that never shows the effect throws; it does
 * not fall through to acting on what was last seen.
 */
async function untilVisible<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  pollMs: number,
  attempts = 30,
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`${what} was not visible after ${attempts} reads (last read: ${String(last)})`);
}

/**
 * Bonds every planned lot that is not already bonded, issuer by issuer, in plan order.
 *
 * Per transaction: simulate, then send, then wait for the receipt before the next — the order the
 * lots land in IS the routing order, so no two are ever in flight together. Re-running is safe: a
 * lot that already matches the plan is left alone.
 */
export async function bondLots(input: BondInput): Promise<BondResult[]> {
  const log = input.log ?? (() => {});
  const dryRun = input.dryRun ?? true;
  const pollMs = input.pollMs ?? 2_000;
  const publicClient = createPublicClient({ transport: http(input.rpcUrl) });
  const results: BondResult[] = [];

  // Every pre-existing lot is judged against the plan BEFORE anything is sent.
  const pending: LotPlanEntry[] = [];
  for (const lot of input.plan) {
    const [hours, rate, bonded, , exists] = await publicClient.readContract({
      address: input.capacityBond,
      abi: CAPACITY_BOND_LOT_ABI,
      functionName: "lots",
      args: [lot.address, lot.classId],
    });
    if (!exists) {
      pending.push(lot);
      continue;
    }
    if (
      hours !== lot.committedCapacityHours ||
      rate !== lot.measuredRateMilliSiuPerHour ||
      bonded !== lot.bondedUsdc
    ) {
      throw new Error(
        `${lot.issuer} already has a ${lot.classLabel} lot with different figures (` +
          `${hours} h, ${rate} mSIU/h, ${bonded} bonded) from the record (${lot.committedCapacityHours} h, ` +
          `${lot.measuredRateMilliSiuPerHour} mSIU/h, ${lot.bondedUsdc}). A lot cannot be changed or ` +
          "removed, so the record and the chain disagree and that has to be resolved by hand.",
      );
    }
    results.push({ issuer: lot.issuer, classLabel: lot.classLabel, status: "already_bonded" });
    log(`${lot.issuer} ${lot.classLabel}: already bonded, matches the record`);
  }

  // The order check runs on what is ALREADY registered, so a wrong-order deployment is found
  // before a single new lot lands behind it.
  const declaredOrder = [...new Set(input.plan.map((l) => l.address))];
  for (const classId of new Set(input.plan.map((l) => l.classId))) {
    const registered = await publicClient.readContract({
      address: input.capacityBond,
      abi: CAPACITY_BOND_LOT_ABI,
      functionName: "issuersForClass",
      args: [classId],
    });
    const verdict = verifyRegistrationOrder(registered, declaredOrder);
    if (!verdict.ok) throw new Error(`class ${classId}: ${verdict.reason}`);
  }

  // Funds and keys are checked for every issuer that will send anything, before the first send.
  const toSend = new Map<string, LotPlanEntry[]>();
  for (const lot of pending) toSend.set(lot.issuer, [...(toSend.get(lot.issuer) ?? []), lot]);
  for (const [issuer, lots] of toSend) {
    const key = input.keyFor(issuer);
    const account = privateKeyToAccount(key);
    if (account.address.toLowerCase() !== lots[0].address.toLowerCase()) {
      throw new Error(
        `the key supplied for ${issuer} controls ${account.address}, but the record names ${lots[0].address}`,
      );
    }
    const need = lots.reduce((sum, l) => sum + l.bondedUsdc, 0n);
    const balance = await publicClient.readContract({
      address: input.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    if (balance < need) {
      throw new Error(`${issuer} holds ${balance} USDC base units and needs ${need} to bond its lots`);
    }
  }

  // The sends, in plan order — which is the order the record declares.
  for (const lot of pending) {
    const key = input.keyFor(lot.issuer);
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, transport: http(input.rpcUrl) });
    const result: BondResult = { issuer: lot.issuer, classLabel: lot.classLabel, status: "would_create" };

    const allowance = await publicClient.readContract({
      address: input.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, input.capacityBond],
    });
    if (allowance < lot.bondedUsdc) {
      const sim = await publicClient.simulateContract({
        account,
        address: input.usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [input.capacityBond, lot.bondedUsdc],
      });
      if (dryRun) {
        log(`${lot.issuer} ${lot.classLabel}: would approve ${lot.bondedUsdc} (simulated ok), then create the lot`);
        results.push(result);
        continue;
      }
      result.approveTx = await wallet.writeContract({ ...sim.request, chain: undefined });
      await publicClient.waitForTransactionReceipt({ hash: result.approveTx as Hex });
      // The simulation below depends on this allowance; see `untilVisible`.
      await untilVisible(
        () =>
          publicClient.readContract({
            address: input.usdc,
            abi: erc20Abi,
            functionName: "allowance",
            args: [account.address, input.capacityBond],
          }),
        (a) => a >= lot.bondedUsdc,
        `${lot.issuer}'s approval`,
        pollMs,
      );
    }

    const sim = await publicClient.simulateContract({
      account,
      address: input.capacityBond,
      abi: CAPACITY_BOND_LOT_ABI,
      functionName: "createLot",
      args: [lot.classId, lot.committedCapacityHours, lot.measuredRateMilliSiuPerHour, lot.bondedUsdc],
    });
    if (dryRun) {
      log(`${lot.issuer} ${lot.classLabel}: would create the lot (simulated ok)`);
      results.push(result);
      continue;
    }
    result.createLotTx = await wallet.writeContract({ ...sim.request, chain: undefined });
    await publicClient.waitForTransactionReceipt({ hash: result.createLotTx as Hex });
    // The next step reads registration, and the order is the point — wait until this lot shows.
    await untilVisible(
      () =>
        publicClient.readContract({
          address: input.capacityBond,
          abi: CAPACITY_BOND_LOT_ABI,
          functionName: "lots",
          args: [lot.address, lot.classId],
        }),
      (l) => l[4] === true,
      `${lot.issuer}'s ${lot.classLabel} lot`,
      pollMs,
    );
    result.status = "created";
    log(`${lot.issuer} ${lot.classLabel}: created, ${result.createLotTx}`);
    results.push(result);
  }

  if (!dryRun) {
    // Confirmed from the chain, not from the receipts: what must hold afterwards is the order. It
    // must be the FULL declared order — a stale read that is missing a new lot is a valid PREFIX,
    // and would pass a prefix check, so the wait is for the complete list.
    for (const classId of new Set(input.plan.map((l) => l.classId))) {
      const registered = await untilVisible(
        () =>
          publicClient.readContract({
            address: input.capacityBond,
            abi: CAPACITY_BOND_LOT_ABI,
            functionName: "issuersForClass",
            args: [classId],
          }),
        (list) =>
          list.length === declaredOrder.length &&
          list.every((a, i) => a.toLowerCase() === declaredOrder[i].toLowerCase()),
        `the full registration order for class ${classId}`,
        pollMs,
      ).catch(async (err) => {
        // Say what was actually there, so a real ordering failure is reported as one.
        const seen = await publicClient.readContract({
          address: input.capacityBond,
          abi: CAPACITY_BOND_LOT_ABI,
          functionName: "issuersForClass",
          args: [classId],
        });
        const verdict = verifyRegistrationOrder(seen, declaredOrder);
        throw new Error(
          `after bonding, class ${classId}: ${verdict.ok ? String(err instanceof Error ? err.message : err) : verdict.reason}`,
        );
      });
      void registered;
    }
  }
  return results;
}

/** Writes the transactions back into the record, beside the lot they created. */
export function withBondTxs(record: Record<string, unknown>, results: readonly BondResult[]): Record<string, unknown> {
  const lots = { ...(record.capacityLots as Record<string, Record<string, unknown>>) };
  for (const r of results) {
    if (r.status !== "created") continue;
    const entry = { ...lots[r.issuer] };
    const txs = { ...((entry.bondTransactions as Record<string, unknown> | undefined) ?? {}) };
    txs[r.classLabel] = { ...(r.approveTx ? { approve: r.approveTx } : {}), createLot: r.createLotTx };
    entry.bondTransactions = txs;
    lots[r.issuer] = entry;
  }
  return { ...record, capacityLots: lots };
}

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--deployment");
  const file = at === -1 ? undefined : argv[at + 1];
  if (!file || file.startsWith("--")) {
    // No default: bonding against whichever record happens to be the default is how a lot lands
    // on the wrong deployment.
    throw new Error("--deployment <path> is required (relative to the repo root).");
  }
  const execute = argv.includes("--execute");
  const fullPath = path.join(repoRoot(), file);
  const record = JSON.parse(readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
  const plan = planLots(record);
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "";
  if (!rpcUrl) throw new Error("BASE_SEPOLIA_RPC_URL is not set.");
  const usdc = (record.usdc as { address: Hex }).address;
  const capacityBond = (record.capacityBond as { address: Hex }).address;

  console.log(
    `${execute ? "EXECUTING" : "DRY RUN (nothing is sent; pass --execute to broadcast)"} — ` +
      `${plan.length} lots from ${file}, in the record's declared order:`,
  );
  for (const l of plan) {
    console.log(`  ${l.issuer} ${l.classLabel}: ${l.committedCapacityHours} h × ${l.measuredRateMilliSiuPerHour} mSIU/h → ${l.issuanceLimitMilliSiu} mSIU, ${l.bondedUsdc} bonded`);
  }
  bondLots({
    plan,
    capacityBond,
    usdc,
    rpcUrl,
    dryRun: !execute,
    log: (line) => console.log(`  ${line}`),
    keyFor: (issuer) => {
      const name = `${issuer.replace("-", "_")}_PRIVATE_KEY`;
      const key = process.env[name];
      if (!key) throw new Error(`${name} is not set.`);
      return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
    },
  }).then(
    (results) => {
      if (execute) {
        writeFileSync(fullPath, `${JSON.stringify(withBondTxs(record, results), null, 2)}\n`);
        console.log(`transaction hashes written back to ${file}`);
      }
      console.log(JSON.stringify(results, null, 2));
    },
    (err) => {
      console.error(`bond-lots refused: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

// Run only when invoked as a script, never when imported by the test.
if (process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1])) main();
