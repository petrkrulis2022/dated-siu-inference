import { AdapterHttpError } from "./adapters/types.js";

/**
 * Detects a provider rejecting a call because *our own* prepaid balance ran out — distinct from
 * every other 4xx/429 (bad key, bad request, genuine rate limit) because retrying never helps
 * and the fix is a top-up, not a backoff. Confirmed live, 2026-09-17/09-18/09-25: Anthropic
 * returns a genuine HTTP 400 with body `{"error":{"type":"invalid_request_error","message":
 * "Your credit balance is too low to access the Anthropic API. ..."}}` — cross-referenced against
 * this project's own real Anthropic invoice history, not assumed. The 402 and "insufficient_quota"
 * checks below are the *documented, standard* conventions for this same condition (HTTP 402
 * Payment Required is the standard code for it; OpenRouter's own API docs specify 402 for
 * "Insufficient credits"; OpenAI's own error taxonomy names this exact condition
 * "insufficient_quota") but have not yet been caught live from a real Touchstone run the way
 * Anthropic's has — so, unlike the Anthropic substring, they are convention-based, not yet
 * incident-confirmed. AdapterResult.raw already persists every real response body going forward
 * (see InstanceOutcome.infraFailureBody), so the first live recurrence for any of these providers
 * will confirm or correct this pattern from real evidence, same as Anthropic's was.
 */
function isBillingExhaustionBody(status: number, body: unknown): boolean {
  if (status === 402) return true; // Standard "Payment Required"; OpenRouter's own documented convention.
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /credit balance is too low|insufficient_quota|insufficient credits/i.test(text);
}

/**
 * Detects a provider declining a request under its own usage policy, as opposed to the request
 * being malformed, unauthorised, or over a limit. Added 2026-09-27 for the Gate Market agents,
 * whose prompts legitimately discuss probing and defeating a grader: a refusal there is an
 * environmental fact about that turn, not a statement about how the agent behaves, and folding it
 * into `auth_or_bad_request` would silently misattribute it as one.
 *
 * Matched on each provider's own documented marker for this condition — OpenAI's
 * `content_policy_violation` code, Anthropic's content-filtering message, Google's
 * `PROHIBITED_CONTENT`/`SAFETY` block reasons. None of these has yet been caught live from a real
 * Touchstone run, so unlike the Anthropic billing substring above they are convention-based; the
 * first real occurrence will confirm or correct them, and `policyRefusalStopReason` below covers
 * the commoner shape where a refusal arrives as a successful response rather than an error.
 */
function isPolicyRefusalBody(body: unknown): boolean {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return /content_policy_violation|content filtering policy|PROHIBITED_CONTENT|blocked by .{0,24}safety|safety_?(?:violation|blocked)/i.test(
    text,
  );
}

/** Real refusal markers that arrive on an otherwise-successful response — the commoner shape by
 * far, and the one that previously read as "the model returned nothing parseable". Anthropic
 * reports `refusal` as a stop reason; Google reports `SAFETY`/`PROHIBITED_CONTENT`/`BLOCKLIST` as
 * a finish reason; OpenAI-shaped APIs report `content_filter`. Callers pass
 * `AdapterResult.stopReason`, which every real adapter already populates from the provider's own
 * field rather than inferring it. */
export function isPolicyRefusalStopReason(stopReason: string | undefined): boolean {
  if (!stopReason) return false;
  return /^(refusal|content_filter|SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY)$/i.test(
    stopReason.trim(),
  );
}

/** 429 and 5xx are retryable per build1-spec.md §4; other HTTP errors (bad key, bad request) are
 * not — nor is a billing-exhaustion rejection, even one that happens to arrive on a 429: no
 * amount of retrying restores a balance that is actually zero. */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof AdapterHttpError) {
    if (isBillingExhaustionBody(err.status, err.body)) return false;
    // A policy refusal is a decision about this request's content, not a transient condition —
    // the identical request retried is refused identically, at full cost each time.
    if (isPolicyRefusalBody(err.body)) return false;
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
 *
 * "policy_refusal" is likewise its own category: a provider declining a request under its usage
 * policy says something about that request's content, not about the caller's credentials or the
 * request's shape. Folding it into auth_or_bad_request would report a refused turn as a
 * malformed one — and for the Gate Market agents, whose prompts legitimately discuss probing a
 * grader, would misattribute an environmental fact as the agent's own behaviour.
 *
 * "billing_exhausted" is deliberately its own category, not folded into auth_or_bad_request or
 * rate_limit: it is neither a request-shape problem nor a transient rate condition, and grouping
 * it with either would make a print's own infra-failure summary read as "a provider rejected bad
 * requests" or "a provider was rate-limiting us" when the real, actionable fact is "we ran out of
 * our own prepaid credit" — see docs/methodology.md's billing-exhaustion disclosure.
 */
export type FailureCategory =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network"
  | "auth_or_bad_request"
  | "malformed_response"
  | "billing_exhausted"
  | "policy_refusal"
  | "sampling_mismatch"
  | "unknown";

export function classifyFailure(err: unknown): FailureCategory {
  if (err instanceof AdapterHttpError) {
    if (isBillingExhaustionBody(err.status, err.body)) return "billing_exhausted";
    if (isPolicyRefusalBody(err.body)) return "policy_refusal";
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
