import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Print, RunRecord } from "@touchstone/sdk";

export interface WritePrintResult {
  path: string;
  latestPath: string;
}

/**
 * Writes a print to data/prints/<print_id>.json and, for the blended Dated SIU print only,
 * refreshes latest.json as a copy of it — build1-spec.md §7. Keyed by `print_id`, not `date`:
 * every other path that touches a print by identity (runsDirFor, verify.ts, verify-onchain.ts,
 * compute.ts) already keys off `print_id`, and `print_id` is what's guaranteed unique — `date`
 * is descriptive, not the identifier, and two distinct print_ids can legitimately share a date
 * (e.g. a same-day re-run).
 *
 * **`latest.json` is scoped to `series === undefined` (Dated SIU) deliberately.** Found live: it
 * used to be refreshed unconditionally by every write, so on a day Commodity SIU and Frontier
 * SIU both published (after Dated SIU, in the same script run — publish-unattended.ts's tier
 * loop), `latest.json` ended up pointing at whichever tier print happened to be written last —
 * Frontier SIU, not Dated SIU. Every reader that means "the current print" by `latest.json`
 * (the Cloudflare Workers deployment's `loadLatestPrint`, which backs the free `get_index` tool
 * and every paid tool's own pre-check) silently served the wrong series' data as a result — not
 * an error, a wrong answer, on the one tool this project most needs to be trustworthy. A tier
 * print is still written to its own `data/prints/<print_id>.json` exactly as before; it just
 * never touches the one file every "current print" reader trusts.
 *
 * Print writes are append-only, unconditionally. This used to refuse only an existing FINAL
 * print, on the theory that "provisional" meant "not yet reconciled, safe to redo." It doesn't:
 * provisional means "not yet reconciled," not "safe to destroy." A print that has been signed,
 * written, and (usually) anchored is a real artifact from the moment it exists — a live incident
 * showed exactly why this matters: a print's file was silently overwritten by a second run that
 * happened to collide on the same filename, while its on-chain anchor stayed put, briefly leaving
 * an anchored hash with no corresponding published content anywhere. Corrections to an existing
 * print belong in a numbered revision alongside the original (the methodology's revision policy),
 * never as a second write to the same path.
 */
export async function writePrint(printsDir: string, print: Print): Promise<WritePrintResult> {
  await mkdir(printsDir, { recursive: true });
  const path = join(printsDir, `${print.print_id}.json`);

  const alreadyExists = await access(path)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    throw new Error(
      `Refusing to overwrite ${path}: a print already exists at this path. Print writes are ` +
        `append-only — a correction is published as a numbered revision alongside the ` +
        `original, never a second write to the same print_id.`,
    );
  }

  const json = `${JSON.stringify(print, null, 2)}\n`;
  await writeFile(path, json, "utf-8");

  const latestPath = join(printsDir, "latest.json");
  if (print.series === undefined) {
    await writeFile(latestPath, json, "utf-8");
  }

  return { path, latestPath };
}

/**
 * Writes data/runs/<print_id>/index.json — the declared, authoritative list of the run-record
 * files that were actually used to compute `print` (docs/methodology.md's reproducibility
 * section). Not derived by re-scanning `runsDir`: a same-print_id retry (a scheduled run that
 * fails the qualifying-set gate, then a same-day manual retry) writes fresh run records into the
 * same directory as an earlier failed attempt's leftovers, so a directory listing is not
 * guaranteed to match what actually went into the print. `records` must be exactly what the
 * caller already used to compute `print` — publishPrint passes `input.models`' own records,
 * never a fresh read.
 *
 * Append-only, same as writePrint: a manifest, once declared, is as permanent as the print it
 * describes.
 */
export async function writeRunManifest(
  runsDir: string,
  print: Print,
  records: RunRecord[],
): Promise<string> {
  await mkdir(runsDir, { recursive: true });
  const path = join(runsDir, "index.json");

  const alreadyExists = await access(path)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    throw new Error(
      `Refusing to overwrite ${path}: a run manifest already exists for this print_id.`,
    );
  }

  const manifest = {
    print_id: print.print_id,
    basket_version: print.version,
    methodology_version: print.methodology_version,
    run_records: records.map((r) => `${r.run_id}.json`).sort(),
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return path;
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
