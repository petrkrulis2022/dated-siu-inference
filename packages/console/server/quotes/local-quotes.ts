import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TouchstoneQuote } from "@touchstone/sdk";

/**
 * Reads whatever `packages/agents`' `logIssuedQuote` has written to `data/.cache/quotes/` —
 * purely a reader. If the directory doesn't exist yet (no demo agent has run), returns an empty
 * map rather than throwing: "no locally known quotes" is a legitimate, common state, not an
 * error.
 */
export async function loadLocalQuotes(dir: string): Promise<Map<string, TouchstoneQuote>> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const map = new Map<string, TouchstoneQuote>();
  await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        const quote = JSON.parse(await readFile(join(dir, f), "utf-8")) as TouchstoneQuote;
        const quoteHash = f.replace(/\.json$/, "");
        map.set(quoteHash.toLowerCase(), quote);
      }),
  );
  return map;
}
