import { describe, expect, it, vi } from "vitest";
import {
  anchorIdempotently,
  isAlreadyPostedError,
  readPostedAtWithRetry,
  ALREADY_POSTED_SELECTOR,
  type AttestationChain,
} from "./attestation.js";

/** Retries are made instant so these tests don't sleep. */
const FAST = { attempts: 3, delayMs: 0 };

const HASH = `0x${"ab".repeat(32)}`;
const VERSION = "SIU-2026a";

function chainStub(over: Partial<AttestationChain> = {}): AttestationChain {
  return {
    readPostedAt: async () => 0n,
    sendPostPrint: async () => `0x${"11".repeat(32)}`,
    ...over,
  };
}

describe("anchorIdempotently", () => {
  it("anchors normally when the hash has never been posted", async () => {
    const send = vi.fn(async () => `0x${"22".repeat(32)}`);
    let posted = 0n;
    const chain = chainStub({
      readPostedAt: async () => posted,
      sendPostPrint: async (h, v) => {
        posted = 1786862412n;
        return send(h, v);
      },
    });

    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.status).toBe("anchored");
    expect(result.tx_hash).toBe(`0x${"22".repeat(32)}`);
    expect(result.posted_at).toBe("2026-08-16T06:40:12.000Z");
    expect(send).toHaveBeenCalledOnce();
  });

  /**
   * The case the whole feature exists for: a previous run's transaction landed but the client
   * died before recording it. Re-running must succeed and must not send a second transaction.
   */
  it("treats an already-anchored hash as success and sends nothing", async () => {
    const send = vi.fn(async () => `0x${"33".repeat(32)}`);
    const chain = chainStub({ readPostedAt: async () => 1786862412n, sendPostPrint: send });

    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.status).toBe("already-anchored");
    expect(send).not.toHaveBeenCalled();
    expect(result.posted_at).toBe("2026-08-16T06:40:12.000Z");
  });

  /** Never fabricate a transaction hash for work this run did not do. */
  it("omits tx_hash when the anchoring transaction belonged to an earlier run", async () => {
    const chain = chainStub({ readPostedAt: async () => 1786862412n });
    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.tx_hash).toBeUndefined();
  });

  /**
   * The read cannot close the race on its own — another party can anchor between this run's
   * read and its send. Without this branch a re-run would still fail in that window.
   */
  it("converts an AlreadyPosted revert into success (read/send race)", async () => {
    let reads = 0;
    const chain = chainStub({
      readPostedAt: async () => {
        reads += 1;
        return reads === 1 ? 0n : 1786862412n; // absent on first read, present after the race
      },
      sendPostPrint: async () => {
        throw new Error(`execution reverted, data: "${ALREADY_POSTED_SELECTOR}"`);
      },
    });

    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.status).toBe("already-anchored");
    expect(result.posted_at).toBe("2026-08-16T06:40:12.000Z");
    expect(result.notes).toMatch(/between this run's read and its send/);
  });

  it("still propagates unrelated failures rather than silently reporting success", async () => {
    const chain = chainStub({
      sendPostPrint: async () => {
        throw new Error("insufficient funds for gas");
      },
    });
    await expect(anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST)).rejects.toThrow(
      /insufficient funds/,
    );
  });

  it("is idempotent across repeated runs — a second call sends nothing more", async () => {
    let posted = 0n;
    const send = vi.fn(async () => {
      posted = 1786862412n;
      return `0x${"44".repeat(32)}`;
    });
    const chain = chainStub({ readPostedAt: async () => posted, sendPostPrint: send });

    const first = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    const second = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    const third = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);

    expect(first.status).toBe("anchored");
    expect(second.status).toBe("already-anchored");
    expect(third.status).toBe("already-anchored");
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("isAlreadyPostedError", () => {
  it("recognises the raw selector a node returns", () => {
    expect(isAlreadyPostedError(new Error(`reverted, data: "${ALREADY_POSTED_SELECTOR}"`))).toBe(
      true,
    );
  });

  it("recognises a decoded error name", () => {
    expect(isAlreadyPostedError(new Error("execution reverted: AlreadyPosted()"))).toBe(true);
  });

  it("does not misclassify an unrelated revert", () => {
    expect(isAlreadyPostedError(new Error("execution reverted: NotPublisher()"))).toBe(false);
    expect(isAlreadyPostedError(new Error("nonce too low"))).toBe(false);
  });
});

/**
 * Both of these reproduce bugs found only by running against a live chain — the unit tests
 * above passed throughout, because a hand-written fake chain is perfectly self-consistent in a
 * way a load-balanced RPC endpoint and a real EVM are not.
 */
describe("regressions found on live Base Sepolia", () => {
  it("does not report a reverted transaction as anchored", async () => {
    // viem's waitForTransactionReceipt resolves for reverted transactions too, so the on-chain
    // client throws on a non-success receipt. If nothing ended up anchored, that must surface
    // as a failure rather than a published anchor for a transaction that did nothing.
    const chain = chainStub({
      readPostedAt: async () => 0n,
      sendPostPrint: async () => {
        throw new Error(
          'postPrint transaction 0xdead reverted on-chain (receipt status "reverted")',
        );
      },
    });
    await expect(anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST)).rejects.toThrow(
      /reverted on-chain/,
    );
  });

  it("reports failed, not anchored, when a send succeeds but the contract shows nothing", async () => {
    const chain = chainStub({
      readPostedAt: async () => 0n,
      sendPostPrint: async () => `0x${"55".repeat(32)}`,
    });
    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.status).toBe("failed");
    expect(result.posted_at).toBeUndefined();
    expect(result.tx_hash).toBe(`0x${"55".repeat(32)}`);
  });

  it("treats a revert as success when the hash turns out to be anchored anyway", async () => {
    // Covers the case where the revert reason cannot be decoded: state, not the transaction
    // outcome, decides.
    const chain = chainStub({
      readPostedAt: (() => {
        let n = 0;
        return async () => (n++ === 0 ? 0n : 1786862412n);
      })(),
      sendPostPrint: async () => {
        throw new Error("some undecodable revert");
      },
    });
    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.status).toBe("already-anchored");
    expect(result.notes).toMatch(/anchored on-chain, so an earlier or concurrent/);
  });

  it("tolerates RPC read lag right after a send instead of re-sending next run", async () => {
    // The read immediately after a mined transaction was served by a lagging node and answered
    // 0, so posted_at fell back to wall-clock and the next run re-sent. Retrying until the read
    // is conclusive is what prevents the duplicate transaction.
    let reads = 0;
    const chain = chainStub({
      readPostedAt: async () => {
        reads += 1;
        return reads <= 2 ? 0n : 1786862412n; // lagging node answers 0 twice
      },
      sendPostPrint: async () => `0x${"66".repeat(32)}`,
    });
    const result = await anchorIdempotently(chain, "base-sepolia", HASH, VERSION, FAST);
    expect(result.status).toBe("anchored");
    expect(result.posted_at).toBe("2026-08-16T06:40:12.000Z");
  });
});

describe("readPostedAtWithRetry", () => {
  it("returns the first conclusive non-zero answer", async () => {
    let n = 0;
    const chain = chainStub({ readPostedAt: async () => (++n < 3 ? 0n : 99n) });
    expect(await readPostedAtWithRetry(chain, HASH, FAST)).toBe(99n);
  });

  it("gives up and returns zero when the hash genuinely is not anchored", async () => {
    const chain = chainStub({ readPostedAt: async () => 0n });
    expect(await readPostedAtWithRetry(chain, HASH, FAST)).toBe(0n);
  });
});
