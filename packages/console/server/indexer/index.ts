import { createPublicClient, http, type AbiEvent, type Hex, type PublicClient } from "viem";
import type {
  EventCache,
  ExpiredEvent,
  OpenedEvent,
  PrintPostedEvent,
  SettledEvent,
} from "./cache.js";
import { emptyCache } from "./cache.js";

/**
 * The public `sepolia.base.org` endpoint rate-limits in practice — confirmed live while building
 * this indexer (a burst of `getBlock` calls, even batched at 5 concurrent, hit "over rate
 * limit"). Retries with backoff on anything that looks like a rate limit or a transient network
 * failure; anything else (a malformed request) propagates immediately rather than retrying
 * something that can never succeed.
 */
function isRetryableRpcError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // "block range extends beyond current head" (-32602) happens on sepolia.base.org's shared,
  // load-balanced backend: eth_blockNumber and the eth_getLogs it feeds land on different nodes
  // with slightly different sync state, so the toBlock this indexer just computed can briefly
  // be ahead of what the node serving the log query has seen yet. Confirmed live: a manual
  // `cast logs` against the exact failing range reproduced this, and the chain head had already
  // caught up moments later — a real, recurring public-RPC quirk, not a malformed request.
  // "no backend is currently healthy to serve traffic" (-32011) is the same shared endpoint's
  // full-outage message — already seen and confirmed self-resolving on retry earlier in this
  // project's history (verify-onchain.ts, the print measurement run), not unique to this path.
  return /rate limit|429|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH|timeout|block range extends beyond current head|no backend is currently healthy/i.test(
    message,
  );
}

async function withRpcBackoff<T>(fn: () => Promise<T>, maxRetries = 6): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > maxRetries || !isRetryableRpcError(err)) throw err;
      const delayMs = Math.min(500 * 2 ** attempt, 10_000) + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Only the members the indexer actually decodes — `TouchstoneEscrow`'s/`TouchstoneAttestation`'s full
 * ABIs live in `packages/contracts`, outside the pnpm workspace. Same minimal-fragment approach
 * `settlement/on-chain.ts` (mcp-server) already established for point reads; this is the first
 * *historical log scan* anywhere in the repo (every existing on-chain reader only does point
 * `readContract`/single-tx-receipt decodes), so there's no existing scan to copy, only the
 * ABI-fragment style. */
