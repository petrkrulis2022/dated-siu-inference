import { describe, expect, it, beforeEach } from "vitest";
import { BaseError, ContractFunctionRevertedError, parseAbi, type Hex } from "viem";
import type { ChainClients } from "@touchstone/agents";
import { retryOnSimulationRevert, setRevertRetryPolicy, setWriteRetryListener, writeAndConfirm, type WriteRetryEvent } from "./write.js";

const ABI = parseAbi(["function presentForRedemption(uint256 tokenId, bytes32 hash)", "error NothingToPresent()"]);
const PARAMS = { address: "0x0000000000000000000000000000000000000001" as Hex, abi: ABI, functionName: "presentForRedemption", args: [1n, `0x${"00".repeat(32)}`] };

/** A revert as viem raises it from a gas estimation: the node's simulation said no, nothing was sent. */
const simulationRevert = (): BaseError =>
  new BaseError("The contract function reverted", {
    cause: new ContractFunctionRevertedError({ abi: ABI, functionName: "presentForRedemption", data: "0x73f18ad7" }),
  });

function clients(writes: (() => Promise<Hex> | Hex)[], receiptStatus: "success" | "reverted" = "success") {
  let calls = 0;
  const c = {
    account: { address: "0x0000000000000000000000000000000000000002" },
    walletClient: {
      writeContract: async () => {
        const next = writes[Math.min(calls, writes.length - 1)];
        calls++;
        return next();
      },
    },
    publicClient: {
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: receiptStatus, transactionHash: hash }),
    },
  } as unknown as ChainClients;
  return { clients: c, calls: () => calls };
}

