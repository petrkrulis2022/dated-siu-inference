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

/**
 * One-word bucket for the *final* error an instance failed with — what an operator actually
 * needs to act on a batch of "infrastructure failure" outcomes: is this one host rate-limiting,
 * a genuine outage, a network blip, or something the response shape itself couldn't handle. Not
 * exhaustive diagnosis (the full message is kept alongside this, see InstanceOutcome.infraFailure)
 * — just enough structure to group and count without re-reading every message by eye.
 */
export type FailureCategory =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network"
  | "auth_or_bad_request"
  | "malformed_response"
  | "unknown";

export function classifyFailure(err: unknown): FailureCategory {
  if (err instanceof AdapterHttpError) {
    if (err.status === 429) return "rate_limit";
    if (err.status >= 500) return "server_error";
    return "auth_or_bad_request"; // 4xx other than 429: bad key, bad request, not found, etc.
  }
  if (err instanceof SyntaxError) return "malformed_response"; // JSON.parse on a non-JSON body.
  if (err instanceof Error) {
    if (/ETIMEDOUT|timed? ?out/i.test(err.message)) return "timeout";
    if (/fetch failed|network|ECONNRESET|ENOTFOUND|ENETUNREACH/i.test(err.message)) return "network";
  }
  return "unknown";
}

export interface BackoffOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Called once per retry, after a retryable error and before the backoff sleep. Most callers
   * (the demo's live seller calls) don't need this — a retried-then-successful demo call is
   * fine to look identical to a clean one. The measurement path is different: a print's run
   * record must not present a retried response as if it were obtained cleanly on the first
   * try, since that silently discards a real data-quality signal (build1-spec.md §3's
   * `deviations` field exists precisely to carry this kind of forced deviation). Optional and
   * a no-op by default, so this is additive, not a behaviour change for existing callers.
   */
  onRetry?: (attemptNumber: number, err: unknown) => void;
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
      opts.onRetry?.(attempt + 1, err);
      const exponential = opts.baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * opts.baseDelayMs;
      const delay = Math.min(exponential + jitter, opts.maxDelayMs);
      await sleep(delay);
      attempt++;
    }
  }
}
