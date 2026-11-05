/**
 * DW1's ledger check (`docs/part5-build-plan.md` §3.2, and §6 "memory against anvil"): a scripted window's journal, replayed call by call onto the REAL contracts on a local anvil
 * chain, each call at its own block time, and every balance compared with the memory ledger.
 *
 * Local anvil only: the replayer starts its own anvil (or attaches to one, refusing any chain id but 31337), deploys the CR economy with `script/DeployCrEconomy.s.sol`, and signs with
 * keys derived from anvil's public default test mnemonic. No other network, no real key, no spend.
 *
 * Where the engine and the contracts differ on what a call NEEDS (approvals, ids, attestations, a caller the memory model leaves implicit), the replayer adapts, and every adaptation
 * is listed in `ADAPTATIONS`. Where they differ on what a call DOES (the chain refuses a call the memory model allowed, or the call moves different amounts), nothing is papered
 * over: the replay records a finding with the journal entry and both sides' balances, and stops.
 *
 * To know what memory held at each entry, the replayer re-runs the journal on a fresh memory ledger alongside the chain (the journal is deterministic), and checks the balances an
 * entry touched straight after it; the whole state is compared once at the end.
 */
import { execFile, spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  stringToBytes,
  toHex,
  type Abi,
  type Hex,
  type LocalAccount,
} from "viem";
import { HDKey, hdKeyToAccount } from "viem/accounts";
import { TASKS } from "../tasks/instances.js";
import { ScriptedAgent, StandInWorker, type Agent } from "./agents.js";
import { EconomyLog } from "./log.js";
import {
  BOND,
  BUFFER,
  INCOME,
  MemoryChain,
  PARTICIPANT,
  RESERVE,
  type Account,
  type Asset,
  type JournalEntry,
  type Mutating,
  type RollResult,
  type Redemption,
  type Sale,
  type Buy,
  type Series,
} from "./memory-chain.js";
import { loadParams } from "./params.js";
import {
  buildWorld,
  loadCrPrint,
  needsSchedule,
  passRates,
  runWindows,
  standInSha,
} from "./runner.js";
import { discounted, usdcFor } from "./units.js";
import type { World } from "./world.js";

const execFileAsync = promisify(execFile);

/** anvil's own default mnemonic, printed in its startup banner: public, worthless, local only */
export const ANVIL_TEST_MNEMONIC = "test test test test test test test test test test test junk";
const ANVIL_CHAIN_ID = 31337;
/** gas for every replayed transaction: far above any call here, below anvil's 30M block limit */
const GAS = 20_000_000n;
const TEST_ETH = 10n ** 24n;
const ESCROW_OPEN = 1;

/**
 * Every place the replayer supplies something the memory model does not have, or carries a call out differently because the contracts need it. None of them changes what a call
 * does to a balance; each is checked by the balance comparison after the entry.
 */
export const ADAPTATIONS: readonly string[] = [
  "Addresses: every memory account that is a wallet gets a key derived from anvil's public test mnemonic (index 0 deploys, index 1 is the lab publisher, the rest in order of first appearance in the journal); `reserve` is AguLab, `buffer` AguBuffer, `bond` CapacityBond, and `escrow:<id>` is the escrow record <id> inside the TouchstoneEscrow of that escrow's asset.",
  'Ids: a memory claim id (sha256 of the claim type) becomes WorkClaim\'s `keccak256(abi.encode(issuer, classId, series, windowFrom, windowTo))`, computed from the memory claim type with the issuer\'s address; a class id is `keccak256("CR-PL")` and so on, a series `keccak256("commodity")` or `keccak256("frontier")`, as the Foundry fixtures use; an escrow id becomes the quote hash `keccak256(id)`.',
  "Approvals: before each call that pulls tokens, its payer approves exactly what the memory model moves (createLot: the bond; mint: the claim price at the rate; escrowOpen: the maximum; seedBuffer: the amount; roll: each sale buyer the sum of its sales at the discounted rate), so a contract that pulled more would be refused, not covered. The participant gives AguLab `setApprovalForAll` on WorkClaim once at setup, for `create`.",
  "Rate attestations: every call that takes a rate (mint, roll, settleWindowClose) gets an EIP-712 attestation of the journal's own rate and the claim's series, signed by the lab publisher key; the roll's is signed twice, once for AguLab's domain and once for WorkClaim's. The print date is the window-close day for settleWindowClose (the contract checks it) and the call's own day elsewhere; it is valid for two days from that day.",
  "Implicit callers: memory's setSkipped and setProbe take no caller, and the router accepts only the lab publisher, so the publisher sends them; settleWindowClose and escrowExpire are permissionless and are sent from the deployer key; test-USDC mints are sent from the deployer key (CrLabTestDollar's mint is open).",
  "References the memory model does not keep: presentForRedemption's task-spec hash, serveRedemption's and settle's receipt reference are `keccak256(\"journal:<entry index>\")`.",
  "Time: each journal entry's transactions are mined at the entry's `now` (anvil allows equal timestamps), the chain's genesis is an hour before the first entry, and before the final comparison an empty block is mined at memory's current clock, so live face is read at the same moment on both sides.",
  "Deployment: `DeployCrEconomy.s.sol` (forge script) with the CR_* configuration from the memory ledger's own AGU-lab parameters (buffer target, minimum tenor, discount) and the treasury left to the deployer, as the script defaults; contract addresses are predicted from the deployer's nonces and checked against each contract's own wiring.",
];

/** one value that differs between the two ledgers */
export interface DiffRow {
  what:
    | "usdc"
    | "agu"
    | "claim"
    | "supply"
    | "live face"
    | "escrow contract"
    | "bond lot"
    | "issuers for class"
    | "router"
    | "reserve lot"
    | "escrow"
    | "presented"
    | "settled"
    | "unmapped";
  key: string;
  memory: string;
  chain: string;
}

/** a real disagreement: the chain refused, or moved something else, on an entry the memory model carried out; the replay stops at the first */
export interface ReplayFinding {
  entry: number;
  op: Mutating;
  now: number;
  args: unknown;
  kind: "chain refused" | "no chain path" | "different balances" | "memory replay failed";
  detail: string;
  balances: {
    account: Account;
    asset: Asset;
    memoryBefore: string;
    memoryAfter: string;
    chain: string;
  }[];
  rows: DiffRow[];
}