describe("writeAndConfirm — a revert on simulation may be the node's lag, not the call's fault", () => {
  // Found by the first LIVE scripted run (2026-10-05), the seventh stale-read: WORKER-CODE's
  // `redeem_claim` was refused "you hold none of this claim" a moment after being handed it, and
  // WORKER-EXTRACT's `reserve_for_work` "the escrow is not open" a moment after it was paid. Both were
  // gas estimations run against a load-balanced node that had not yet seen the previous transaction.
  // Nothing had been sent, so trying again is safe; the fork never reproduced it because a fork has
  // one node and no lag.
  beforeEach(() => setRevertRetryPolicy({ attempts: 3, delayMs: 0 }));

  it("retries a simulation that reverts, and succeeds once the node has caught up", async () => {
    const { clients: c, calls } = clients([() => { throw simulationRevert(); }, () => { throw simulationRevert(); }, () => "0xabc" as Hex]);
    const receipt = await writeAndConfirm(c, PARAMS);
    expect(receipt.transactionHash).toBe("0xabc");
    expect(calls()).toBe(3);
  });

  it("recognises a revert raised by ANOTHER COPY of viem — class identity does not survive two copies", async () => {
    // The loop's clients come from @touchstone/agents, which resolves its own copy of viem; an error
    // it raises is not an `instanceof` this package's `BaseError` however much it is one. The first
    // live run with this retry in it never retried: `instanceof` said no. The error is recognised by
    // what it says it is, down its cause chain.
    const foreignRevert = (): Error =>
      Object.assign(new Error("The contract function reverted"), {
        name: "ContractFunctionExecutionError",
        cause: Object.assign(new Error("reverted"), {
          name: "ContractFunctionRevertedError",
          cause: Object.assign(new Error("rpc"), { name: "ExecutionRevertedError" }),
        }),
      });
    const { clients: c, calls } = clients([() => { throw foreignRevert(); }, () => "0xabc" as Hex]);
    const receipt = await writeAndConfirm(c, PARAMS);
    expect(receipt.transactionHash).toBe("0xabc");
    expect(calls()).toBe(2);
  });

  it("does not mistake a foreign error that merely has a cause for a revert", async () => {
    const { clients: c, calls } = clients([
      () => { throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError", cause: new Error("ECONNRESET") }); },
    ]);
    await expect(writeAndConfirm(c, PARAMS)).rejects.toThrow("fetch failed");
    expect(calls()).toBe(1);
  });

  it("survives a cause chain that loops back on itself", async () => {
    const a: Record<string, unknown> = new Error("a") as never;
    const b = Object.assign(new Error("b"), { name: "Other", cause: a });
    Object.assign(a, { name: "Other", cause: b });
    const { clients: c, calls } = clients([() => { throw a; }]);
    await expect(writeAndConfirm(c, PARAMS)).rejects.toBe(a);
    expect(calls()).toBe(1);
  });

  it("throws the REAL revert, not a timeout, when it never stops reverting — a genuine error is not hidden", async () => {
    const { clients: c, calls } = clients([() => { throw simulationRevert(); }]);
    await expect(writeAndConfirm(c, PARAMS)).rejects.toBeInstanceOf(BaseError);
    expect(calls(), "the first try and three more").toBe(4);
  });

  it("does not retry an error that is not a contract revert — a nonce or funds problem is not lag", async () => {
    const { clients: c, calls } = clients([() => { throw new Error("nonce too low"); }]);
    await expect(writeAndConfirm(c, PARAMS)).rejects.toThrow("nonce too low");
    expect(calls()).toBe(1);
  });

  it("never re-sends a transaction that was mined and reverted on-chain", async () => {
    const { clients: c, calls } = clients([() => "0xdead" as Hex], "reverted");
    await expect(writeAndConfirm(c, PARAMS)).rejects.toThrow(/reverted on-chain/);
    expect(calls(), "a mined revert is final").toBe(1);
  });

  it("can be switched off", async () => {
    setRevertRetryPolicy({ attempts: 0, delayMs: 0 });
    const { clients: c, calls } = clients([() => { throw simulationRevert(); }]);
    await expect(writeAndConfirm(c, PARAMS)).rejects.toBeInstanceOf(BaseError);
    expect(calls()).toBe(1);
  });

  it("waits between tries, so a lagging node has time to catch up", async () => {
    setRevertRetryPolicy({ attempts: 2, delayMs: 40 });
    const { clients: c } = clients([() => { throw simulationRevert(); }, () => { throw simulationRevert(); }, () => "0xabc" as Hex]);
    const started = Date.now();
    await writeAndConfirm(c, PARAMS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });
});

describe("writeAndConfirm — the lag is reported, not only absorbed", () => {
  beforeEach(() => setRevertRetryPolicy({ attempts: 3, delayMs: 0 }));

  const collect = (): WriteRetryEvent[] => {
    const events: WriteRetryEvent[] = [];
    setWriteRetryListener((e) => events.push(e));
    return events;
  };
  const stop = () => setWriteRetryListener(undefined);

  it("says nothing about a write that went through first time", async () => {
    const events = collect();
    try {
      await writeAndConfirm(clients([() => "0xabc" as Hex]).clients, PARAMS);
    } finally {
      stop();
    }
    expect(events).toEqual([]);
  });

  it("reports a write that needed the node to catch up, with how many tries it took", async () => {
    const events = collect();
    try {
      await writeAndConfirm(clients([() => { throw simulationRevert(); }, () => { throw simulationRevert(); }, () => "0xabc" as Hex]).clients, PARAMS);
    } finally {
      stop();
    }
    expect(events).toEqual([
      { functionName: "presentForRedemption", account: "0x0000000000000000000000000000000000000002", retries: 2, outcome: "recovered" },
    ]);
  });

  it("reports a write that gave up, with what the node last said, and still throws the node's own error", async () => {
    const events = collect();
    try {
      await expect(writeAndConfirm(clients([() => { throw simulationRevert(); }]).clients, PARAMS)).rejects.toThrow(/reverted/);
    } finally {
      stop();
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ retries: 3, outcome: "gave_up", lastError: "The contract function reverted" });
  });

  it("does not report an error that is not lag", async () => {
    const events = collect();
    try {
      await expect(writeAndConfirm(clients([() => { throw new Error("insufficient funds"); }]).clients, PARAMS)).rejects.toThrow(/insufficient funds/);
    } finally {
      stop();
    }
    expect(events).toEqual([]);
  });
});

describe("retryOnSimulationRevert — the same tolerance for a write that does not go through writeAndConfirm", () => {
  beforeEach(() => setRevertRetryPolicy({ attempts: 3, delayMs: 0 }));

  it("retries a call whose simulation reverts and reports it, and returns what the call returned", async () => {
    const events: WriteRetryEvent[] = [];
    setWriteRetryListener((e) => events.push(e));
    let n = 0;
    try {
      const result = await retryOnSimulationRevert({ functionName: "settle", account: "0xabc" }, async () => {
        if (n++ < 2) throw simulationRevert();
        return "0xtx";
      });
      expect(result).toBe("0xtx");
    } finally {
      setWriteRetryListener(undefined);
    }
    expect(events).toEqual([{ functionName: "settle", account: "0xabc", retries: 2, outcome: "recovered" }]);
  });

  it("does not retry an error that is not a simulation revert — a mined transaction that reverted is final", async () => {
    let n = 0;
    await expect(
      retryOnSimulationRevert({ functionName: "settle", account: "0xabc" }, async () => {
        n++;
        throw new Error("settle(0x1) reverted on-chain.");
      }),
    ).rejects.toThrow(/reverted on-chain/);
    expect(n).toBe(1);
  });

  it("gives up after the policy's attempts and throws the node's own error", async () => {
    let n = 0;
    await expect(
      retryOnSimulationRevert({ functionName: "settle", account: "0xabc" }, async () => {
        n++;
        throw simulationRevert();
      }),
    ).rejects.toThrow(/reverted/);
    expect(n).toBe(4); // the first try and three more
  });
});
