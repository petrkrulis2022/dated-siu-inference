import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Print } from "@touchstone/sdk";

export interface WritePrintResult {
  path: string;
  latestPath: string;
}

/**
 * Writes a print to data/prints/YYYY-MM-DD.json and refreshes latest.json as a copy of it —
 * build1-spec.md §7.
 *
 * Refuses to overwrite an existing FINAL print for that date: a final print has been
 * reconciled against a real invoice and is the number the public referenced. A provisional
 * print for the same date may be overwritten (e.g. re-running publish before reconciliation),
 * since nothing has been reconciled against it yet.
 */
export async function writePrint(printsDir: string, print: Print): Promise<WritePrintResult> {
  await mkdir(printsDir, { recursive: true });
  const path = join(printsDir, `${print.date}.json`);

  const existing = await readFile(path, "utf-8")
    .then((raw) => JSON.parse(raw) as Print)
    .catch(() => undefined);
  if (existing?.status === "final") {
    throw new Error(
      `Refusing to overwrite ${path}: it is already final. A reconciled, published print is not republished.`,
    );
  }

  const json = `${JSON.stringify(print, null, 2)}\n`;
  await writeFile(path, json, "utf-8");

  const latestPath = join(printsDir, "latest.json");
  await writeFile(latestPath, json, "utf-8");

  return { path, latestPath };
}

export interface PrintIndexEntry {
  print_id: string;
  date: string;
  status: "provisional" | "final";
  dated_siu: string;
}

const NON_PRINT_FILES = new Set(["latest.json", "index.json"]);

export async function listPrintFiles(printsDir: string): Promise<string[]> {
  const files = await readdir(printsDir).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".json") && !NON_PRINT_FILES.has(f));
}

/** All prints, oldest first, for the index file and for "previous prints" links on the site. */
export async function buildPrintsIndex(printsDir: string): Promise<PrintIndexEntry[]> {
  const files = await listPrintFiles(printsDir);
  const entries = await Promise.all(
    files.map(async (f) => {
      const print = JSON.parse(await readFile(join(printsDir, f), "utf-8")) as Print;
      return {
        print_id: print.print_id,
        date: print.date,
        status: print.status,
        dated_siu: print.dated_siu,
      };
    }),
  );
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

export async function writePrintsIndex(printsDir: string): Promise<string> {
  const entries = await buildPrintsIndex(printsDir);
  const path = join(printsDir, "index.json");
  await writeFile(path, `${JSON.stringify(entries, null, 2)}\n`, "utf-8");
  return path;
}
