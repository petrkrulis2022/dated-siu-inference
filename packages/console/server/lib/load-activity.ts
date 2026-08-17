import { loadCache } from "../indexer/cache.js";
import { loadLocalQuotes } from "../quotes/local-quotes.js";
import { reconstructEscrowLifecycles, type EscrowLifecycle } from "./escrow-lifecycle.js";
import type { ConsoleConfig } from "../config.js";

/** Shared by the activity and quoted-vs-paid routes — both need the same reconstructed
 * lifecycles, built from whatever the indexer has already cached (never triggers a live scan
 * itself; that's `pnpm console:index`'s job, matching the plan's separation between the
 * resumable indexer and the read-only API). */
export async function loadLifecycles(config: ConsoleConfig): Promise<EscrowLifecycle[]> {
  const [cache, localQuotes] = await Promise.all([
    loadCache(config.eventCachePath),
    loadLocalQuotes(config.localQuotesDir),
  ]);
  return reconstructEscrowLifecycles(cache.events, cache.escrow.feeBps, localQuotes);
}
