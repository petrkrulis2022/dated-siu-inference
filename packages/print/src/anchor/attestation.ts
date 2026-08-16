/**
 * build1-spec.md §6 Signing: "call DatumAttestation.postPrint(bodyHash, version) on Base so
 * the hash is timestamped by a third party."
 *
 * `DatumAttestation` is now deployed (see data/deployments/base-sepolia.json), so
 * `OnChainAttestationClient` in ./on-chain.ts is the real implementation. `StubAttestationClient`
 * remains for tests and for running the pipeline with no chain configured.
 */
export interface AnchorResult {
  chain: string;
  /**
   * - `anchored`        — this run submitted the transaction that recorded the hash.
   * - `already-anchored`— the hash was already on-chain before this run, so nothing was sent.
   *   Publication treats this as success: re-running after a client dropped mid-flight must not
   *   be blocked by work that already landed. There is deliberately no `tx_hash` on this branch,
   *   because the transaction that did the anchoring belonged to an earlier run and this code
   *   has not seen it — inventing one would misrepresent the record.
   * - `stub`            — no chain call was made at all.
   * - `failed`          — a chain call was attempted and did not land.
   */
  status: "anchored" | "already-anchored" | "stub" | "failed";
  tx_hash?: string;
  posted_at?: string;
  notes?: string;
}

export interface AttestationClient {
  postPrint(bodyHash: string, version: string): Promise<AnchorResult>;
}

/**
 * The two chain operations anchoring needs, separated from any particular chain library so the
 * idempotency decision below can be unit-tested without a network.
 */
export interface AttestationChain {
  /** Unix seconds the hash was anchored at, or 0 if it never was. */
  readPostedAt(bodyHash: string): Promise<bigint>;
  /** Submits postPrint and resolves once mined, returning the transaction hash. */
  sendPostPrint(bodyHash: string, version: string): Promise<string>;
}

/** Thrown by an AttestationChain when the contract rejected the send with AlreadyPosted(). */
export const ALREADY_POSTED_SELECTOR = "0xe9f155db";

export function isAlreadyPostedError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message}${err.cause ? ` ${String(err.cause)}` : ""}`
      : String(err);
  return text.includes(ALREADY_POSTED_SELECTOR) || text.includes("AlreadyPosted");
}

function isoFromUnixSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

export interface ReadRetryOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Reads `postedAt`, retrying while it reads zero.
 *
 * Public RPC endpoints are load-balanced across nodes at slightly different heights, so a read
 * issued immediately after a transaction was mined can be served by a node that has not yet
 * caught up and will answer 0. Trusting that single read is what made an earlier version of
 * this code send a second, duplicate transaction on the very next run — the exact failure this
 * function exists to prevent. Only a non-zero answer is conclusive; zero is retried.
 */
export async function readPostedAtWithRetry(
  chain: AttestationChain,
  bodyHash: string,
  options: ReadRetryOptions = {},
): Promise<bigint> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1500;

  let seen = 0n;
  for (let i = 0; i < attempts; i++) {
    seen = await chain.readPostedAt(bodyHash);
    if (seen > 0n) return seen;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return seen;
}

/**
 * Anchors `bodyHash`, treating an already-anchored hash as success rather than an error.
 *
 * Two things can make a hash already present, and both are handled:
 *
 *  1. A previous run anchored it and the client died before recording the result — the read
 *     below finds it and returns `already-anchored` without sending anything. This is the case
 *     that matters operationally: a dropped client after a landed transaction must not
 *     permanently block re-publishing that print.
 *  2. Someone anchored it between this run's read and its send. The read cannot prevent that
 *     race, so the `AlreadyPosted()` revert is caught and converted to the same outcome. Relying
 *     on the read alone would leave a window where a re-run still fails.
 *
 * Note this is idempotent on the *body hash*, which is exactly the right key: the hash is
 * derived from the print's content, so "already anchored" always means this same print, never a
 * different one that happens to share an identifier.
 */
export async function anchorIdempotently(
  chain: AttestationChain,
  chainName: string,
  bodyHash: string,
  version: string,
  retry: ReadRetryOptions = {},
): Promise<AnchorResult> {
  const existing = await chain.readPostedAt(bodyHash);
  if (existing > 0n) {
    return {
      chain: chainName,
      status: "already-anchored",
      posted_at: isoFromUnixSeconds(existing),
      notes:
        "This body hash was already anchored on-chain before this run; no transaction was sent. " +
        "The anchoring transaction belongs to an earlier run and is not recorded here.",
    };
  }

  let txHash: string;
  try {
    txHash = await chain.sendPostPrint(bodyHash, version);
  } catch (err) {
    // The contract's state is the source of truth, not the transaction's outcome. Whatever went
    // wrong with the send, if the hash is anchored now then the print is anchored and the run
    // has succeeded — that covers the AlreadyPosted race and any revert whose reason this code
    // cannot decode. Only if nothing is anchored is this a real failure worth surfacing.
    const postedAt = await readPostedAtWithRetry(chain, bodyHash, retry);
    if (postedAt > 0n) {
      return {
        chain: chainName,
        status: "already-anchored",
        posted_at: isoFromUnixSeconds(postedAt),
        notes: isAlreadyPostedError(err)
          ? "The hash was anchored between this run's read and its send, so the transaction " +
            "reverted with AlreadyPosted(). Treated as success — the print is anchored either way."
          : "The send failed but the hash is anchored on-chain, so an earlier or concurrent " +
            "transaction recorded it. Treated as success.",
      };
    }
    throw err;
  }

  // A mined transaction is not necessarily a successful one, and `postedAt` is the only
  // authority on whether the anchor actually exists. Reporting `anchored` off the back of a
  // transaction hash alone would publish a print claiming an anchor for a reverted transaction.
  const postedAt = await readPostedAtWithRetry(chain, bodyHash, retry);
  if (postedAt === 0n) {
    return {
      chain: chainName,
      status: "failed",
      tx_hash: txHash,
      notes:
        "The transaction was submitted but the contract does not report this hash as anchored. " +
        "The print is published without a valid anchor; investigate before relying on it.",
    };
  }

  return {
    chain: chainName,
    status: "anchored",
    tx_hash: txHash,
    posted_at: isoFromUnixSeconds(postedAt),
  };
}

/**
 * Returns a result that is honestly labelled as not a real anchor — `status: "stub"`, no
 * `tx_hash`. A stub that fabricated a plausible-looking hash would be indistinguishable from
 * a real anchor to anyone reading the print file, which is worse than no anchor at all.
 */
export class StubAttestationClient implements AttestationClient {
  // Deliberately fewer parameters than AttestationClient's signature — a stub that never
  // calls a chain has no use for bodyHash or version, and TS structurally allows an
  // implementation to accept fewer arguments than the interface declares.
  async postPrint(): Promise<AnchorResult> {
    return {
      chain: "base",
      status: "stub",
      posted_at: new Date().toISOString(),
      notes:
        "No DatumAttestation address was configured for this run, so no on-chain call was made.",
    };
  }
}