export interface ReplayResult {
  ledger: "anvil";
  entries: number;
  replayed: number;
  transactions: number;
  findings: ReplayFinding[];
  /** chain against memory at the end; after a finding, against memory as of the refused entry (so it shows what that entry moved in memory alone) */
  diff: DiffRow[];
  adaptations: readonly string[];
  addresses: Record<Account, Hex>;
  contracts: Record<string, Hex>;
}

class ChainRefused extends Error {}
class NoChainPath extends Error {}

const ASSETS: readonly Asset[] = ["USDC", "AGU"];
const isContractAccount = (a: Account): boolean =>
  a === RESERVE || a === BUFFER || a === BOND || a.startsWith("escrow:");
const idHash = (s: string): Hex => keccak256(stringToBytes(s));
const dayStart = (t: number): bigint => BigInt(t - (t % 86_400));
/** bigint-safe JSON for findings */
const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));

/** both Foundry tools on PATH: the replay and its test need them, and the test skips without them */
export async function foundryAvailable(): Promise<boolean> {
  const ok = (cmd: string): Promise<boolean> =>
    new Promise((res) => {
      const p = spawn(cmd, ["--version"], { stdio: "ignore" });
      p.on("error", () => res(false));
      p.on("close", (code) => res(code === 0));
    });
  const [a, f] = await Promise.all([ok("anvil"), ok("forge")]);
  return a && f;
}

function contractsDir(): string {
  // src/economy/chain-replay.ts (or dist/economy/chain-replay.js) -> packages/contracts
  return resolve(fileURLToPath(import.meta.url), "../../../../contracts");
}

/** the wallets, from anvil's public mnemonic (BIP-39 seed, BIP-44 path m/44'/60'/0'/0/i) */
function testKeys(n: number): { accounts: LocalAccount[]; deployerKey: Hex } {
  const seed = pbkdf2Sync(ANVIL_TEST_MNEMONIC.normalize("NFKD"), "mnemonic", 2048, 64, "sha512");
  const root = HDKey.fromMasterSeed(seed);
  const accounts = Array.from({ length: n }, (_, i) => hdKeyToAccount(root, { addressIndex: i }));
  const pk = root.derive("m/44'/60'/0'/0/0").privateKey;
  if (pk === null) throw new Error("could not derive anvil's test key 0");
  return { accounts, deployerKey: toHex(pk) };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (a === null || typeof a === "string") return rej(new Error("no free port"));
      s.close(() => res(a.port));
    });
  });
}

/** a fresh anvil on a free local port, its genesis at `timestamp`, base fee zero */
async function startAnvil(
  timestamp: number,
): Promise<{ rpcUrl: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    "anvil",
    ["--port", String(port), "--silent", "--timestamp", String(timestamp), "--base-fee", "0"],
    { stdio: "ignore" },
  );
  const died = new Promise<never>((_, rej) => {
    child.on("error", rej);
    child.on("exit", (code) => rej(new Error(`anvil exited early (code ${code})`)));
  });
  const ready = (async () => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      try {
        const r = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        if (r.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`anvil did not answer on ${rpcUrl} within 15 s`);
  })();
  await Promise.race([ready, died]);
  died.catch(() => undefined);
  return {
    rpcUrl,
    stop: () =>
      new Promise<void>((res) => {
        if (child.exitCode !== null) return res();
        child.once("exit", () => res());
        child.kill();
      }),
  };
}

/** the wallet accounts an entry names, and the contract accounts it moves, before it runs (the routed issuers are added from its result) */
function accountsIn(op: Mutating, a: readonly unknown[]): Account[] {
  const s = (i: number): Account => a[i] as Account;
  switch (op) {
    case "mintTestUsdc":
    case "mint":
    case "present":
    case "setSkipped":
    case "setProbe":
      return [s(0)];
    case "transfer":
    case "transferClaim":
      return [s(1), s(2)];
    case "createLot":
      return [s(0), BOND];
    case "serve":
      return [s(0), s(2)];
    case "settleWindowClose":
      return [s(1), BOND];
    case "escrowOpen":
      return [s(2), s(3), s(4), `escrow:${s(0)}`];
    case "escrowSettle":
      return [s(1), `escrow:${s(0)}`];
    case "escrowExpire":
      return [`escrow:${s(0)}`];
    case "create":
    case "redeem":
      return [s(0), RESERVE];
    case "seedBuffer":
      return [s(0), BUFFER];
    case "roll":
      return [
        s(0),
        RESERVE,
        BUFFER,
        INCOME,
        ...(a[1] as { sales: Sale[] }).sales.map((x) => x.buyer),
      ];
  }
}

/** `RateAttestationVerifier.RateAttestation` */
interface RateAttestation {
  printId: string;
  series: Hex;
  printDate: bigint;
  nanoUsdPerSiu: bigint;
  validUntil: bigint;
}

interface Contracts {
  dollar: Hex;
  claimEscrow: Hex;
  bond: Hex;
  router: Hex;
  workClaim: Hex;
  buffer: Hex;
  aguLab: Hex;
  aguEscrow: Hex;
}

/**
 * One anvil chain carrying the CR economy, fed from one memory ledger's journal. `open` starts (or attaches to) anvil and deploys; `replay` runs the journal and compares; `compare`
 * can be called again with another memory ledger; `close` stops an anvil it started.
 */
export class ChainReplay {
  readonly #rpcUrl: string;
  readonly #stop: () => Promise<void>;
  readonly #client: ReturnType<typeof createPublicClient>;
  readonly #abi: Record<string, Abi>;
  readonly #errors: Abi;
  readonly #c: Contracts;
  readonly #keys = new Map<Hex, LocalAccount>();
  readonly #addr = new Map<Account, Hex>();
  readonly #nonce = new Map<Hex, number>();
  readonly #escrowAsset = new Map<string, Asset>();
  readonly #deployer: Account = "(deployer)";
  readonly #publisher: Account = "(lab publisher)";
  #gasPrice = 0n;
  #now = 0;
  #txs = 0;

