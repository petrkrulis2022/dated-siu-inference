import { Router } from "express";
import { createPublicClient, http, type Hex } from "viem";
import { latestPriceSnapshotFile, loadPriceSnapshot } from "@touchstone/print";
import type { ConsoleConfig } from "../config.js";
import { loadAllPrints } from "../lib/prints.js";
import { computeHealthReport } from "../lib/health-checks.js";

export function healthRouter(config: ConsoleConfig): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const prints = await loadAllPrints(config.printsDir);

      const snapshotFile = await latestPriceSnapshotFile("openrouter").catch(() => null);
      const latestPriceSnapshot = snapshotFile ? await loadPriceSnapshot(snapshotFile) : null;

      let publisherEthBalanceWei = "0";
      if (config.publisherAddress) {
        const client = createPublicClient({ transport: http(config.rpcUrl) });
        const balance = await client.getBalance({ address: config.publisherAddress as Hex });
        publisherEthBalanceWei = balance.toString();
      }

      const report = computeHealthReport({
        prints,
        latestPriceSnapshot,
        publisherEthBalanceWei,
      });
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
