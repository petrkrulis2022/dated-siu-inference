import type { KVNamespace } from "@cloudflare/workers-types";

export interface CacheOutcome<T> {
  value: T;
  cached: boolean;
  fetchedAt: string;
}

/**
 * Get-or-populate against a KV namespace, wrapping `fresh()` — a network call against GitHub's
 * public repo (data/, no auth — raw.githubusercontent.com only, see data-source.ts and its own
 * env.ts's doc comment for why never api.github.com) — behind a short TTL. Prints publish once a
 * day, so a few minutes of staleness is imperceptible; what actually matters is that a slow
 * raw.githubusercontent.com response never becomes a failed tool call, paid or free.
 * `cached`/`fetchedAt` flow back to the caller so both the response header (X-Cache) and, for
 * get_index, the JSON body's `_meta` field can say honestly whether this was a hit or a miss —
 * never silently one or the other.
 */
export async function cached<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  fresh: () => Promise<T>,
): Promise<CacheOutcome<T>> {
  const hit = await kv.get<{ value: T; fetchedAt: string }>(key, "json");
  if (hit) {
    return { value: hit.value, cached: true, fetchedAt: hit.fetchedAt };
  }

  const value = await fresh();
  const fetchedAt = new Date().toISOString();
  // Best-effort: a KV write failure must never fail the tool call that already has a good,
  // freshly-fetched value in hand.
  await kv.put(key, JSON.stringify({ value, fetchedAt }), { expirationTtl: ttlSeconds }).catch(
    (err: unknown) => {
      console.error(`kv-cache: failed to write "${key}":`, err);
    },
  );
  return { value, cached: false, fetchedAt };
}
