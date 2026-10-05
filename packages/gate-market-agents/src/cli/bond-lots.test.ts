import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, erc20Abi, http, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CLASS_CODE, CLASS_EXTRACT, setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { ViemChainReader } from "../chain/reader.js";
import type { AgentId } from "../identity/resolve.js";
import { bondLots, planLots, verifyRegistrationOrder, withBondTxs } from "./bond-lots.js";

type Figures = { hours: number; rate: number; bond: number };
const SINGLE_ISSUER_FIGURES: Record<"ISSUER-A" | "ISSUER-B", Figures> = {
  "ISSUER-B": { hours: 800, rate: 80, bond: 1_000_000 },
  "ISSUER-A": { hours: 800, rate: 120, bond: 1_000_000 },
};

/** A deployment record in the shape the runner and this tool read, over arbitrary addresses. */
function recordFor(
  addresses: Record<"ISSUER-A" | "ISSUER-B", string>,
  figures: Record<"ISSUER-A" | "ISSUER-B", Figures> = SINGLE_ISSUER_FIGURES,
  order: ("ISSUER-A" | "ISSUER-B")[] = ["ISSUER-B", "ISSUER-A"],
  extra: Record<string, unknown> = {},
) {
  const lot = (id: "ISSUER-A" | "ISSUER-B") => ({
    address: addresses[id],
    committedCapacityHours: figures[id].hours,
    measuredRateMilliSiuPerHour: figures[id].rate,
    bondedUsdcPerClass: figures[id].bond,
    issuanceLimitPerClass: (figures[id].hours * figures[id].rate) / 2,
  });
  return {
    instrument: { id: "test-instrument", description: "test" },
    topology: {
      lotCreationOrder: order,
      expectedIssuerByWindow: { 1: order[0], 2: order[1] },
      drain: { afterWindow: 1, issuer: order[0], classId: "code", datedTo: "run_end" },
      routeAfterDrain: order[1],
    },
    capacityLots: {
      classIds: { code: CLASS_CODE, extract: CLASS_EXTRACT },
      "ISSUER-A": lot("ISSUER-A"),
      "ISSUER-B": lot("ISSUER-B"),
    },
    ...extra,
  };
}


// Each lot is an approve and a createLot, each waited on before the next — the order they land in
// IS the routing order, so they are never overlapped. Eight receipts take longer than vitest's
// five-second default, and a timeout here leaves the call running against the chain, so the next
// test sees a half-bonded market. The first version of this file ran inside the default by luck.
const SEQUENTIAL_BONDING_TIMEOUT_MS = 120_000;

const FAKE = {
  "ISSUER-A": "0x000000000000000000000000000000000000000A",
  "ISSUER-B": "0x000000000000000000000000000000000000000B",
} as const;

describe("planLots", () => {
  it("plans each issuer's code then extract lot, in the order the record declares", () => {
    const plan = planLots(recordFor(FAKE));
    expect(plan.map((l) => `${l.issuer}/${l.classLabel}`)).toEqual([
      "ISSUER-B/code",
      "ISSUER-B/extract",
      "ISSUER-A/code",
      "ISSUER-A/extract",
    ]);
  });

  it("computes the issuance limits the plan fixes: B 32,000 and A 48,000 mSIU", () => {
    const plan = planLots(recordFor(FAKE));
    expect(plan.find((l) => l.issuer === "ISSUER-B")?.issuanceLimitMilliSiu).toBe(32_000n);
    expect(plan.find((l) => l.issuer === "ISSUER-A")?.issuanceLimitMilliSiu).toBe(48_000n);
  });

  it("takes the order from the record and nothing else — swapping it swaps the plan", () => {
    // The multi-issuer path stays configuration: nothing in here may know which issuer goes first.
    const swapped = planLots(recordFor(FAKE, SINGLE_ISSUER_FIGURES, ["ISSUER-A", "ISSUER-B"]));
    expect(swapped[0].issuer).toBe("ISSUER-A");
    expect(swapped.at(-1)?.issuer).toBe("ISSUER-B");
  });

  it("refuses a record with no topology rather than inventing an order", () => {
    const noTopology: Record<string, unknown> = { ...recordFor(FAKE) };
    delete noTopology.topology;
    expect(() => planLots(noTopology)).toThrow(/no topology\.lotCreationOrder/);
  });

  it("refuses a record whose own issuance limit disagrees with its inputs", () => {
    const bad = recordFor(FAKE);
    (bad.capacityLots["ISSUER-B"] as { issuanceLimitPerClass: number }).issuanceLimitPerClass = 99_999;
    expect(() => planLots(bad)).toThrow(/32000/);
  });

  it("refuses a missing issuer entry and a zero figure", () => {
    const missing = recordFor(FAKE);
    delete (missing.capacityLots as Record<string, unknown>)["ISSUER-A"];
    expect(() => planLots(missing)).toThrow(/no entry for ISSUER-A/);
    const zero = recordFor(FAKE, { ...SINGLE_ISSUER_FIGURES, "ISSUER-A": { hours: 0, rate: 120, bond: 1 } });
    expect(() => planLots(zero)).toThrow(/zero lot figure/);
  });
});

