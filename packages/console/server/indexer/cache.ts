import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface OpenedEvent {
  quoteHash: string;
  buyer: string;
  seller: string;
  settler: string;
  maxAmount: string;
  expiry: string;
  blockNumber: string;
  txHash: string;
  timestamp: string;
}

export interface SettledEvent {
  quoteHash: string;
  actualAmount: string;
  receiptRef: string;
  blockNumber: string;
  txHash: string;
  timestamp: string;
}

export interface ExpiredEvent {
  quoteHash: string;
  buyer: string;
  amount: string;
  blockNumber: string;
  txHash: string;
  timestamp: string;
}

export interface PrintPostedEvent {
  bodyHash: string;
  version: string;
  timestamp: string;
  blockNumber: string;
  txHash: string;
}

export interface EventCache {
  /** The last block successfully scanned per contract, so a re-run resumes rather than
   * re-scanning from the deployment block every time. */
  lastIndexedBlock: {
    escrow: string;
    attestation: string;
  };
  escrow: {
    feeBps: string;
    treasury: string;
  };
  events: {
    opened: OpenedEvent[];
    settled: SettledEvent[];
    expired: ExpiredEvent[];
    printPosted: PrintPostedEvent[];
  };
}

export function emptyCache(): EventCache {
  return {
    lastIndexedBlock: { escrow: "0", attestation: "0" },
    escrow: { feeBps: "0", treasury: "0x0000000000000000000000000000000000000000" },
    events: { opened: [], settled: [], expired: [], printPosted: [] },
  };
}

export async function loadCache(path: string): Promise<EventCache> {
  return await readFile(path, "utf-8")
    .then((raw) => JSON.parse(raw) as EventCache)
    .catch(() => emptyCache());
}

export async function writeCache(path: string, cache: EventCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
}
