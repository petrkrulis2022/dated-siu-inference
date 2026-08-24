import type { Server } from "node:http";
import type { Express } from "express";
import { buildApp } from "@touchstone/mcp-server";
import { loadDeployment } from "@touchstone/sdk";
import { loadRegistry, latestPriceSnapshotFile, loadPriceSnapshot } from "@touchstone/print";
import { clientsFor, generateAndFundSeller } from "../wallets.js";
import { createSellerApp } from "../seller.js";
import { runBuyerDemo } from "../buyer.js";
import { LocalSettlementReader } from "../settlement-reader.js";
import { DEMO_ILLUSTRATIVE_USD_PER_SIU } from "../pricing.js";

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
  // Dedicated to verify_receipt's signature — never TOUCHSTONE_PUBLISHER_KEY, which signs prints
  // and anchors on-chain. This demo models the same key separation the deployed service uses.
  const attestationKey = requireEnv("TOUCHSTONE_ATTESTATION_KEY");
  const openrouterKey = requireEnv("OPENROUTER_API_KEY");

  const deployment = loadDeployment(chainName);
  const escrowAddress = deployment.contracts.TouchstoneEscrow.address;
  const usdcAddress = deployment.usdc.address;

  // Two sellers on the *same* underlying model, priced very differently by host — not two
  // different model families (an earlier version of this demo used one model for both sellers
  // and only varied rate_usd_per_siu, which made "compare two sellers" a coincidence of a
  // hand-picked number, not a real comparison; a later draft tried two different families
  // instead). This is deliberately the stronger demonstration: two different model families
  // costing different amounts is unsurprising, but identical weights (llama-3.3-70b) costing
  // ~5.6x more per output token from one host (cloudflare, $2.253/1M) than another (novita,
  // $0.40/1M) is the counterintuitive fact that makes the case for a common unit — and it is
  // exactly the provider-spread column docs/methodology.md already publishes, not a story
  // invented for this demo. Both sellers quote the same DEMO_ILLUSTRATIVE_USD_PER_SIU rate
  // (pricing.ts), so the SIU spread the buyer sees below comes only from this real per-host
  // cost difference.
  //
  // OpenRouter's free-tier shared provider pools intermittently 429 under load — confirmed
  // live, repeatedly, across several registry models: the identical request to the identical
  // pinned host succeeded seconds after failing, with no other change, and it recurred on more
  // than one host in the same session, so it isn't one bad host to avoid. seller.ts's real
  // inference call now retries through withBackoff for exactly this (matching the harness's
  // batch orchestrator's existing retry behaviour). Host pinning itself stays on here — it's
  // what makes the provider-spread comparison this demo makes actually true — so this is not
  // routed through createAdapterFor's allowUnpinnedRouting escape hatch (see its doc comment);
  // that exists for a demo variant that would rather auto-route than fail, which this one isn't.
  const registry = await loadRegistry();
  function requireModel(id: string) {
    const entry = registry.find((m) => m.id === id);
    if (!entry) {
      throw new Error(`Model "${id}" not found in data/registry/models.json.`);
    }
    return entry;
  }
  const modelA = requireModel("llama-3.3-70b-novita");
  const modelB = requireModel("llama-3.3-70b-cloudflare");

  const snapshotFile = await latestPriceSnapshotFile("openrouter");
  const snapshot = await loadPriceSnapshot(snapshotFile);
  type PriceEntry = (typeof snapshot.entries)[number];
  function requirePrice(modelId: string): PriceEntry {
    const entry = snapshot.entries.find((e: PriceEntry) => e.model_id === modelId);
    if (!entry) {
      throw new Error(`No price for "${modelId}" in ${snapshotFile}.`);
    }
    return entry;
  }
  const priceA = requirePrice(modelA.id);
  const priceB = requirePrice(modelB.id);

  const buyerClients = clientsFor(deployerKey, rpcUrl);
  log(`[setup] buyer wallet: ${buyerClients.account.address}`);

  const sellerAFunded = await generateAndFundSeller(buyerClients, "seller-a");
  log(`[setup] seller-a wallet funded: ${sellerAFunded.account.address}`);
  const sellerBFunded = await generateAndFundSeller(buyerClients, "seller-b");
  log(`[setup] seller-b wallet funded: ${sellerBFunded.account.address}`);

  // A genuinely sized task, not a one-liner. The original one-sentence prompt settled around 14
  // USDC minor units real cost — under TouchstoneEscrow's MIN_SETTLEMENT = 100, which now
  // correctly reverts it. A real paid inference call looks more like this: a detailed,
  // structured answer, sized so even the cheaper of the two sellers (llama-3.3-70b-novita,
  // $0.40/1M output tokens) clears the floor with real margin and lands inside a realistic
  // $0.001-$0.10 range, not just barely above it. maxOutputTokens is a ceiling the model is free
  // to undershoot — real output length varies by model and run, so these numbers were tuned
  // against real live runs, not assumed correct from the arithmetic alone: an earlier "at least
  // 800 words" / 6000-token version settled at $0.000727 (727 minor units) — comfortably above
  // the floor, but under the intended $0.001 low end — so the length ask and ceiling were both
  // raised.
  const prompt =
    "Write a detailed, comprehensive explanation of how commodity benchmark price indices " +
    "work, using Dated Brent as a concrete example. Cover: what makes a reference price " +
    "trustworthy, how such indices are typically assembled and published on a rolling basis, " +
    "the difference between a spot assessment and a futures curve, how market participants " +
    "actually use the published number in real contracts, and at least two historical episodes " +
    "where the benchmark's mechanics mattered in practice. Use specific, concrete examples " +
    "throughout, and address counterarguments or edge cases where relevant. Aim for a thorough, " +
    "in-depth answer of at least 1400 words, organized into clearly labeled sections.";
  const maxOutputTokens = 8000;
  const quoteTtlSeconds = 3600;

  const sellerCommon = {
    openrouterApiKey: openrouterKey,
    escrowAddress,
    chainName,
    prompt,
    maxOutputTokens,
    quoteTtlSeconds,
    // Same rate for both sellers — the SIU spread the buyer sees comes only from the real cost
    // difference between the two models below, not from a hand-picked per-seller markup.
    rateUsdPerSiu: DEMO_ILLUSTRATIVE_USD_PER_SIU,
    log,
  };

  const sellerAApp = createSellerApp({
    ...sellerCommon,
    registryEntry: modelA,
    prices: priceA,
    label: "seller-a",
    clients: clientsFor(sellerAFunded.privateKey, rpcUrl),
    privateKeyHex: sellerAFunded.privateKey,
  });
  const sellerBApp = createSellerApp({
    ...sellerCommon,
    registryEntry: modelB,
    prices: priceB,
    label: "seller-b",
    clients: clientsFor(sellerBFunded.privateKey, rpcUrl),
    privateKeyHex: sellerBFunded.privateKey,
  });

  const sellerAServer = await listen(sellerAApp);
  const sellerBServer = await listen(sellerBApp);
  const sellerAPort = portOf(sellerAServer);
  const sellerBPort = portOf(sellerBServer);
  log(`[setup] seller-a listening on :${sellerAPort}, seller-b on :${sellerBPort}`);

  const settlementReader = new LocalSettlementReader({ chainName, rpcUrl, escrowAddress });
  const mcpApp = buildApp({
    attestationPrivateKeyHex: attestationKey,
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
