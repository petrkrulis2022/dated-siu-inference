import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Print } from "@datum/sdk";

const NON_PRINT_FILES = new Set(["latest.json", "index.json"]);

export interface PrintIndexEntry {
  print_id: string;
  date: string;
  status: "provisional" | "final";
  dated_siu: string;
}

/** Every published print, oldest first. Renders directly from data/prints/ — build1-spec.md §7. */
export async function loadAllPrints(printsDir: string): Promise<Print[]> {
  const files = (await readdir(printsDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".json") && !NON_PRINT_FILES.has(f),
  );
  const prints: Print[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(printsDir, f), "utf-8")) as Print),
  );
  prints.sort((a: Print, b: Print) => a.date.localeCompare(b.date));
  return prints;
}
