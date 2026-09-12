import { Router } from "express";
import { loadReconciledPrintIds } from "@touchstone/print";
import type { ConsoleConfig } from "../config.js";
import { resolveVerifyOptions } from "../config.js";
import { loadAllPrints } from "../lib/prints.js";
import { verifyPrintOnChain } from "../lib/verify-print.js";

export function printsRouter(config: ConsoleConfig): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const prints = await loadAllPrints(config.printsDir);
      // docs/methodology.md §7: print.status stays "provisional" forever — final is derived
      // from whether a signed reconciliation record exists for this print_id.
      const reconciledPrintIds = await loadReconciledPrintIds(config.reconciliationsDir);
      const rows = await Promise.all(
        prints.map(async (print) => ({
          print_id: print.print_id,
          date: print.date,
          status: print.status,
          final: reconciledPrintIds.has(print.print_id),
          dated_siu: print.dated_siu,
          weights_source: print.weights.source,
          methodology_version: print.methodology_version,
          anchor_tx_hash: print.anchor?.tx_hash ?? null,
          anchor_status: print.anchor?.status ?? "none",
          verification: await verifyPrintOnChain(print, () => resolveVerifyOptions(print, config)),
        })),
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/:printId", async (req, res) => {
    try {
      const prints = await loadAllPrints(config.printsDir);
      const print = prints.find((p) => p.print_id === req.params.printId);
      if (!print) {
        res.status(404).json({ error: `No print "${req.params.printId}".` });
        return;
      }
      const verification = await verifyPrintOnChain(print, () => resolveVerifyOptions(print, config));
      res.json({ print, verification });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