describe("verifyRegistrationOrder", () => {
  const [b, a] = ["0xb", "0xa"];
  it("accepts the declared order, and any prefix of it (a half-finished bonding)", () => {
    expect(verifyRegistrationOrder([b, a], [b, a]).ok).toBe(true);
    expect(verifyRegistrationOrder([b], [b, a]).ok).toBe(true);
    expect(verifyRegistrationOrder([], [b, a]).ok).toBe(true);
  });
  it("rejects the wrong order — the list is append-only, so it cannot be repaired", () => {
    const r = verifyRegistrationOrder([a, b], [b, a]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/position 1/);
  });
  it("rejects an issuer the record does not declare, because first-fit would route to it", () => {
    expect(verifyRegistrationOrder(["0xc", b], [b, a]).ok).toBe(false);
  });
  it("compares addresses case-insensitively", () => {
    expect(verifyRegistrationOrder(["0xAB"], ["0xab"]).ok).toBe(true);
  });
});

describe("withBondTxs", () => {
  it("writes each created lot's transactions beside it and leaves untouched lots alone", () => {
    const rec = recordFor(FAKE);
    const out = withBondTxs(rec, [
      { issuer: "ISSUER-B", classLabel: "code", status: "created", approveTx: "0xa1", createLotTx: "0xc1" },
      { issuer: "ISSUER-A", classLabel: "code", status: "already_bonded" },
    ]);
    const lots = (out as { capacityLots: Record<string, { bondTransactions?: unknown }> }).capacityLots;
    expect(lots["ISSUER-B"].bondTransactions).toEqual({ code: { approve: "0xa1", createLot: "0xc1" } });
    expect(lots["ISSUER-A"].bondTransactions).toBeUndefined();
  });
});

