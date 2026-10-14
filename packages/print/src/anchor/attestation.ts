import { retryUntilConclusive, type RetryUntilConclusiveOptions } from "@touchstone/sdk";

/**
 * build1-spec.md §6 Signing: "call TouchstoneAttestation.postPrint(bodyHash, version) on Base so
 * the hash is timestamped by a third party."
 *
 * `TouchstoneAttestation` is now deployed (see data/deployments/base-sepolia.json), so
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

/** Alias kept for every existing caller/import of this name — the retry logic itself now lives
 * in `@touchstone/sdk`'s `retryUntilConclusive`, shared with `@touchstone/agents`' escrow reads. */
export type ReadRetryOptions = RetryUntilConclusiveOptions;

/**
 * Reads `postedAt`, retrying while it reads zero — see `@touchstone/sdk`'s `retryUntilConclusive` for
 * why: trusting a single read immediately after a transaction was mined is what made an earlier
 * version of this code send a second, duplicate transaction on the very next run.
 */
export async function readPostedAtWithRetry(
  chain: AttestationChain,
  bodyHash: string,
  options: ReadRetryOptions = {},
): Promise<bigint> {
  return retryUntilConclusive(
    () => chain.readPostedAt(bodyHash),
    (seen) => seen > 0n,
    options,
  );
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
        "No TouchstoneAttestation address was configured for this run, so no on-chain call was made.",
    };
  }
}

// ---- Anchoring on a further chain (Arc Testnet): best-effort, never blocking ------------------------------------------------------------------------------

/** One entry of a print's `anchor.additional_anchors` (print.schema.json). */
export interface AdditionalAnchor {
  chain: string;
  status: "anchored" | "already-anchored" | "failed" | "skipped";
  tx_hash?: string;
  posted_at?: string;
  notes?: string;
}

/** A further chain a print is anchored on in addition to the one it must be anchored on to publish. */
export interface SecondaryAttestation {
  chainName: string;
  client: AttestationClient;
  /** No answer within this long is recorded as a failure rather than waited for. A transaction that lands late is picked up as already-anchored on a later run. */
  timeoutMs?: number;
}

/** How long a further chain gets before its anchor is recorded as failed and the print goes on without it. */
export const DEFAULT_SECONDARY_TIMEOUT_MS = 90_000;
const NOTES_LIMIT = 300;

/** Thrown by a client that has decided, before sending, not to anchor (for example the publisher's balance on that chain is too low). Recorded as `skipped`, with its reason. */
export class AnchorSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AnchorSkipped";
  }
}

/**
 * Any URL in an error message, shortened to its host. RPC providers put the access key inside the URL, and viem's errors quote the URL they called: a message that
 * reached a print file, the repository or a log would publish the key.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/([^\s/"'<>)]+)[^\s"'<>)]*/gi, "$1/<redacted>");
}

/** The first line of an error, URLs redacted, cut to a length a print file can carry. */
export function describeFailure(err: unknown): string {
  const short = typeof err === "object" && err !== null && "shortMessage" in err && typeof (err as { shortMessage: unknown }).shortMessage === "string" ? (err as { shortMessage: string }).shortMessage : undefined;
  const raw = short ?? (err instanceof Error ? err.message : String(err));
  const first = redactUrls(raw.split("\n")[0]).trim();
  return first.length > NOTES_LIMIT ? `${first.slice(0, NOTES_LIMIT)}…` : first;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no confirmation within ${Math.round(ms / 1000)}s; if the transaction lands later the next run records it as already anchored`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Anchors on a further chain without ever throwing: whatever happens is recorded as the anchor's status and the caller goes on. The print must publish on its
 * required chain; this chain adds to it and is allowed to be down, unfunded or slow. The reason is recorded in the print, URL-free, so a reader sees why.
 */
export async function anchorBestEffort(secondary: SecondaryAttestation, bodyHash: string, version: string): Promise<AdditionalAnchor> {
  try {
    const result = await withTimeout(secondary.client.postPrint(bodyHash, version), secondary.timeoutMs ?? DEFAULT_SECONDARY_TIMEOUT_MS);
    if (result.status === "stub") return { chain: secondary.chainName, status: "skipped", notes: "no chain call was made" };
    return {
      chain: secondary.chainName,
      status: result.status,
      ...(result.tx_hash !== undefined ? { tx_hash: result.tx_hash } : {}),
      ...(result.posted_at !== undefined ? { posted_at: result.posted_at } : {}),
      ...(result.notes !== undefined ? { notes: describeFailure(result.notes) } : {}),
    };
  } catch (err) {
    return { chain: secondary.chainName, status: err instanceof AnchorSkipped ? "skipped" : "failed", notes: describeFailure(err) };
  }
}

/**
 * Tries each client in turn and returns the first that does not throw. Used for a chain with two RPC endpoints: if the first provider is down the second is used.
 * Safe against a double send, because a client's own idempotent anchoring reads `postedAt` first: if the first send did land before its provider failed, the
 * second client finds the hash already anchored and sends nothing.
 */
export class FallbackAttestationClient implements AttestationClient {
  constructor(private readonly clients: readonly AttestationClient[]) {
    if (clients.length === 0) throw new Error("FallbackAttestationClient needs at least one client");
  }

  async postPrint(bodyHash: string, version: string): Promise<AnchorResult> {
    let last: unknown;
    for (const client of this.clients) {
      try {
        return await client.postPrint(bodyHash, version);
      } catch (err) {
        if (err instanceof AnchorSkipped) throw err;
        last = err;
      }
    }
    throw last;
  }
}

/** A client that anchors nothing and says why: recorded as `skipped`. */
export class SkippingAttestationClient implements AttestationClient {
  constructor(private readonly reason: string) {}
  async postPrint(): Promise<AnchorResult> {
    throw new AnchorSkipped(this.reason);
  }
}

