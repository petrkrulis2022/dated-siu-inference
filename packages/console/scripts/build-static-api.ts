import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { latestPriceSnapshotFile, loadPriceSnapshot } from "@touchstone/print";
import { loadConfig } from "../server/config.js";
import { loadCache, writeCache } from "../server/indexer/cache.js";
import { indexNewEvents } from "../server/indexer/index.js";
import { loadAllPrints } from "../server/lib/prints.js";
import { verifyPrintOnChain } from "../server/lib/verify-print.js";
import { loadLifecycles } from "../server/lib/load-activity.js";
import { computeActivityAggregates } from "../server/lib/escrow-lifecycle.js";
import { computeQuotedVsPaid } from "../server/lib/quoted-vs-paid.js";
import { computeHealthReport } from "../server/lib/health-checks.js";
import { loadRunRecords } from "@touchstone/print";

/**
 * Generates the console's entire "API" as static JSON files, once per deploy, instead of
 * running the Express server (server/index.ts) as a live process. Every route handler in
 * server/routes/*.ts is already a thin wrapper around a pure function reading from data/ plus
 * one indexer-maintained cache (server/lib/load-activity.ts's own comment: the API "never
 * triggers a live scan itself; that's pnpm console:index's job") — this script IS that indexer
 * step, run at build time, with each route's exact response written to the same path the
 * frontend already fetches (web/src/lib/api.ts's getJson calls `/api${path}`), so the React
 * frontend needs zero changes.
 *
 * Trade-off, stated rather than hidden: the "verified" badges and the publisher's ETH balance
 * become as-of-this-build, not live-per-page-load. Given prints publish on a schedule and each
 * publish redeploys this site, that's a reasonable trade for a fully static, Function-free
 * deploy — but it is a real behaviour change from the live dev-time console.
 */

// Matches web/vite.config.ts's build.outDir ("../dist/web", relative to the web/ root) —
// i.e. dist/web at the package root, not web/dist.
const OUT_DIR = resolve(process.cwd(), "dist/web/api");

async function writeJson(path: string, value: unknown): Promise<void> {
  const full = join(OUT_DIR, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value), "utf-8");
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`[build-static-api] indexing ${config.chainName} events...`);
  const existing = await loadCache(config.eventCachePath);
  const cache = await indexNewEvents(
    {
      rpcUrl: config.rpcUrl,
      escrowAddress: config.escrowAddress,
      escrowDeployBlock: config.escrowDeployBlock,
      attestationAddress: config.attestationAddress,
      attestationDeployBlock: config.attestationDeployBlock,
    },
    existing,
  );
  await writeCache(config.eventCachePath, cache);

  // Mirrors .github/workflows/publish-print.yml's spend-ceiling Variable — the console has no
  // access to GitHub Actions Variables, so the workflow writes this file on every successful
  // publish and this is the console's only source for it. Absent (e.g. before the first
  // automated run, or read failure) is reported as null, never a fabricated default.
  const spendCeilingUsd = await readFile(
    join(config.registryDir, "pipeline-config.json"),
    "utf-8",
  )
    .then((raw) => (JSON.parse(raw) as { spend_ceiling_usd?: string }).spend_ceiling_usd ?? null)
    .catch(() => null);

  await writeJson("config", {
    chainName: config.chainName,
    chainId: config.chainId,
    explorerBaseUrl: config.explorerBaseUrl,
    escrowAddress: config.escrowAddress,
    attestationAddress: config.attestationAddress,
    spendCeilingUsd,
  });

  const prints = await loadAllPrints(config.printsDir);

  const printRows = await Promise.all(
    prints.map(async (print) => ({
      print_id: print.print_id,
      date: print.date,
      status: print.status,
      dated_siu: print.dated_siu,
      weights_source: print.weights.source,
      methodology_version: print.methodology_version,
      cost_of_production_usd: print.cost_of_production_usd,
      anchor_tx_hash: print.anchor?.tx_hash ?? null,
      anchor_status: print.anchor?.status ?? "none",
      verification: await verifyPrintOnChain(print, {
        rpcUrl: config.rpcUrl,
        attestationAddress: config.attestationAddress,
      }),
    })),
  );
  await writeJson("prints", printRows);

  for (const print of prints) {
    const verification = await verifyPrintOnChain(print, {
      rpcUrl: config.rpcUrl,
      attestationAddress: config.attestationAddress,
    });
    // Not nested under "prints/" — that path is already a *file* (the list, above), and a
    // plain static filesystem can't have both a file and a directory at the same path.
    await writeJson(`prints-detail/${print.print_id}`, { print, verification });
  }

  const rateHistory: Record<string, unknown[]> = {};
  const gateHistory: Record<string, unknown[]> = {};
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
  await writeJson("models", { rateHistory, gateHistory });

  const lifecycles = await loadLifecycles(config);
  await writeJson("activity", {
    lifecycles,
    aggregates: computeActivityAggregates(lifecycles),
  });
  await writeJson("quoted-vs-paid", computeQuotedVsPaid(lifecycles));

  const snapshotFile = await latestPriceSnapshotFile("openrouter").catch(() => null);
  const latestPriceSnapshot = snapshotFile ? await loadPriceSnapshot(snapshotFile) : null;
  let publisherEthBalanceWei = "0";
  if (config.publisherAddress) {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const balance = await client.getBalance({ address: config.publisherAddress as Hex });
    publisherEthBalanceWei = balance.toString();
  }
  await writeJson(
    "health",
    computeHealthReport({ prints, latestPriceSnapshot, publisherEthBalanceWei }),
  );

  console.log(`[build-static-api] wrote static API for ${prints.length} print(s) -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
