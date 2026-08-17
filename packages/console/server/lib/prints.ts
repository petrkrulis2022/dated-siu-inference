import { join } from "node:path";
import type { Print } from "@datum/sdk";
import { listPrintFiles, loadPrint, printsDir } from "@datum/print";

/**
 * Every published print, oldest first. Thin wrapper over `@datum/print`'s own
 * `listPrintFiles`/`loadPrint` — no parsing logic of its own, per the console's
 * reuse-not-reimplementation constraint.
 */
export async function loadAllPrints(dir: string = printsDir()): Promise<Print[]> {
  const files = await listPrintFiles(dir);
  const prints = await Promise.all(files.map((f: string) => loadPrint(join(dir, f))));
  return prints.sort((a: Print, b: Print) => a.date.localeCompare(b.date));
}
