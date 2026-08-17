import { Router } from "express";
import type { ConsoleConfig } from "../config.js";
import { loadLifecycles } from "../lib/load-activity.js";
import { computeQuotedVsPaid } from "../lib/quoted-vs-paid.js";

export function quotedVsPaidRouter(config: ConsoleConfig): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const lifecycles = await loadLifecycles(config);
      res.json(computeQuotedVsPaid(lifecycles));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
