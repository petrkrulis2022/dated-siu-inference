import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { quoteHashHex, type TouchstoneQuote } from "@touchstone/sdk";

/**
 * No file anywhere in this repo persists a `touchstone-quote` after it's built and signed — on chain,
 * only its hash ever appears (`TouchstoneEscrow`'s `Opened` event). That makes "what was actually
 * quoted" unrecoverable after the fact for anyone reading chain state alone, which is exactly
 * what `packages/console`'s quoted-vs-paid panel needs to join against a settlement. This is a
 * console-convenience side effect, not part of the payment protocol itself — `mcp-server`'s
 * `verify_receipt` stays deliberately stateless; this file only ever runs from the seller's own
 * process, on its own machine, writing to the same gitignored, derived `data/.cache/` directory
 * the console's event indexer already uses.
 */
export function quotesCacheDir(): string {
  // pnpm always runs package scripts with cwd = the package directory.
  return resolve(process.cwd(), "../../data/.cache/quotes");
}

export async function logIssuedQuote(
  quote: TouchstoneQuote,
  dir: string = quotesCacheDir(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${quoteHashHex(quote)}.json`);
  await writeFile(path, `${JSON.stringify(quote, null, 2)}\n`, "utf-8");
  return path;
}