describe("bondLots on real bytecode — a deployment with no lots", () => {
  let devnet: DevnetHandle;
  let reader: ViemChainReader;
  let blockNumber: () => Promise<bigint>;

  const addr = (id: AgentId): Hex => devnet.agents[id].address;
  const addresses = () => ({ "ISSUER-A": addr("ISSUER-A"), "ISSUER-B": addr("ISSUER-B") });
  const keyFor = (issuer: string): Hex => devnet.agents[issuer as AgentId].privateKeyHex;
  const input = (record: ReturnType<typeof recordFor>, dryRun: boolean, keys = keyFor) => ({
    plan: planLots(record),
    capacityBond: devnet.deployment.capacityBond.address as Hex,
    usdc: devnet.deployment.usdc.address as Hex,
    rpcUrl: devnet.rpcUrl,
    keyFor: keys,
    dryRun,
  });

  beforeAll(async () => {
    // `lotCreationOrder: []` is the devnet's own way of saying "deploy, but bond nothing".
    devnet = await setupDevnet({ lotCreationOrder: [] });
    reader = new ViemChainReader(devnet.deployment, devnet.rpcUrl);
    const pc = createPublicClient({ transport: http(devnet.rpcUrl) });
    blockNumber = () => pc.getBlockNumber();
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  const registered = async () => (await reader.issuersForClass(CLASS_CODE as Hex)).map((a) => a.toLowerCase());

  it("starts with nothing registered", async () => {
    expect(await registered()).toEqual([]);
  });

  it("sends nothing by default: a dry run reads and simulates, and mines no block", async () => {
    const before = await blockNumber();
    const results = await bondLots(input(recordFor(addresses()), true));
    expect(results.every((r) => r.status === "would_create")).toBe(true);
    expect(results.some((r) => r.approveTx || r.createLotTx)).toBe(false);
    expect(await blockNumber()).toBe(before);
    expect(await registered()).toEqual([]);
  });

  it("defaults to a dry run when the caller says nothing about it — broadcasting is always asked for", async () => {
    const before = await blockNumber();
    const withoutDryRun: Partial<ReturnType<typeof input>> = input(recordFor(addresses()), false);
    delete withoutDryRun.dryRun;
    const results = await bondLots(withoutDryRun as ReturnType<typeof input>);
    expect(results.every((r) => r.status === "would_create")).toBe(true);
    expect(await blockNumber()).toBe(before);
  });

  it("refuses a key that does not control the address the record names, before sending anything", async () => {
    const before = await blockNumber();
    await expect(
      bondLots(input(recordFor(addresses()), false, () => devnet.agents.ORCHESTRATOR.privateKeyHex)),
    ).rejects.toThrow(/controls .* but the record names/);
    expect(await blockNumber()).toBe(before);
  });

  it("refuses an issuer that cannot fund its bonds, before sending anything", async () => {
    const before = await blockNumber();
    const broke = recordFor(addresses(), {
      ...SINGLE_ISSUER_FIGURES,
      "ISSUER-B": { hours: 800, rate: 80, bond: 10 ** 15 },
    });
    await expect(bondLots(input(broke, false))).rejects.toThrow(/needs/);
    expect(await blockNumber()).toBe(before);
    expect(await registered()).toEqual([]);
  });

  it("bonds B then A, and the real router then routes to B — registration order is routing priority", async () => {
    const results = await bondLots(input(recordFor(addresses()), false));
    expect(results.map((r) => `${r.issuer}/${r.classLabel}:${r.status}`)).toEqual([
      "ISSUER-B/code:created",
      "ISSUER-B/extract:created",
      "ISSUER-A/code:created",
      "ISSUER-A/extract:created",
    ]);
    expect(results.every((r) => r.createLotTx !== undefined)).toBe(true);

    expect(await registered()).toEqual([addr("ISSUER-B").toLowerCase(), addr("ISSUER-A").toLowerCase()]);
    expect(await reader.headroom(addr("ISSUER-B"), CLASS_CODE as Hex)).toBe(32_000n);
    expect(await reader.headroom(addr("ISSUER-A"), CLASS_CODE as Hex)).toBe(48_000n);
    // The decision the whole instrument rests on, read from the real router.
    expect((await reader.routeFor(CLASS_CODE as Hex, 10_000n))?.toLowerCase()).toBe(addr("ISSUER-B").toLowerCase());
  }, SEQUENTIAL_BONDING_TIMEOUT_MS);

  it("is idempotent: running it again changes nothing and sends nothing", async () => {
    const before = await blockNumber();
    const results = await bondLots(input(recordFor(addresses()), false));
    expect(results.every((r) => r.status === "already_bonded")).toBe(true);
    expect(results.some((r) => r.approveTx || r.createLotTx)).toBe(false);
    expect(await blockNumber()).toBe(before);
    expect(await registered()).toEqual([addr("ISSUER-B").toLowerCase(), addr("ISSUER-A").toLowerCase()]);
  }, SEQUENTIAL_BONDING_TIMEOUT_MS);

  it("refuses a record whose figures differ from a lot already on chain, and leaves the lot alone", async () => {
    const before = await blockNumber();
    const changed = recordFor(addresses(), { ...SINGLE_ISSUER_FIGURES, "ISSUER-B": { hours: 900, rate: 80, bond: 1_000_000 } });
    await expect(bondLots(input(changed, false))).rejects.toThrow(/already has a code lot with different figures/);
    expect(await blockNumber()).toBe(before);
    expect(await reader.headroom(addr("ISSUER-B"), CLASS_CODE as Hex)).toBe(32_000n);
  });
});

describe("bondLots on real bytecode — a deployment already registered in the wrong order", () => {
  let devnet: DevnetHandle;
  let reader: ViemChainReader;

  beforeAll(async () => {
    // A registered first, with figures the record below will state exactly — so the ONLY thing
    // wrong is the order, which is the failure this tool exists to catch.
    devnet = await setupDevnet({
      lotCreationOrder: ["ISSUER-A"],
      lotHours: { "ISSUER-A": { code: 800n, extract: 800n } },
    });
    reader = new ViemChainReader(devnet.deployment, devnet.rpcUrl);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("refuses to bond B behind A, and sends nothing, because the list is append-only", async () => {
    const record = recordFor(
      { "ISSUER-A": devnet.agents["ISSUER-A"].address, "ISSUER-B": devnet.agents["ISSUER-B"].address },
      {
        "ISSUER-A": { hours: 800, rate: 100, bond: 500_000_000 },
        "ISSUER-B": { hours: 800, rate: 80, bond: 1_000_000 },
      },
    );
    await expect(
      bondLots({
        plan: planLots(record),
        capacityBond: devnet.deployment.capacityBond.address as Hex,
        usdc: devnet.deployment.usdc.address as Hex,
        rpcUrl: devnet.rpcUrl,
        keyFor: (issuer) => devnet.agents[issuer as AgentId].privateKeyHex,
        dryRun: false,
      }),
    ).rejects.toThrow(/registration position 1/);
    expect((await reader.issuersForClass(CLASS_CODE as Hex)).map((a) => a.toLowerCase())).toEqual([
      devnet.agents["ISSUER-A"].address.toLowerCase(),
    ]);
    expect(await reader.headroom(devnet.agents["ISSUER-B"].address, CLASS_CODE as Hex)).toBe(0n);
  }, SEQUENTIAL_BONDING_TIMEOUT_MS);
});

/**
 * A JSON-RPC proxy that behaves like a lagging node behind a load balancer: for the next
 * `staleCalls` `eth_call`s after every transaction it serves the state as of the block BEFORE that
 * transaction. This is the sixth documented instance of the stale-read pattern, and the first one
 * to be reproduced rather than only described — the receipt confirms, and the very next read still
 * shows the old world.
 */
async function startStaleProxy(upstream: string, staleCalls: number, onlySelector?: string) {
  let staleBlock: string | undefined;
  let remaining = 0;
  /** `eth_call`s whose calldata starts with `onlySelector`, since the last transaction. */
  let matchingSinceWrite = 0;
  const forward = async (body: unknown): Promise<{ result?: string }> =>
    (
      await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json() as Promise<{ result?: string }>;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(body)) {
        if (body.method === "eth_sendRawTransaction") {
          staleBlock = (await forward({ jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] })).result;
          remaining = staleCalls;
          matchingSinceWrite = 0;
        } else if (body.method === "eth_call") {
          const data: string = body.params[0].data ?? body.params[0].input ?? "";
          const matches = onlySelector === undefined || data.startsWith(onlySelector);
          if (matches) matchingSinceWrite += 1;
          if (matches && remaining > 0 && staleBlock !== undefined) {
            body.params = [body.params[0], staleBlock];
            remaining -= 1;
          }
        }
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(await forward(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    matchingSinceWrite: () => matchingSinceWrite,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("bondLots against a node that serves a stale view after every write", () => {
  let devnet: DevnetHandle;
  let proxy: Awaited<ReturnType<typeof startStaleProxy>>;
  let reader: ViemChainReader;

  beforeAll(async () => {
    devnet = await setupDevnet({ lotCreationOrder: [] });
    proxy = await startStaleProxy(devnet.rpcUrl, 3);
    reader = new ViemChainReader(devnet.deployment, devnet.rpcUrl); // the REAL node, bypassing the proxy
  }, 180_000);

  afterAll(async () => {
    await proxy.close();
    await devnet.stop();
  });

  it("the proxy really is stale: a read right after a confirmed write shows the old state, then catches up", async () => {
    // Without this, the test below could pass against a proxy that never lagged at all.
    const issuer = devnet.agents["ISSUER-A"];
    const account = privateKeyToAccount(issuer.privateKeyHex);
    const wallet = createWalletClient({ account, transport: http(proxy.url) });
    const pc = createPublicClient({ transport: http(proxy.url) });
    const usdc = devnet.deployment.usdc.address as Hex;
    const spender = devnet.deployment.capacityBond.address as Hex;
    const hash = await wallet.writeContract({ account, chain: undefined, address: usdc, abi: erc20Abi, functionName: "approve", args: [spender, 7n] });
    await pc.waitForTransactionReceipt({ hash });
    const read = () => pc.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, spender] });
    expect(await read()).toBe(0n); // confirmed, and still invisible
    await read();
    await read();
    expect(await read()).toBe(7n); // caught up
  }, 60_000);

  it("waits for each effect to be visible instead of simulating against the pre-write state", async () => {
    const record = recordFor({
      "ISSUER-A": devnet.agents["ISSUER-A"].address,
      "ISSUER-B": devnet.agents["ISSUER-B"].address,
    });
    const results = await bondLots({
      plan: planLots(record),
      capacityBond: devnet.deployment.capacityBond.address as Hex,
      usdc: devnet.deployment.usdc.address as Hex,
      rpcUrl: proxy.url,
      keyFor: (issuer) => devnet.agents[issuer as AgentId].privateKeyHex,
      dryRun: false,
      pollMs: 25,
    });
    expect(results.every((r) => r.status === "created")).toBe(true);
    expect((await reader.issuersForClass(CLASS_CODE as Hex)).map((a) => a.toLowerCase())).toEqual([
      devnet.agents["ISSUER-B"].address.toLowerCase(),
      devnet.agents["ISSUER-A"].address.toLowerCase(),
    ]);
  }, SEQUENTIAL_BONDING_TIMEOUT_MS);
});

describe("bondLots when only the registration list lags", () => {
  let devnet: DevnetHandle;
  let proxy: Awaited<ReturnType<typeof startStaleProxy>>;
  const STALE_READS = 3;

  beforeAll(async () => {
    devnet = await setupDevnet({ lotCreationOrder: [] });
    // Stale ONLY for `issuersForClass`, so every earlier wait sees a fresh node and reaches the
    // final check with the proxy still lagging. The list a stale node serves is a valid PREFIX of
    // the declared order — the one answer a prefix-tolerant check would accept as success.
    proxy = await startStaleProxy(devnet.rpcUrl, STALE_READS, toFunctionSelector("issuersForClass(bytes32)"));
  }, 180_000);

  afterAll(async () => {
    await proxy.close();
    await devnet.stop();
  });

  it("does not report success on a stale prefix: it reads the list until the FULL declared order shows", async () => {
    const record = recordFor({
      "ISSUER-A": devnet.agents["ISSUER-A"].address,
      "ISSUER-B": devnet.agents["ISSUER-B"].address,
    });
    await bondLots({
      plan: planLots(record),
      capacityBond: devnet.deployment.capacityBond.address as Hex,
      usdc: devnet.deployment.usdc.address as Hex,
      rpcUrl: proxy.url,
      keyFor: (issuer) => devnet.agents[issuer as AgentId].privateKeyHex,
      dryRun: false,
      pollMs: 25,
    });
    // Since the LAST transaction the tool read the list at least STALE_READS + 1 times: the stale
    // ones, then one that was fresh. A single read — accepted on sight — would show 1.
    expect(proxy.matchingSinceWrite()).toBeGreaterThan(STALE_READS);
  }, SEQUENTIAL_BONDING_TIMEOUT_MS);
});
