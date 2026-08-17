import { Router } from "express";
import type { ConsoleConfig } from "../config.js";
import { loadLifecycles } from "../lib/load-activity.js";
import { computeActivityAggregates } from "../lib/escrow-lifecycle.js";

export function activityRouter(config: ConsoleConfig): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const lifecycles = await loadLifecycles(config);
      const aggregates = computeActivityAggregates(lifecycles);
      res.json({ lifecycles, aggregates });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
