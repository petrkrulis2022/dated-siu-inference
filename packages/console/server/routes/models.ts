import { Router } from "express";
import { loadRunRecords } from "@touchstone/print";
import type { ConsoleConfig } from "../config.js";
import { loadAllPrints } from "../lib/prints.js";

interface ExchangeRatePoint {
  date: string;
  print_id: string;
  usd_per_siu: string | null;
  spread_to_index: string | null;
  siu_per_usd: string | null;
  excluded_reason: string | null;
}

interface GatePoint {
  print_id: string;
  task_class: string;
  passed: boolean;
}

/** Per-model exchange rate/spread history plus gate pass/fail history — build1-spec.md §6's
 * "the model that quietly started failing a class or drifted in cost" view. */
export function modelsRouter(config: ConsoleConfig): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const prints = await loadAllPrints(config.printsDir);
      const rateHistory: Record<string, ExchangeRatePoint[]> = {};
      const gateHistory: Record<string, GatePoint[]> = {};

      for (const print of prints) {
        for (const row of print.exchange_rate_table) {
          const points = rateHistory[row.model_id] ?? [];
          points.push({
            date: print.date,
            print_id: print.print_id,
            usd_per_siu: row.usd_per_siu ?? null,
            spread_to_index: row.spread_to_index ?? null,
            siu_per_usd: row.siu_per_usd ?? null,
            excluded_reason: row.excluded_reason ?? null,
          });
          rateHistory[row.model_id] = points;
        }

        const records = await loadRunRecords(print.print_id).catch(() => []);
        for (const record of records) {
          const points = gateHistory[record.model_id] ?? [];
          points.push({
            print_id: print.print_id,
            task_class: record.task_class,
            passed: record.gate_passed,
          });
          gateHistory[record.model_id] = points;
        }
      }

      res.json({ rateHistory, gateHistory });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
