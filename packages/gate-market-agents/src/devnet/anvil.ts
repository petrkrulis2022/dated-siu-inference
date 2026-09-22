import { type ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";
import { createTestClient, http, publicActions } from "viem";

/**
 * Anvil's own well-known, publicly-documented default account #0 — the same constant every
 * Foundry tutorial uses, printed to anvil's own startup banner. Zero real value: this only ever
 * signs against an ephemeral local devnet this module itself starts and tears down.
 */
export const ANVIL_DEFAULT_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface LocalDevnet {
  rpcUrl: string;
  stop: () => Promise<void>;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("findFreePort: could not determine an ephemeral port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (response.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `anvil did not become ready on ${rpcUrl} within ${timeoutMs}ms. Last error: ${String(lastError)}`,
  );
}

/** Spawns a fresh anvil instance on an ephemeral local port, waits until its RPC actually
 * answers (not just "the process started" — anvil takes a moment to bind), and returns a
 * `stop()` that kills it. One instance per test file, per this package's WP-5 plan. */
export async function startAnvil(): Promise<LocalDevnet> {
  const port = await findFreePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn("anvil", ["--port", String(port), "--silent"], {
    stdio: "ignore",
  });

  const exitedEarly = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`anvil exited early with code ${code} before becoming ready.`));
      }
    });
  });

  await Promise.race([waitForRpcReady(rpcUrl, 15_000), exitedEarly]);

  return {
    rpcUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

/** Advances the devnet's clock past a window close — anvil-specific test RPC methods
 * (`evm_increaseTime`/`evm_mine`), needed for the Default scenario (§4.5's third forced state)
 * to actually reach a closed window without waiting in real wall-clock time. */
export async function advanceTime(rpcUrl: string, seconds: number): Promise<void> {
  const testClient = createTestClient({ mode: "anvil", transport: http(rpcUrl) }).extend(
    publicActions,
  );
  await testClient.increaseTime({ seconds });
  await testClient.mine({ blocks: 1 });
}
