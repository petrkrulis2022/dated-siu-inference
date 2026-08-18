// `pnpm --filter @touchstone/console run index` — rebuilds the event cache from scratch: ignores
// whatever's already cached and re-scans every contract from its deployment block. For normal
// operation the server itself does an incremental catch-up on startup (server/index.ts); this
// script is for when you want a guaranteed-fresh rebuild (after a cache-format change, or
// suspected corruption).
import { loadConfig } from "../config.js";
import { emptyCache, writeCache } from "./cache.js";
import { indexNewEvents } from "./index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`Rebuilding the event cache from scratch against ${config.chainName}...`);
  console.log(
    `  TouchstoneEscrow      ${config.escrowAddress} (from block ${config.escrowDeployBlock})`,
  );
  console.log(
    `  TouchstoneAttestation ${config.attestationAddress} (from block ${config.attestationDeployBlock})`,
  );

  const cache = await indexNewEvents(
    {
      rpcUrl: config.rpcUrl,
      escrowAddress: config.escrowAddress,
      escrowDeployBlock: config.escrowDeployBlock,
      attestationAddress: config.attestationAddress,
      attestationDeployBlock: config.attestationDeployBlock,
    },
    emptyCache(),
  );
  await writeCache(config.eventCachePath, cache);

  console.log(
    `\nIndexed through block ${cache.lastIndexedBlock.escrow} (escrow) / ` +
      `${cache.lastIndexedBlock.attestation} (attestation).`,
  );
  console.log(
    `  Opened: ${cache.events.opened.length}  Settled: ${cache.events.settled.length}  ` +
      `Expired: ${cache.events.expired.length}  PrintPosted: ${cache.events.printPosted.length}`,
  );
  console.log(`\nWrote ${config.eventCachePath}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
