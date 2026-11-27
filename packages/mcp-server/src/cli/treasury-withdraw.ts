import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { assertGitIgnored } from "../private-output.js";
import type { GatewayEnvironment } from "../treasury/gateway-withdrawal.js";
import { createWithdrawHandler, type WithdrawalRecord } from "../treasury/withdraw-server.js";
import { WALLET_LABELS } from "../workers/wallet-labels.js";

/** Each withdrawal's record lands here (gitignored): what was signed, Circle's answer, the mint. */
const RECORD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/private/withdrawals");

async function writeRecord(r: WithdrawalRecord): Promise<void> {
  const path = join(RECORD_DIR, `${r.attestedAt.replace(/[:.]/g, "-")}-${r.network}-${r.chain}-${r.id}.json`);
  assertGitIgnored(path);
  await mkdir(RECORD_DIR, { recursive: true });
  await writeFile(`${path}.partial`, JSON.stringify(r, null, 2) + "\n", "utf-8");
  await rename(`${path}.partial`, path);
}

/**
 * The treasury withdrawal page, on 127.0.0.1 only:
 *
 *   pnpm --filter @touchstone/mcp-server run treasury:withdraw -- --network testnet|mainnet [--port 4700] [--treasury 0x…]
 *
 * --treasury defaults to TOUCHSTONE_MAINNET_TREASURY from the environment, and must be one of
 * Touchstone's own wallets (workers/wallet-labels.ts). Open the printed address in the browser
 * where MetaMask holds that account on the hardware wallet. Nothing here holds or asks for a key.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const network = arg("network");
  if (network !== "mainnet" && network !== "testnet") throw new Error("pass --network testnet or --network mainnet");
  const port = Number(arg("port") ?? 4700);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024-65535");
  const raw = arg("treasury") ?? process.env.TOUCHSTONE_MAINNET_TREASURY;
  if (!raw || !isAddress(raw)) throw new Error("pass --treasury 0x… or set TOUCHSTONE_MAINNET_TREASURY");
  const treasury = getAddress(raw);
  if (!WALLET_LABELS.some((w) => w.address.toLowerCase() === treasury.toLowerCase()))
    throw new Error(`${treasury} is not one of Touchstone's wallets (workers/wallet-labels.ts); refusing`);
  assertGitIgnored(join(RECORD_DIR, "probe.json"));
  const handler = createWithdrawHandler({
    env: network as GatewayEnvironment,
    treasury,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    record: writeRecord,
  });
  createServer((req, res) => void handler(req, res)).listen(port, "127.0.0.1", () => {
    console.log(`Treasury withdrawal (${network.toUpperCase()}) for ${treasury}; records in ${RECORD_DIR}`);
    console.log(`Open http://127.0.0.1:${port} in the browser where MetaMask holds the treasury account. Ctrl-C to stop.`);
  });
}

try {
  main();
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
