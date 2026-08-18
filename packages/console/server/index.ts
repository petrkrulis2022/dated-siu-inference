import express from "express";
import { loadConfig } from "./config.js";
import { loadCache, writeCache } from "./indexer/cache.js";
import { indexNewEvents } from "./indexer/index.js";
import { configRouter } from "./routes/config.js";
import { printsRouter } from "./routes/prints.js";
import { modelsRouter } from "./routes/models.js";
import { activityRouter } from "./routes/activity.js";
import { quotedVsPaidRouter } from "./routes/quoted-vs-paid.js";
import { healthRouter } from "./routes/health.js";

/**
 * Read-only, localhost-only — see docs/console.md. This process never imports a write-capable
 * function from any `@touchstone/*` package (no `signPrintBody`, `signQuote`, `writePrint`,
 * `publishPrint`, no `openAndFund`/`settle`/`expire`, no private-key loader) and only ever
 * constructs a viem *public* client, never a wallet client. Binds `127.0.0.1` explicitly, never
 * `0.0.0.0` — not reachable from outside this machine.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`[console] catching up the event index against ${config.chainName}...`);
  const existing = await loadCache(config.eventCachePath);
  const updated = await indexNewEvents(
    {
      rpcUrl: config.rpcUrl,
      escrowAddress: config.escrowAddress,
      escrowDeployBlock: config.escrowDeployBlock,
      attestationAddress: config.attestationAddress,
      attestationDeployBlock: config.attestationDeployBlock,
    },
    existing,
  );
  await writeCache(config.eventCachePath, updated);
  console.log(
    `[console] index up to date through block ${updated.lastIndexedBlock.escrow} (escrow) / ` +
      `${updated.lastIndexedBlock.attestation} (attestation).`,
  );

  const app = express();
  app.use(express.json());
  app.use("/api/config", configRouter(config));
  app.use("/api/prints", printsRouter(config));
  app.use("/api/models", modelsRouter(config));
  app.use("/api/activity", activityRouter(config));
  app.use("/api/quoted-vs-paid", quotedVsPaidRouter(config));
  app.use("/api/health", healthRouter(config));

  app.listen(config.port, config.host, () => {
    console.log(`[console] API listening on http://${config.host}:${config.port}`);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
