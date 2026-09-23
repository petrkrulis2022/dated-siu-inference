import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { D, sum, type DecimalValue } from "@touchstone/print";
import type { GateMarketReceipt } from "../receipt/types.js";
import { recordedAgentIds } from "./recorder.js";

export interface BasicMetrics {
  /** Turn count recorded per agent — derived from `contexts/<agentId>/*.json` file counts. */
  contextsRecorded: Record<string, number>;
  receiptsRecorded: number;
  claimsRetired: number;
  /** Decimal string — never a float, per this repo's own money-maths rule. Real Decimal
   * arithmetic (`@touchstone/print`'s `sum`), not `+` on parsed numbers. */
  totalUsdcEquivalentAtPrint: string;
}

/**
 * Spec §15's WP-9 test: "a run directory replays into identical metrics." This recomputes a
 * basic, pack-agnostic metrics summary purely from what `RunRecorder` persisted to disk —
 * `contexts/` and `receipts/` — with no access to whatever in-memory state produced them. A real
 * run's richer, pack-specific metrics (F1/F2/F3, gate false-accept rates, etc.) are computed by
 * whatever calls `RunRecorder.finalizeMetrics` — this function proves the *persisted* facts
 * themselves are sufficient to reconstruct at least this much, which is the property "replays
 * into identical metrics" is actually testing.
 */
export function computeBasicMetrics(runDir: string): BasicMetrics {
  const contextsRecorded: Record<string, number> = {};
  for (const agentId of recordedAgentIds(runDir)) {
    const files = readdirSync(join(runDir, "contexts", agentId)).filter((f) => f.endsWith(".json"));
    contextsRecorded[agentId] = files.length;
  }

  let receipts: GateMarketReceipt[];
  try {
    const files = readdirSync(join(runDir, "receipts")).filter((f) => f.endsWith(".json"));
    receipts = files.map((f) => JSON.parse(readFileSync(join(runDir, "receipts", f), "utf-8")) as GateMarketReceipt);
  } catch {
    receipts = [];
  }

  const amounts: DecimalValue[] = receipts.map((r) => new D(r.usdc_equivalent_at_print));

  return {
    contextsRecorded,
    receiptsRecorded: receipts.length,
    claimsRetired: receipts.filter((r) => r.claim_retired).length,
    totalUsdcEquivalentAtPrint: sum(amounts).toString(),
  };
}
