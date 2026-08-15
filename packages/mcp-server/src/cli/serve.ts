import { buildApp } from "../server.js";
import { loadPublisherKeyFromEnv, loadSellerAddressFromEnv } from "../env.js";

async function main(): Promise<void> {
  // Fail before listening, not on the first request — an unconfigured server that starts
  // "successfully" and then errors per-request is a worse failure mode to discover.
  const publisherPrivateKeyHex = loadPublisherKeyFromEnv();
  const sellerAddress = loadSellerAddressFromEnv();

  const app = buildApp({ publisherPrivateKeyHex, paywall: { sellerAddress } });
  const port = Number(process.env.PORT ?? 3000);

  app.listen(port, () => {
    console.log(`Datum MCP server listening on http://localhost:${port}/mcp`);
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
