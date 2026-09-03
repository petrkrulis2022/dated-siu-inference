import { DurableObject } from "cloudflare:workers";
import { type BudgetState, decideReconciliation, decideReservation, todayUtc } from "../budget-math.js";

const STORAGE_KEY = "budget";

/**
 * A hard daily $ ceiling on the chat backend's own LLM spend, the same discipline as
 * PUBLISH_SPEND_CEILING_USD elsewhere in this repo — enforced with a Durable Object rather than
 * KV because KV is only eventually consistent and this needs a genuine, race-free hard cap. The
 * money math itself lives in ../budget-math.ts (plain, unit-tested); this class is only the
 * storage plumbing around it.
 *
 * The atomicity this relies on: Cloudflare guarantees a Durable Object processes one request's
 * JavaScript to completion (its "input gate") before starting the next, *as long as that
 * request never awaits an external fetch() in between* — storage.get/put do not release the
 * input gate. `reserve` below reads, computes, and writes storage with no intervening external
 * I/O, so two concurrent chat turns calling `reserve` on the same instance genuinely cannot both
 * pass a check that should have failed. (This class is not itself unit-tested for that reason —
 * it has no logic of its own left to test outside a real Workers runtime; see the DO test
 * discussion in this repo's mcp-server package, which takes the same approach for its own DO.)
 *
 * Usage pattern (see workers/index.ts): call `reserve` with a conservative fixed estimate
 * *before* calling Claude — if it refuses, no call is made at all. After the real usage comes
 * back from the API, call `reconcile` to correct the ledger down to the real cost.
 */
export class ChatBudgetTracker extends DurableObject<Env> {
  async reserve(
    estimatedCostUsd: string,
    ceilingUsd: string,
  ): Promise<{ allowed: boolean; spentTodayUsd: string }> {
    const today = todayUtc(new Date());
    const stored = await this.ctx.storage.get<BudgetState>(STORAGE_KEY);
    const { allowed, spentTodayUsd, nextState } = decideReservation(
      stored,
      today,
      estimatedCostUsd,
      ceilingUsd,
    );
    if (nextState) await this.ctx.storage.put<BudgetState>(STORAGE_KEY, nextState);
    return { allowed, spentTodayUsd };
  }

  async reconcile(estimatedCostUsd: string, actualCostUsd: string): Promise<void> {
    const today = todayUtc(new Date());
    const stored = await this.ctx.storage.get<BudgetState>(STORAGE_KEY);
    const { nextState } = decideReconciliation(stored, today, estimatedCostUsd, actualCostUsd);
    if (nextState) await this.ctx.storage.put<BudgetState>(STORAGE_KEY, nextState);
  }

  /** Read-only — used by the /digest endpoint to report today's real spend, not to gate anything. */
  async spentToday(): Promise<string> {
    const today = todayUtc(new Date());
    const stored = await this.ctx.storage.get<BudgetState>(STORAGE_KEY);
    return stored?.date === today ? stored.spentUsd : "0";
  }
}
