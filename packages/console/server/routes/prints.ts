import { Router } from "express";
import type { ConsoleConfig } from "../config.js";
import { loadAllPrints } from "../lib/prints.js";
import { verifyPrintOnChain } from "../lib/verify-print.js";

export function printsRouter(config: ConsoleConfig): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const prints = await loadAllPrints(config.printsDir);
      const rows = await Promise.all(
        prints.map(async (print) => ({
          print_id: print.print_id,
          date: print.date,
          status: print.status,
          dated_siu: print.dated_siu,
          weights_source: print.weights.source,
          methodology_version: print.methodology_version,
          anchor_tx_hash: print.anchor?.tx_hash ?? null,
          anchor_status: print.anchor?.status ?? "none",
          verification: await verifyPrintOnChain(print, {
            rpcUrl: config.rpcUrl,
            attestationAddress: config.attestationAddress,
          }),
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
      const verification = await verifyPrintOnChain(print, {
        rpcUrl: config.rpcUrl,
        attestationAddress: config.attestationAddress,
      });
      res.json({ print, verification });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