export const TOUCHSTONE_ESCROW_EVENTS_ABI = [
  {
    type: "event",
    name: "Opened",
    inputs: [
      { name: "quoteHash", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "settler", type: "address", indexed: false },
      { name: "maxAmount", type: "uint256", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "quoteHash", type: "bytes32", indexed: true },
      { name: "actualAmount", type: "uint256", indexed: false },
      { name: "receiptRef", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Expired",
    inputs: [
      { name: "quoteHash", type: "bytes32", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export const TOUCHSTONE_ATTESTATION_EVENTS_ABI = [
  {
    type: "event",
    name: "PrintPosted",
    inputs: [
      { name: "bodyHash", type: "bytes32", indexed: true },
      { name: "version", type: "string", indexed: false },
      { name: "timestamp", type: "uint64", indexed: false },
    ],
  },
] as const;

export interface IndexerConfig {
  rpcUrl: string;
  escrowAddress: string;
  escrowDeployBlock: bigint;
  attestationAddress: string;
  attestationDeployBlock: bigint;
  /** eth_getLogs block-range chunk size — kept conservative since public RPC endpoints commonly
   * cap the range per call; verified empirically against the configured RPC during real indexing
   * rather than assumed. */
  chunkSize?: bigint;
}

const DEFAULT_CHUNK_SIZE = 2000n;

interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
}

/** `events` (the ABI's event fragments) is passed straight to viem's `getLogs`, which decodes
 * and filters to exactly those event signatures — no manual `decodeEventLog` loop needed, unlike
 * the point-lookup-by-known-txHash readers elsewhere in the repo, which decode from a single
 * transaction receipt's raw logs instead. */
async function scanRange(
  client: PublicClient,
  address: Hex,
  events: readonly AbiEvent[],
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize: bigint,
): Promise<DecodedLog[]> {
  const results: DecodedLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    const logs = (await withRpcBackoff(() =>
      client.getLogs({ address, events, fromBlock: start, toBlock: end }),
    )) as {
      eventName?: string;
      args?: Record<string, unknown>;
      blockNumber: bigint | null;
      transactionHash: Hex | null;
    }[];
    for (const log of logs) {
      if (!log.blockNumber || !log.transactionHash || !log.eventName || !log.args) {
        continue;
      }
      results.push({
        eventName: log.eventName,
        args: log.args,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
      });
    }
  }
  return results;
}

const TIMESTAMP_BATCH_SIZE = 3;

/** Fetches each unique block's timestamp once, even when several events share a block —
 * batched rather than fully parallel, since firing one `getBlock` per unique block at once
 * hit "over rate limit" against the public `sepolia.base.org` endpoint in practice. */
async function timestampsFor(
  client: PublicClient,
  blockNumbers: bigint[],
): Promise<Map<bigint, string>> {
  const unique = [...new Set(blockNumbers)];
  const map = new Map<bigint, string>();
  for (let i = 0; i < unique.length; i += TIMESTAMP_BATCH_SIZE) {
    const batch = unique.slice(i, i + TIMESTAMP_BATCH_SIZE);
    await Promise.all(
      batch.map(async (bn) => {
        const block = await withRpcBackoff(() => client.getBlock({ blockNumber: bn }));
        map.set(bn, new Date(Number(block.timestamp) * 1000).toISOString());
      }),
    );
  }
  return map;
}

/**
 * Scans new blocks since `cache.lastIndexedBlock` (or each contract's deployment block, if the
 * cache is empty) and merges newly-decoded events in. Resumable and idempotent: re-running with
 * an up-to-date cache does near-zero work (a single `getBlockNumber` plus, at most, one small
 * `getLogs` call per contract for whatever's landed since).
 */
export async function indexNewEvents(
  config: IndexerConfig,
  cache: EventCache = emptyCache(),
): Promise<EventCache> {
  const client = createPublicClient({ transport: http(config.rpcUrl) }) as PublicClient;
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const latest = await withRpcBackoff(() => client.getBlockNumber());

  const escrowAddress = config.escrowAddress as Hex;
  const attestationAddress = config.attestationAddress as Hex;

  const escrowFrom =
    cache.lastIndexedBlock.escrow === "0"
      ? config.escrowDeployBlock
      : BigInt(cache.lastIndexedBlock.escrow) + 1n;
  const attestationFrom =
    cache.lastIndexedBlock.attestation === "0"
      ? config.attestationDeployBlock
      : BigInt(cache.lastIndexedBlock.attestation) + 1n;

  const [feeBps, treasury] =
    cache.escrow.treasury !== emptyCache().escrow.treasury
      ? [BigInt(cache.escrow.feeBps), cache.escrow.treasury as Hex]
      : await Promise.all([
          withRpcBackoff(() =>
            client.readContract({
              address: escrowAddress,
              abi: TOUCHSTONE_ESCROW_EVENTS_ABI,
              functionName: "feeBps",
            }),
          ),
          withRpcBackoff(() =>
            client.readContract({
              address: escrowAddress,
              abi: TOUCHSTONE_ESCROW_EVENTS_ABI,
              functionName: "treasury",
            }),
          ),
        ]);

  const escrowEvents =
    escrowFrom <= latest
      ? await scanRange(
          client,
          escrowAddress,
          TOUCHSTONE_ESCROW_EVENTS_ABI.filter((item) => item.type === "event"),
          escrowFrom,
          latest,
          chunkSize,
        )
      : [];
  const newOpened = escrowEvents
    .filter((e) => e.eventName === "Opened")
    .map((e) => ({ blockNumber: e.blockNumber, txHash: e.transactionHash, args: e.args }));
  const newSettled = escrowEvents
    .filter((e) => e.eventName === "Settled")
    .map((e) => ({ blockNumber: e.blockNumber, txHash: e.transactionHash, args: e.args }));
  const newExpired = escrowEvents
    .filter((e) => e.eventName === "Expired")
    .map((e) => ({ blockNumber: e.blockNumber, txHash: e.transactionHash, args: e.args }));

  const attestationEvents =
    attestationFrom <= latest
      ? await scanRange(
          client,
          attestationAddress,
          TOUCHSTONE_ATTESTATION_EVENTS_ABI,
          attestationFrom,
          latest,
          chunkSize,
        )
      : [];
  const newPrintPosted = attestationEvents
    .filter((e) => e.eventName === "PrintPosted")
    .map((e) => ({ blockNumber: e.blockNumber, txHash: e.transactionHash, args: e.args }));

  const allBlocks = [
    ...newOpened.map((e) => e.blockNumber),
    ...newSettled.map((e) => e.blockNumber),
    ...newExpired.map((e) => e.blockNumber),
  ];
  const timestamps = await timestampsFor(client, allBlocks);

  const opened: OpenedEvent[] = newOpened.map((e) => ({
    quoteHash: e.args.quoteHash as string,
    buyer: e.args.buyer as string,
    seller: e.args.seller as string,
    settler: e.args.settler as string,
    maxAmount: (e.args.maxAmount as bigint).toString(),
    expiry: (e.args.expiry as bigint).toString(),
    blockNumber: e.blockNumber.toString(),
    txHash: e.txHash,
    timestamp: timestamps.get(e.blockNumber) ?? "",
  }));
  const settled: SettledEvent[] = newSettled.map((e) => ({
    quoteHash: e.args.quoteHash as string,
    actualAmount: (e.args.actualAmount as bigint).toString(),
    receiptRef: e.args.receiptRef as string,
    blockNumber: e.blockNumber.toString(),
    txHash: e.txHash,
    timestamp: timestamps.get(e.blockNumber) ?? "",
  }));
  const expired: ExpiredEvent[] = newExpired.map((e) => ({
    quoteHash: e.args.quoteHash as string,
    buyer: e.args.buyer as string,
    amount: (e.args.amount as bigint).toString(),
    blockNumber: e.blockNumber.toString(),
    txHash: e.txHash,
    timestamp: timestamps.get(e.blockNumber) ?? "",
  }));
  const printPosted: PrintPostedEvent[] = newPrintPosted.map((e) => ({
    bodyHash: e.args.bodyHash as string,
    version: e.args.version as string,
    timestamp: new Date(Number(e.args.timestamp as bigint) * 1000).toISOString(),
    blockNumber: e.blockNumber.toString(),
    txHash: e.txHash,
  }));

  return {
    lastIndexedBlock: {
      escrow: (escrowFrom <= latest ? latest : BigInt(cache.lastIndexedBlock.escrow)).toString(),
      attestation: (attestationFrom <= latest
        ? latest
        : BigInt(cache.lastIndexedBlock.attestation)
      ).toString(),
    },
    escrow: { feeBps: feeBps.toString(), treasury },
    events: {
      opened: [...cache.events.opened, ...opened],
      settled: [...cache.events.settled, ...settled],
      expired: [...cache.events.expired, ...expired],
      printPosted: [...cache.events.printPosted, ...printPosted],
    },
  };
}
