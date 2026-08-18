import type { Server } from "node:http";
import type { Express } from "express";
import { buildApp } from "@touchstone/mcp-server";
import { loadDeployment } from "@touchstone/sdk";
import { loadRegistry, latestPriceSnapshotFile, loadPriceSnapshot } from "@touchstone/print";
import { clientsFor, generateAndFundSeller } from "../wallets.js";
import { createSellerApp } from "../seller.js";
import { runBuyerDemo } from "../buyer.js";
import { LocalSettlementReader } from "../settlement-reader.js";

/**
 * The scripted end-to-end run — build1-spec.md §11/§14. TESTBED ONLY: these are our own agents,
 * on our own two freshly-funded seller wallets, and this run demonstrates the protocol working,
 * not market demand. Never present this transcript as traction. See docs/demo.md for what each
 * step shows and the two documented environment gaps (no real print yet, no Circle Agent
 * Wallet/Gateway credentials yet) this run works honestly around.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set.`);
  }
  return value;
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolvePromise) => {
    const server = app.listen(0, () => resolvePromise(server));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an AddressInfo from a TCP listener.");
  }
  return address.port;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log(
    "Touchstone Assay demo agents — TESTBED, not traction. These are our own agents on our",
  );
  console.log("own testnet wallets; this run demonstrates the protocol, not market demand.");
  console.log("=".repeat(78));

  const chainName = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
  const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
  const rpcUrl = requireEnv(rpcEnvVar);
  const deployerKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const publisherKey = requireEnv("TOUCHSTONE_PUBLISHER_KEY");
  const openrouterKey = requireEnv("OPENROUTER_API_KEY");

  const deployment = loadDeployment(chainName);
  const escrowAddress = deployment.contracts.TouchstoneEscrow.address;
  const usdcAddress = deployment.usdc.address;

  const registry = await loadRegistry();
  const modelEntry = registry.find((m) => m.id === "deepseek-v3.2");
  if (!modelEntry) {
    throw new Error('Model "deepseek-v3.2" not found in data/registry/models.json.');
  }
  const snapshotFile = await latestPriceSnapshotFile("openrouter");
  const snapshot = await loadPriceSnapshot(snapshotFile);
  type PriceEntry = (typeof snapshot.entries)[number];
  const priceEntry = snapshot.entries.find((e: PriceEntry) => e.model_id === modelEntry.id);
  if (!priceEntry) {
    throw new Error(`No price for "${modelEntry.id}" in ${snapshotFile}.`);
  }

  const buyerClients = clientsFor(deployerKey, rpcUrl);
  log(`[setup] buyer wallet: ${buyerClients.account.address}`);

  const sellerAFunded = await generateAndFundSeller(buyerClients, "seller-a");
  log(`[setup] seller-a wallet funded: ${sellerAFunded.account.address}`);
  const sellerBFunded = await generateAndFundSeller(buyerClients, "seller-b");
  log(`[setup] seller-b wallet funded: ${sellerBFunded.account.address}`);

  const prompt = "In one short sentence, what is a benchmark price index?";
  // Large enough that the real USD ceiling doesn't round to $0.0000 at touchstone-quote's 4dp
  // precision (TouchstoneEscrow.openAndFund rejects a zero maxAmount) — confirmed by first running
  // this demo with 64 and hitting exactly that revert.
  const maxOutputTokens = 2000;
  const quoteTtlSeconds = 3600;

  const sellerACommon = {
    registryEntry: modelEntry,
    prices: priceEntry,
    openrouterApiKey: openrouterKey,
    escrowAddress,
    chainName,
    prompt,
    maxOutputTokens,
    quoteTtlSeconds,
    log,
  };

  const sellerAApp = createSellerApp({
    ...sellerACommon,
    label: "seller-a",
    clients: clientsFor(sellerAFunded.privateKey, rpcUrl),
    privateKeyHex: sellerAFunded.privateKey,
    rateUsdPerSiu: "0.0500",
  });
  const sellerBApp = createSellerApp({
    ...sellerACommon,
    label: "seller-b",
    clients: clientsFor(sellerBFunded.privateKey, rpcUrl),
    privateKeyHex: sellerBFunded.privateKey,
    // A higher per-SIU asking price for the identical underlying task — makes "compares the
    // quotes in SIU" a genuine comparison rather than a coincidence.
    rateUsdPerSiu: "0.0650",
  });

  const sellerAServer = await listen(sellerAApp);
  const sellerBServer = await listen(sellerBApp);
  const sellerAPort = portOf(sellerAServer);
  const sellerBPort = portOf(sellerBServer);
  log(`[setup] seller-a listening on :${sellerAPort}, seller-b on :${sellerBPort}`);

  const settlementReader = new LocalSettlementReader({ chainName, rpcUrl, escrowAddress });
  const mcpApp = buildApp({
    publisherPrivateKeyHex: publisherKey,
    settlementReader,
    // No Circle Gateway credentials exist in this environment — see docs/demo.md. In production
    // verify_receipt is a paid x402 call through Circle's Gateway, same as get_quote/convert.
    skipPaywall: true,
  });
  const mcpServer = await listen(mcpApp);
  const mcpPort = portOf(mcpServer);
  log(`[setup] local mcp-server (paywall bypassed) listening on :${mcpPort}`);

  try {
    await runBuyerDemo({
      clients: buyerClients,
      sellers: [
        { label: "seller-a", url: `http://127.0.0.1:${sellerAPort}` },
        { label: "seller-b", url: `http://127.0.0.1:${sellerBPort}` },
      ],
      mandate: { max_usd_per_quote: "1.00", accepted_chains: [chainName] },
      escrowAddress,
      usdcAddress,
      chainName,
      mcpServerUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      log,
    });
    log("[demo] complete.");
  } finally {
    await Promise.all([
      closeServer(sellerAServer),
      closeServer(sellerBServer),
      closeServer(mcpServer),
    ]);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
