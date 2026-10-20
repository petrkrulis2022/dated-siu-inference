/**
 * The daily login check's decision (D114): is the stored Blockworks MCP login still good, and if not, WHY, because the two failures need different things from the owner.
 *
 *  - `login-required`: the server rejected the stored login (`McpLoginRequired`). Nothing a retry can fix; the owner signs in again in a browser. Alerted at once, never retried.
 *  - `unreachable`: anything else (no network yet after the machine woke, a DNS or TLS failure, a server error). Not necessarily a login problem, so it is retried a few times with growing
 *    pauses, and only alerts if every try fails, with a message that says so. The scheduled task runs when the machine next wakes, which can be before the network is up; without the
 *    retries that would email a false alarm about the login on every such morning (the same shape as the watchdog's false alert of 2026-10-19, D110).
 *
 * Only the error's class name is kept, never its message, which can echo a URL or a header.
 */
export type LoginCheckResult =
  | { ok: true; attempts: number }
  | { ok: false; kind: "login-required"; attempts: number; why: string }
  | { ok: false; kind: "unreachable"; attempts: number; why: string };

/** Four tries, with pauses of 30, 60 and 120 seconds between them: about three and a half minutes before an alert. */
export const DEFAULT_CHECK_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000];

export async function runLoginCheck(opts: {
  /** one try: resolves if the login works, throws if not */
  attempt: () => Promise<void>;
  isLoginRequired: (e: unknown) => boolean;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<LoginCheckResult> {
  const delays = opts.delaysMs ?? DEFAULT_CHECK_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempts = 1; ; attempts++) {
    try {
      await opts.attempt();
      return { ok: true, attempts };
    } catch (e) {
      if (opts.isLoginRequired(e))
        return {
          ok: false,
          kind: "login-required",
          attempts,
          why: e instanceof Error ? e.message : "login required",
        };
      const why = e instanceof Error ? e.name : "error";
      const wait = delays[attempts - 1];
      if (wait === undefined) return { ok: false, kind: "unreachable", attempts, why };
      await sleep(wait);
    }
  }
}
