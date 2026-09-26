import { join } from "node:path";
import { writeRunManifest } from "../publication.js";
import { loadPrint, loadRunRecords, printsDir, runsDirFor } from "./load-inputs.js";

/**
 * Writes the missing data/runs/<print_id>/index.json for a print published before the run
 * manifest system shipped (build1-spec.md's own append-only guard on writeRunManifest refuses to
 * touch a print that already has one, so this is safe to run repeatedly / against every old
 * print without risk of overwriting a real, already-declared manifest).
 *
 * Reconstructs from whatever run-record files are on disk TODAY, via loadRunRecords (a directory
 * listing) — the one documented, legitimate use of that function for a print that already exists
 * is exactly this: there is no other source of truth for a print old enough to predate the
 * manifest system, and (unlike a same-day retry directory, which loadRunRecords' own doc comment
 * warns against reading this way) these specific early print_ids never had a same-day retry
 * leftover problem — each retry got its own distinct print_id suffix (e.g. 2026-08-22b) instead.
 * Found live, 2026-09-26 while building cli/verify-all.ts: this script was referenced by
 * load-inputs.ts's own error message since the manifest system shipped, but never actually
 * written — every print old enough to need it silently fell back to a signature-only check
 * instead of ever failing loudly, which is how the gap went unnoticed.
 */
const printId = process.argv[2];
if (!printId) {
  console.error("Usage: backfill-run-manifest <print-id>");
  process.exit(1);
}

const print = await loadPrint(join(printsDir(), `${printId}.json`));
const records = await loadRunRecords(printId);
const path = await writeRunManifest(runsDirFor(printId), print, records);
console.log(`Wrote ${path} (${records.length} run record(s)).`);
