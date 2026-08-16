export interface RetryUntilConclusiveOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Public RPC endpoints are load-balanced across nodes at slightly different heights: a read
 * issued immediately after a transaction is confirmed mined can be served by a node that has
 * not caught up yet and will report a stale/default value. This exact failure mode produced two
 * independent bugs in two different places before being unified here — print anchoring's
 * `postedAt` reading 0 right after a real anchor (`@datum/print`'s `readPostedAtWithRetry`), and
 * escrow-funding reads reporting `status: None` right after a real fund
 * (`@datum/agents`' `readEscrowUntilMatch`). Only a conclusive read is a fact; anything else is
 * retried. The next caller reading chain state right after writing it should use this, not a
 * bare read — that is precisely the mistake this function exists to make impossible to repeat.
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
