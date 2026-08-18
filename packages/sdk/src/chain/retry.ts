export interface RetryUntilConclusiveOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Public RPC endpoints are load-balanced across nodes at slightly different heights: a read
 * issued immediately after a transaction is confirmed mined can be served by a node that has
 * not caught up yet and will report a stale/default value. This exact failure mode has now
 * produced three independent bugs in three different places before being unified here:
 *
 *  1. Print anchoring — `postedAt` reading 0 right after a real anchor
 *     (`@touchstone/print`'s `readPostedAtWithRetry`).
 *  2. Settlement reading — a just-settled amount/status reading stale right after a real
 *     `settle()` (`@touchstone/mcp-server`'s `OnChainSettlementReader.read()` and its mirror,
 *     `@touchstone/agents`' `LocalSettlementReader.read()`).
 *  3. Escrow funding — an escrow reading `status: None` right after a real `openAndFund`, and a
 *     USDC `allowance` reading insufficient right after a real `approve` immediately followed by
 *     `openAndFund` (`@touchstone/agents`' `readEscrowUntilMatch` and the allowance re-check
 *     inside `openAndFund`).
 *
 * Only a conclusive read is a fact; anything else is retried. The next caller reading chain
 * state right after writing it should use this, not a bare read — that is precisely the mistake
 * this function exists to make impossible to repeat.
 *
 * This class of bug is invisible against a mocked RPC client, which is always instantly
 * consistent with whatever it was just told to return — every one of the three bugs above was
 * found live, against the real Base Sepolia RPC pool, never by a unit test with a fake client.
 * A read-after-write added against a mock will look correct and still be wrong the first time it
 * runs for real.
 */
export async function retryUntilConclusive<T>(
  read: () => Promise<T>,
  isConclusive: (value: T) => boolean,
  options: RetryUntilConclusiveOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1500;

  let value = await read();
  for (let i = 0; i < attempts - 1 && !isConclusive(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    value = await read();
  }
  return value;
}