  private constructor(
    readonly memory: MemoryChain,
    init: {
      rpcUrl: string;
      stop: () => Promise<void>;
      abi: Record<string, Abi>;
      contracts: Contracts;
      wallets: Map<Account, LocalAccount>;
    },
  ) {
    this.#rpcUrl = init.rpcUrl;
    this.#stop = init.stop;
    this.#client = createPublicClient({ transport: http(init.rpcUrl, { batch: true }) });
    this.#abi = init.abi;
    const seen = new Set<string>();
    this.#errors = Object.values(init.abi)
      .flat()
      .filter((x) => {
        if (x.type !== "error") return false;
        const sig = `${x.name}(${x.inputs.map((i) => i.type).join(",")})`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
      });
    this.#c = init.contracts;
    for (const [name, acct] of init.wallets) {
      this.#keys.set(acct.address, acct);
      this.#addr.set(name, acct.address);
    }
    this.#addr.set(RESERVE, init.contracts.aguLab);
    this.#addr.set(BUFFER, init.contracts.buffer);
    this.#addr.set(BOND, init.contracts.bond);
  }

  /** starts anvil (or attaches to `rpcUrl`, which must be a local anvil at chain id 31337 whose clock is before the journal's first entry) and deploys the CR economy */
  static async open(
    memory: MemoryChain,
    opts: { rpcUrl?: string; build?: boolean } = {},
  ): Promise<ChainReplay> {
    const journal = memory.journal;
    const first = journal[0];
    if (first === undefined) throw new Error("the memory ledger's journal is empty");
    // every wallet the journal names, in order of first appearance, after the roles the deployment needs
    const names: Account[] = [memory.issuerRole, PARTICIPANT, INCOME];
    for (const e of journal)
      for (const a of accountsIn(e.op, e.args))
        if (!isContractAccount(a) && !names.includes(a)) names.push(a);
    const { accounts, deployerKey } = testKeys(names.length + 2);
    const wallets = new Map<Account, LocalAccount>([
      ["(deployer)", accounts[0] as LocalAccount],
      ["(lab publisher)", accounts[1] as LocalAccount],
    ]);
    names.forEach((n, i) => wallets.set(n, accounts[i + 2] as LocalAccount));
    const addrOf = (n: Account): Hex => (wallets.get(n) as LocalAccount).address;

    const dir = contractsDir();
    if (opts.build !== false) await execFileAsync("forge", ["build"], { cwd: dir });
    const artifacts = [
      "CrLabTestDollar",
      "TouchstoneEscrow",
      "CapacityBond",
      "EligibleClaimRouter",
      "WorkClaim",
      "AguBuffer",
      "AguLab",
    ];
    const abi: Record<string, Abi> = {};
    for (const n of artifacts)
      abi[n] = (
        JSON.parse(readFileSync(join(dir, "out", `${n}.sol`, `${n}.json`), "utf-8")) as {
          abi: Abi;
        }
      ).abi;

    const node =
      opts.rpcUrl === undefined
        ? await startAnvil(first.now - 3_600)
        : { rpcUrl: opts.rpcUrl, stop: async () => undefined };
    try {
      const rpc = (method: string, params: unknown[] = []): Promise<unknown> =>
        rawRpc(node.rpcUrl, method, params);
      if (Number(await rpc("eth_chainId")) !== ANVIL_CHAIN_ID)
        throw new Error("the replay runs on a local anvil chain (31337) only");
      const version = String(await rpc("web3_clientVersion"));
      if (!version.toLowerCase().includes("anvil"))
        throw new Error(`the replay runs on anvil only, not ${version}`);
      const latest = (await rpc("eth_getBlockByNumber", ["latest", false])) as {
        timestamp: Hex;
      };
      if (Number(latest.timestamp) >= first.now)
        throw new Error(
          "the chain's clock is already at or past the journal's first entry: start a fresh anvil",
        );
      for (const a of wallets.values()) await rpc("anvil_setBalance", [a.address, toHex(TEST_ETH)]);

      // the real deployment script, configured from the memory ledger's own AGU-lab parameters
      const deployer = addrOf("(deployer)");
      const n0 = Number(await rpc("eth_getTransactionCount", [deployer, "pending"]));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CR_LAB_PUBLISHER_ADDRESS: addrOf("(lab publisher)"),
        CR_AGU_ISSUER_ADDRESS: addrOf(memory.issuerRole),
        CR_AGU_PARTICIPANT_ADDRESS: addrOf(PARTICIPANT),
        CR_AGU_INCOME_LEDGER_ADDRESS: addrOf(INCOME),
        CR_AGU_BUFFER_TARGET: memory.agu_.bufferTarget.toString(),
        CR_AGU_MIN_TENOR_SECONDS: String(memory.agu_.minTenorSeconds),
        CR_AGU_ROLL_DISCOUNT_BPS: memory.agu_.discountBps.toString(),
      };
      delete env.CR_ESCROW_TREASURY_ADDRESS;
      await execFileAsync(
        "forge",
        [
          "script",
          "script/DeployCrEconomy.s.sol:DeployCrEconomy",
          "--rpc-url",
          node.rpcUrl,
          "--broadcast",
          "--private-key",
          deployerKey,
        ],
        { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 },
      );
      const at = (i: number): Hex =>
        getContractAddress({ from: deployer, nonce: BigInt(n0 + i) }).toLowerCase() as Hex;
      const contracts: Contracts = {
        dollar: at(0),
        claimEscrow: at(1),
        bond: at(2),
        router: at(3),
        workClaim: at(4),
        buffer: at(5),
        aguLab: at(6),
        aguEscrow: at(7),
      };
      const r = new ChainReplay(memory, { ...node, abi, contracts, wallets });
      await r.#checkWiring();
      r.#gasPrice = BigInt((await rpc("eth_gasPrice")) as Hex);
      // the participant lets AguLab pull the claims it creates against (ERC-1155 has no amounts)
      r.#now = Number(
        ((await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: Hex }).timestamp,
      );
      await r.#send(PARTICIPANT, contracts.workClaim, "WorkClaim", "setApprovalForAll", [
        contracts.aguLab,
        true,
      ]);
      return r;
    } catch (e) {
      await node.stop();
      throw e;
    }
  }

  /** the deployment's addresses, predicted from nonces, checked against what each contract says it is wired to */
  async #checkWiring(): Promise<void> {
    const c = this.#c;
    const read = (address: Hex, name: string, fn: string): Promise<string> =>
      this.#read(address, name, fn, []).then((v) => String(v).toLowerCase());
    const pairs: [Promise<string>, string, string][] = [
      [read(c.aguLab, "AguLab", "workClaim"), c.workClaim, "AguLab.workClaim"],
      [read(c.aguLab, "AguLab", "buffer"), c.buffer, "AguLab.buffer"],
      [read(c.aguLab, "AguLab", "usdc"), c.dollar, "AguLab.usdc"],
      [read(c.aguLab, "AguLab", "participant"), this.#a(PARTICIPANT), "AguLab.participant"],
      [read(c.aguLab, "AguLab", "incomeLedger"), this.#a(INCOME), "AguLab.incomeLedger"],
      [read(c.aguLab, "AguLab", "aguIssuer"), this.#a(this.memory.issuerRole), "AguLab.aguIssuer"],
      [read(c.workClaim, "WorkClaim", "bond"), c.bond, "WorkClaim.bond"],
      [read(c.workClaim, "WorkClaim", "router"), c.router, "WorkClaim.router"],
      [read(c.workClaim, "WorkClaim", "escrow"), c.claimEscrow, "WorkClaim.escrow"],
      [
        read(c.workClaim, "WorkClaim", "publisher"),
        this.#a(this.#publisher),
        "WorkClaim.publisher",
      ],
      [read(c.claimEscrow, "TouchstoneEscrow", "token"), c.dollar, "claim escrow token"],
      [read(c.aguEscrow, "TouchstoneEscrow", "token"), c.aguLab, "AGU-lab escrow token"],
      [read(c.buffer, "AguBuffer", "aguLab"), c.aguLab, "AguBuffer.aguLab"],
    ];
    for (const [got, want, what] of pairs)
      if ((await got) !== want.toLowerCase())
        throw new Error(`deployment wiring: ${what} is ${await got}, expected ${want}`);
  }

  get rpcUrl(): string {
    return this.#rpcUrl;
  }
  /** the chain address the replay gave a memory account */
  addressOf(account: Account): Hex {
    return this.#a(account);
  }
  get contracts(): Contracts {
    return { ...this.#c };
  }

  /** replays the whole journal, then compares the chain with the memory ledger it came from */
  async replay(): Promise<ReplayResult> {
    const shadow = new MemoryChain(this.memory.agu_, this.memory.issuerRole, () => this.#now);
    const journal = this.memory.journal;
    const findings: ReplayFinding[] = [];
    let replayed = 0;
    for (let i = 0; i < journal.length; i++) {
      const finding = await this.#entry(i, journal[i] as JournalEntry, shadow);
      if (finding !== undefined) {
        findings.push(finding);
        break;
      }
      replayed++;
    }
    const diff = await this.compare(findings.length === 0 ? this.memory : shadow);
    return {
      ledger: "anvil",
      entries: journal.length,
      replayed,
      transactions: this.#txs,
      findings,
      diff,
      adaptations: ADAPTATIONS,
      addresses: Object.fromEntries(this.#addr),
      contracts: { ...this.#c },
    };
  }

  async close(): Promise<void> {
    await this.#stop();
  }

  // ---- one entry ----------------------------------------------------------------------------------------------------------------------------------
  async #entry(
    i: number,
    e: JournalEntry,
    shadow: MemoryChain,
  ): Promise<ReplayFinding | undefined> {
    this.#now = e.now;
    const args = structuredClone(e.args);
    const named = accountsIn(e.op, args);
    const escrowParties = (id: string): Account[] => {
      const x = shadow.escrows.get(id);
      return x === undefined ? [] : [x.buyer, x.seller];
    };
    if (e.op === "escrowSettle" || e.op === "escrowExpire")
      named.push(...escrowParties(args[0] as string));
    const before = this.#snapshot(shadow, named);
    // memory first: its result names the routed issuers and the claims the entry touched
    let result: unknown;
    try {
      result = (shadow as unknown as Record<Mutating, (...a: unknown[]) => unknown>)[e.op](
        ...structuredClone(args),
      );
    } catch (err) {
      return this.#finding(i, e, "memory replay failed", String(err), before, shadow, []);
    }
    const touched = new Set<Account>(named);
    const tokens = new Set<string>();
    switch (e.op) {
      case "mint": {
        const id = result as string;
        tokens.add(id);
        touched.add(shadow.claimTypes.get(id)?.issuer ?? "");
        break;
      }
      case "transferClaim":
      case "present":
      case "serve":
      case "settleWindowClose":
      case "create":
        tokens.add(
          args[e.op === "transferClaim" || e.op === "settleWindowClose" ? 0 : 1] as string,
        );
        if (e.op === "serve" || e.op === "settleWindowClose")
          touched.add(shadow.claimTypes.get([...tokens][0] as string)?.issuer ?? "");
        break;
      case "redeem":
        for (const l of (result as Redemption).lots) tokens.add(l.tokenId);
        break;
      case "roll": {
        const r = result as RollResult;
        for (const id of (args[1] as { frontLots: string[] }).frontLots) tokens.add(id);
        for (const m of r.minted) {
          tokens.add(m.tokenId);
          touched.add(m.issuer);
        }
        break;
      }
      default:
        break;
    }
    touched.delete("");
    try {
      await this.#carryOut(i, e.op, args, shadow);
    } catch (err) {
      if (err instanceof ChainRefused || err instanceof NoChainPath)
        return this.#finding(
          i,
          e,
          err instanceof ChainRefused ? "chain refused" : "no chain path",
          err.message,
          before,
          shadow,
          [],
        );
      throw err;
    }
    const rows = await this.#compareSome(shadow, [...touched], [...tokens]);
    if (e.op === "setSkipped" || e.op === "setProbe")
      rows.push(...(await this.#routerRows(shadow, [args[0] as Account])));
    if (rows.length > 0)
      return this.#finding(
        i,
        e,
        "different balances",
        "the chain holds different balances, or routing flags, than memory after this entry",
        before,
        shadow,
        rows,
      );
    return undefined;
  }

  #snapshot(m: MemoryChain, accounts: Account[]): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const a of accounts)
      for (const asset of ASSETS) out.set(`${a}|${asset}`, m.balance(a, asset));
    return out;
  }

  async #finding(
    i: number,
    e: JournalEntry,
    kind: ReplayFinding["kind"],
    detail: string,
    before: Map<string, bigint>,
    shadow: MemoryChain,
    rows: DiffRow[],
  ): Promise<ReplayFinding> {
    const balances: ReplayFinding["balances"] = [];
    for (const [key, b] of before) {
      const [account, asset] = key.split("|") as [Account, Asset];
      const chain = await this.#chainBalance(account, asset);
      balances.push({
        account,
        asset,
        memoryBefore: b.toString(),
        memoryAfter: shadow.balance(account, asset).toString(),
        chain: chain?.toString() ?? "no address",
      });
    }
    return { entry: i, op: e.op, now: e.now, args: plain(e.args), kind, detail, balances, rows };
  }

  /** the chain calls for one journal entry; throws ChainRefused or NoChainPath */
  async #carryOut(i: number, op: Mutating, a: unknown[], shadow: MemoryChain): Promise<void> {
    const c = this.#c;
    const ref = idHash(`journal:${i}`);
    const wallet = (x: Account, why: string): Account => {
      if (isContractAccount(x) || !this.#addr.has(x))
        throw new NoChainPath(
          `${why}: ${x} is not a wallet, and no contract call moves its holdings this way`,
        );
      return x;
    };
    switch (op) {
      case "mintTestUsdc": {
        const [to, amount] = a as [Account, bigint];
        return this.#send(this.#deployer, c.dollar, "CrLabTestDollar", "mint", [
          this.#a(to),
          amount,
        ]);
      }
      case "transfer": {
        const [asset, from, to, amount] = a as [Asset, Account, Account, bigint];
        wallet(from, `${asset} transfer`);
        return this.#send(from, this.#token(asset), this.#tokenAbi(asset), "transfer", [
          this.#a(to),
          amount,
        ]);
      }
      case "createLot": {
        const [issuer, classId, hours, rate, bonded] = a as [
          Account,
          string,
          bigint,
          bigint,
          bigint,
        ];
        await this.#send(issuer, c.dollar, "CrLabTestDollar", "approve", [c.bond, bonded]);
        return this.#send(issuer, c.bond, "CapacityBond", "createLot", [
          idHash(classId),
          hours,
          rate,
          bonded,
        ]);
      }
      case "transferClaim": {
        const [tokenId, from, to, milli] = a as [string, Account, Account, bigint];
        wallet(from, "claim transfer");
        return this.#send(from, c.workClaim, "WorkClaim", "safeTransferFrom", [
          this.#a(from),
          this.#a(to),
          this.#claimId(shadow, tokenId),
          milli,
          "0x",
        ]);
      }
      case "mint": {
        const [buyer, classId, series, milli, from, to, rate] = a as [
          Account,
          string,
          Series,
          bigint,
          number,
          number,
          bigint,
        ];
        wallet(buyer, "claim mint");
        const att = this.#attestation(series, rate, dayStart(this.#now));
        const sig = await this.#sign(att, c.workClaim);
        await this.#send(buyer, c.dollar, "CrLabTestDollar", "approve", [
          c.workClaim,
          usdcFor(milli, rate),
        ]);
        return this.#send(buyer, c.workClaim, "WorkClaim", "mint", [
          idHash(classId),
          idHash(series),
          milli,
          BigInt(from),
          BigInt(to),
          att,
          sig,
        ]);
      }
      case "present": {
        const [holder, tokenId] = a as [Account, string];
        wallet(holder, "presentation");
        return this.#send(holder, c.workClaim, "WorkClaim", "presentForRedemption", [
          this.#claimId(shadow, tokenId),
          ref,
        ]);
      }
      case "serve": {
        const [issuer, tokenId, holder, milli, passed] = a as [
          Account,
          string,
          Account,
          bigint,
          boolean,
        ];
        return this.#send(issuer, c.workClaim, "WorkClaim", "serveRedemption", [
          this.#claimId(shadow, tokenId),
          this.#a(holder),
          milli,
          passed,
          ref,
        ]);
      }
      case "settleWindowClose": {
        const [tokenId, holder, rate] = a as [string, Account, bigint];
        const ct = shadow.claimTypes.get(tokenId);
        if (ct === undefined) throw new NoChainPath(`no claim type for ${tokenId}`);
        const att = this.#attestation(ct.series, rate, dayStart(ct.windowTo));
        const sig = await this.#sign(att, c.workClaim);
        return this.#send(this.#deployer, c.workClaim, "WorkClaim", "settleWindowClose", [
          this.#claimId(shadow, tokenId),
          this.#a(holder),
          att,
          sig,
        ]);
      }
      case "escrowOpen": {
        const [id, asset, buyer, seller, settler, max, expiry] = a as [
          string,
          Asset,
          Account,
          Account,
          Account,
          bigint,
          number,
        ];
        wallet(buyer, "escrow funding");
        this.#escrowAsset.set(id, asset);
        await this.#send(buyer, this.#token(asset), this.#tokenAbi(asset), "approve", [
          this.#escrow(asset),
          max,
        ]);
        return this.#send(buyer, this.#escrow(asset), "TouchstoneEscrow", "openAndFund", [
          idHash(id),
          this.#a(seller),
          this.#a(settler),
          max,
          BigInt(expiry),
        ]);
      }
      case "escrowSettle": {
        const [id, caller, actual] = a as [string, Account, bigint];
        return this.#send(
          caller,
          this.#escrow(this.#assetOf(id, shadow)),
          "TouchstoneEscrow",
          "settle",
          [idHash(id), actual, ref],
        );
      }
      case "escrowExpire": {
        const [id] = a as [string];
        return this.#send(
          this.#deployer,
          this.#escrow(this.#assetOf(id, shadow)),
          "TouchstoneEscrow",
          "expire",
          [idHash(id)],
        );
      }
      case "create": {
        const [caller, tokenId, milli] = a as [Account, string, bigint];
        wallet(caller, "creation");
        return this.#send(caller, c.aguLab, "AguLab", "create", [
          this.#claimId(shadow, tokenId),
          milli,
        ]);
      }
      case "redeem": {
        const [holder, units] = a as [Account, bigint];
        wallet(holder, "redemption");
        return this.#send(holder, c.aguLab, "AguLab", "redeem", [units]);
      }
      case "seedBuffer": {
        const [from, amount] = a as [Account, bigint];
        wallet(from, "buffer seed");
        await this.#send(from, c.dollar, "CrLabTestDollar", "approve", [c.buffer, amount]);
        return this.#send(from, c.buffer, "AguBuffer", "seed", [amount]);
      }
      case "roll": {
        const [caller, r] = a as [
          Account,
          {
            rate: bigint;
            frontLots: string[];
            sales: Sale[];
            buys: Buy[];
            buyFrom: number;
            buyTo: number;
          },
        ];
        const att = this.#attestation(this.memory.agu_.reserveSeries, r.rate, dayStart(this.#now));
        const [labSig, claimSig] = await Promise.all([
          this.#sign(att, c.aguLab),
          this.#sign(att, c.workClaim),
        ]);
        const price = discounted(r.rate, this.memory.agu_.discountBps);
        const owed = new Map<Account, bigint>();
        for (const s of r.sales)
          owed.set(s.buyer, (owed.get(s.buyer) ?? 0n) + usdcFor(s.milli, price));
        for (const [buyer, amount] of owed) {
          wallet(buyer, "front-claim purchase");
          await this.#send(buyer, c.dollar, "CrLabTestDollar", "approve", [c.aguLab, amount]);
        }
        const order = {
          frontLots: r.frontLots.map((id) => this.#claimId(shadow, id)),
          sales: r.sales.map((s) => ({
            buyer: this.#a(s.buyer),
            tokenId: this.#claimId(shadow, s.tokenId),
            quantityMilli: s.milli,
          })),
          buys: r.buys.map((b) => ({ classId: idHash(b.classId), quantityMilli: b.milli })),
          buyFrom: BigInt(r.buyFrom),
          buyTo: BigInt(r.buyTo),
        };
        return this.#send(caller, c.aguLab, "AguLab", "roll", [order, att, labSig, claimSig]);
      }
      case "setSkipped":
      case "setProbe": {
        const [issuer, on] = a as [Account, boolean];
        return this.#send(this.#publisher, c.router, "EligibleClaimRouter", op, [
          this.#a(issuer),
          on,
        ]);
      }
    }
  }

  // ---- ids, attestations, transactions ----------------------------------------------------------------------------------------------------------
  #a(account: Account): Hex {
    const x = this.#addr.get(account);
    if (x === undefined) throw new NoChainPath(`no address for account ${account}`);
    return x;
  }
  #token(asset: Asset): Hex {
    return asset === "USDC" ? this.#c.dollar : this.#c.aguLab;
  }
  #tokenAbi(asset: Asset): string {
    return asset === "USDC" ? "CrLabTestDollar" : "AguLab";
  }
  #escrow(asset: Asset): Hex {
    return asset === "USDC" ? this.#c.claimEscrow : this.#c.aguEscrow;
  }
  #assetOf(id: string, m: MemoryChain): Asset {
    return this.#escrowAsset.get(id) ?? m.escrows.get(id)?.asset ?? "USDC";
  }
  /** WorkClaim's id for a memory claim id: the same claim type, with the issuer's address */
  #claimId(m: MemoryChain, tokenId: string): bigint {
    const ct = m.claimTypes.get(tokenId);
    if (ct === undefined) throw new NoChainPath(`no memory claim type for ${tokenId}`);
    return BigInt(
      keccak256(
        encodeAbiParameters(
          [
            { type: "address" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint64" },
            { type: "uint64" },
          ],
          [
            this.#a(ct.issuer),
            idHash(ct.classId),
            idHash(ct.series),
            BigInt(ct.windowFrom),
            BigInt(ct.windowTo),
          ],
        ),
      ),
    );
  }
  #attestation(series: Series, rate: bigint, printDate: bigint): RateAttestation {
    return {
      printId: `cr-lab-replay-${series}-${printDate}`,
      series: idHash(series),
      printDate,
      nanoUsdPerSiu: rate,
      validUntil: printDate + 2n * 86_400n,
    };
  }
  #sign(att: RateAttestation, verifyingContract: Hex): Promise<Hex> {
    const key = this.#keys.get(this.#a(this.#publisher)) as LocalAccount;
    return key.signTypedData({
      domain: {
        name: "Touchstone Rate Attestation",
        version: "1",
        chainId: ANVIL_CHAIN_ID,
        verifyingContract,
      },
      types: {
        RateAttestation: [
          { name: "printId", type: "string" },
          { name: "series", type: "bytes32" },
          { name: "printDate", type: "uint64" },
          { name: "nanoUsdPerSiu", type: "uint256" },
          { name: "validUntil", type: "uint64" },
        ],
      },
      primaryType: "RateAttestation",
      message: att,
    });
  }

  /** one transaction from `from`'s test key, mined at the entry's time; a refusal (simulated first, at that time) throws ChainRefused with the decoded error */
  async #send(
    from: Account,
    to: Hex,
    contract: string,
    fn: string,
    args: readonly unknown[],
  ): Promise<void> {
    const sender = this.#a(from);
    const key = this.#keys.get(sender);
    if (key === undefined) throw new NoChainPath(`${from} has no key`);
    const data = encodeFunctionData({ abi: this.#abi[contract] as Abi, functionName: fn, args });
    const rpc = (method: string, params: unknown[]): Promise<unknown> =>
      rawRpc(this.#rpcUrl, method, params);
    await rpc("evm_setNextBlockTimestamp", [this.#now]);
    try {
      await rpc("eth_call", [{ from: sender, to, data }, "pending"]);
    } catch (err) {
      throw new ChainRefused(`${contract}.${fn} from ${from}: ${this.#decode(err)}`);
    }
    let nonce = this.#nonce.get(sender);
    if (nonce === undefined)
      nonce = Number(await rpc("eth_getTransactionCount", [sender, "pending"]));
    const raw = await key.signTransaction({
      to,
      data,
      nonce,
      gas: GAS,
      gasPrice: this.#gasPrice,
      chainId: ANVIL_CHAIN_ID,
      type: "legacy",
    });
    this.#nonce.set(sender, nonce + 1);
    const hash = (await rpc("eth_sendRawTransaction", [raw])) as Hex;
    this.#txs++;
    for (let tries = 0; tries < 50; tries++) {
      const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as { status: Hex } | null;
      if (receipt !== null) {
        if (Number(receipt.status) !== 1)
          throw new ChainRefused(
            `${contract}.${fn} from ${from}: reverted when mined, after a passing simulation`,
          );
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no receipt for ${hash}`);
  }

  #decode(err: unknown): string {
    let cur: unknown = err;
    for (let d = 0; d < 8 && cur !== null && typeof cur === "object"; d++) {
      const data = (cur as { data?: unknown }).data;
      if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
        try {
          const r = decodeErrorResult({ abi: this.#errors, data: data as Hex });
          return `${r.errorName}(${(r.args ?? []).map((x) => String(x)).join(", ")})`;
        } catch {
          return `revert data ${data}`;
        }
      }
      cur = (cur as { cause?: unknown }).cause;
    }
    return err instanceof Error ? err.message : String(err);
  }

  async #read(
    address: Hex,
    contract: string,
    fn: string,
    args: readonly unknown[],
  ): Promise<unknown> {
    return this.#client.readContract({
      address,
      abi: this.#abi[contract] as Abi,
      functionName: fn,
      args,
    });
  }

  // ---- comparison -------------------------------------------------------------------------------------------------------------------------------
  /** a memory account's balance on the chain: a token balance, or for `escrow:<id>` what that escrow record still holds */
  async #chainBalance(account: Account, asset: Asset): Promise<bigint | undefined> {
    if (account.startsWith("escrow:")) {
      const id = account.slice("escrow:".length);
      const rec = (await this.#read(this.#escrow(asset), "TouchstoneEscrow", "escrows", [
        idHash(id),
      ])) as readonly unknown[];
      return Number(rec[2]) === ESCROW_OPEN ? (rec[5] as bigint) : 0n;
    }
    const addr = this.#addr.get(account);
    if (addr === undefined) return undefined;
    return (await this.#read(this.#token(asset), this.#tokenAbi(asset), "balanceOf", [
      addr,
    ])) as bigint;
  }

  async #balanceRows(m: MemoryChain, accounts: Account[]): Promise<DiffRow[]> {
    const checks = accounts.flatMap((a) =>
      ASSETS.map(async (asset): Promise<DiffRow | undefined> => {
        const mem = m.balance(a, asset);
        const chain = await this.#chainBalance(a, asset);
        if (chain === undefined)
          return mem === 0n
            ? undefined
            : {
                what: "unmapped",
                key: `${a} ${asset}`,
                memory: mem.toString(),
                chain: "no address",
              };
        return chain === mem
          ? undefined
          : {
              what: asset === "USDC" ? "usdc" : "agu",
              key: a,
              memory: mem.toString(),
              chain: chain.toString(),
            };
      }),
    );
    return (await Promise.all(checks)).filter((r): r is DiffRow => r !== undefined);
  }

  async #claimRows(m: MemoryChain, tokens: string[], holders: Account[]): Promise<DiffRow[]> {
    const hs = holders
      .filter((h) => !isContractAccount(h) || h === RESERVE)
      .filter((h) => this.#addr.has(h));
    const rows = await Promise.all(
      tokens.map(async (t): Promise<DiffRow[]> => {
        const id = this.#claimId(m, t);
        const got = (await this.#read(this.#c.workClaim, "WorkClaim", "balanceOfBatch", [
          hs.map((h) => this.#a(h)),
          hs.map(() => id),
        ])) as readonly bigint[];
        return hs.flatMap((h, i) => {
          const mem = m.claimBalance(h, t);
          const chain = got[i] as bigint;
          return chain === mem
            ? []
            : [
                {
                  what: "claim" as const,
                  key: `${t} @ ${h}`,
                  memory: mem.toString(),
                  chain: chain.toString(),
                },
              ];
        });
      }),
    );
    return rows.flat();
  }

  /** the router's skip and probe flags for each issuer */
  async #routerRows(m: MemoryChain, issuers: Account[]): Promise<DiffRow[]> {
    const rows: DiffRow[] = [];
    for (const x of issuers)
      for (const [flag, set] of [
        ["skipped", m.skipped],
        ["probeOpen", m.probeOpen],
      ] as const) {
        const chain = await this.#read(this.#c.router, "EligibleClaimRouter", flag, [this.#a(x)]);
        if (String(chain) !== String(set.has(x)))
          rows.push({
            what: "router",
            key: `${x} ${flag}`,
            memory: String(set.has(x)),
            chain: String(chain),
          });
      }
    return rows;
  }

  async #compareSome(m: MemoryChain, accounts: Account[], tokens: string[]): Promise<DiffRow[]> {
    return [
      ...(await this.#balanceRows(m, accounts)),
      ...(await this.#claimRows(m, tokens, accounts)),
    ];
  }

  /**
   * Chain against a memory ledger: every account's test USDC and AGU-lab, AGU-lab's supply, every claim balance of every account, the reserve's live face, both escrow contracts'
   * holdings, the bond lots, routing order and flags, the reserve's lots, every escrow's status, and every presentation and settlement memory recorded.
   */
  async compare(m: MemoryChain): Promise<DiffRow[]> {
    await this.#mineAt(m.now());
    const c = this.#c;
    const rows: DiffRow[] = [];
    const row = (what: DiffRow["what"], key: string, mem: unknown, chain: unknown): void => {
      if (String(mem) !== String(chain))
        rows.push({ what, key, memory: String(mem), chain: String(chain) });
    };
    const accounts = [...new Set([...m.usdc.keys(), ...m.agu.keys(), ...this.#addr.keys()])].filter(
      (a) => a !== this.#deployer && a !== this.#publisher,
    );
    rows.push(...(await this.#balanceRows(m, accounts)));
    row(
      "supply",
      "AGU-lab total supply",
      m.aguSupply,
      await this.#read(c.aguLab, "AguLab", "totalSupply", []),
    );
    rows.push(...(await this.#claimRows(m, [...m.claimTypes.keys()], accounts)));
    row(
      "live face",
      "reserve live face, mSIU",
      m.liveFace(),
      await this.#read(c.aguLab, "AguLab", "liveFaceMilli", []),
    );
    for (const asset of ASSETS) {
      const held = [...(asset === "USDC" ? m.usdc : m.agu)]
        .filter(([a]) => a.startsWith("escrow:"))
        .reduce((n, [, v]) => n + v, 0n);
      row(
        "escrow contract",
        `${asset} escrow holdings`,
        held,
        await this.#read(this.#token(asset), this.#tokenAbi(asset), "balanceOf", [
          this.#escrow(asset),
        ]),
      );
    }
    for (const [key, lot] of m.bondLots) {
      const [issuer, classId] = key.split("|") as [Account, string];
      const got = (await this.#read(c.bond, "CapacityBond", "lots", [
        this.#a(issuer),
        idHash(classId),
      ])) as readonly bigint[];
      row("bond lot", `${key} bonded USDC`, lot.bondedUsdc, got[2]);
      row("bond lot", `${key} outstanding mSIU`, lot.outstanding, got[3]);
    }
    const issuers = new Set<Account>();
    for (const [classId, list] of m.issuersForClass) {
      list.forEach((x) => issuers.add(x));
      const got = (await this.#read(c.bond, "CapacityBond", "issuersForClass", [
        idHash(classId),
      ])) as readonly Hex[];
      row(
        "issuers for class",
        classId,
        list.map((x) => this.#a(x).toLowerCase()).join(","),
        got.map((x) => x.toLowerCase()).join(","),
      );
    }
    rows.push(...(await this.#routerRows(m, [...issuers])));
    for (const id of m.reserveLots) {
      const lot = (await this.#read(c.aguLab, "AguLab", "lots", [
        this.#claimId(m, id),
      ])) as readonly unknown[];
      row("reserve lot", `${id} known`, true, lot[0]);
      row("reserve lot", `${id} retired`, m.retired.has(id), lot[1]);
    }
    const status = { open: 1, settled: 2, expired: 3 } as const;
    for (const [id, x] of m.escrows) {
      const rec = (await this.#read(this.#escrow(x.asset), "TouchstoneEscrow", "escrows", [
        idHash(id),
      ])) as readonly unknown[];
      row("escrow", `${id} status`, status[x.status], Number(rec[2]));
    }
    for (const [what, set, fn] of [
      ["presented", m.everPresented, "everPresented"],
      ["settled", m.settledPositions, "settled"],
    ] as const)
      for (const key of set) {
        const [tokenId, holder] = key.split("|") as [string, Account];
        row(
          what,
          key,
          true,
          await this.#read(c.workClaim, "WorkClaim", fn, [
            this.#claimId(m, tokenId),
            this.#a(holder),
          ]),
        );
      }
    return rows;
  }

  /** an empty block at memory's clock, so time-dependent views (live face) are read at the same moment on both sides */
  async #mineAt(t: number): Promise<void> {
    const latest = (await rawRpc(this.#rpcUrl, "eth_getBlockByNumber", ["latest", false])) as {
      timestamp: Hex;
    };
    if (t <= Number(latest.timestamp)) return;
    await rawRpc(this.#rpcUrl, "evm_setNextBlockTimestamp", [t]);
    await rawRpc(this.#rpcUrl, "evm_mine", []);
  }
}

async function rawRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message: string; data?: unknown };
  };
  if (body.error !== undefined) {
    const err = new Error(`${method}: ${body.error.message}`) as Error & { data?: unknown };
    err.data = body.error.data;
    throw err;
  }
  return body.result;
}

/** open, replay, compare, close */
export async function replayOnAnvil(
  memory: MemoryChain,
  opts: { rpcUrl?: string; build?: boolean } = {},
): Promise<ReplayResult> {
  const r = await ChainReplay.open(memory, opts);
  try {
    return await r.replay();
  } finally {
    await r.close();
  }
}

/** DW1's window as DW0 runs it (scripted agents, stand-in worker, memory ledger), ready to replay: the same agents and needs as `dev-window.test.ts` */
export async function scriptedWindows(seed: string, windows: number[]): Promise<World> {
  const t0 = 1_800_000_000 - (1_800_000_000 % 86_400); // a UTC midnight, as DW0 uses
  const params = { ...loadParams(), seed };
  const wp0 = loadCrPrint();
  const sha = standInSha(seed);
  const world = buildWorld({
    params,
    wp0,
    log: new EconomyLog("stand-in"),
    worker: new StandInWorker(seed, passRates(wp0), sha),
    t0,
    dataSha: sha,
  });
  world.genesis();
  world.checkInvariants();
  const agents: Agent[] = [
    new ScriptedAgent("RESEARCH-1", "research", "ISSUER-C1"),
    new ScriptedAgent("RESEARCH-2", "research", "ISSUER-X"),
    new ScriptedAgent("DEMAND-1", "demand"),
    new ScriptedAgent("DEMAND-2", "demand"),
    new ScriptedAgent("DEMAND-3", "demand"),
    new ScriptedAgent("HEDGER", "hedger", "ISSUER-C1"),
  ];
  await runWindows({
    world,
    agents,
    windows,
    needsFor: needsSchedule(
      seed,
      TASKS.filter((t) => t !== "CR-VS"),
    ),
  });
  return world;
}
