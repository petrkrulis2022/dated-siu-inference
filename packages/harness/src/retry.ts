import { AdapterHttpError } from "./adapters/types.js";

/** 429 and 5xx are retryable per build1-spec.md §4; other HTTP errors (bad key, bad request) are not. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof AdapterHttpError) {
    return err.status === 429 || err.status >= 500;
  }
  // A raw network failure (DNS, connection reset, timeout) — fetch() throws a plain
  // TypeError/Error for these, with no status code to inspect.
  if (err instanceof Error) {
    return /fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH/i.test(err.message);
  }
  return false;
}

export interface BackoffOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 15000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` on retryable errors with exponential backoff + jitter. Non-retryable errors
 * (bad API key, malformed request) propagate immediately — retrying those would just waste
 * time and money on calls that can never succeed.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = DEFAULT_BACKOFF,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt >= opts.maxRetries) {
        throw err;
      }
      const exponential = opts.baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * opts.baseDelayMs;
      const delay = Math.min(exponential + jitter, opts.maxDelayMs);
      await sleep(delay);
      attempt++;
    }
  }
}
