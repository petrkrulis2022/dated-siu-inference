/**
 * `pnpm --filter @touchstone/cr-lab run v3a-pass-rates -- --records <the trial's records directory> --label <how to name it in the export> [--out <path>]`
 *
 * Writes v3a's issuer pass-rate table (`economy/v3a-pass-rates.ts`) from the Blockworks trial's answer ledger, read-only: only `part`, `model`, `task` and `passed` are read,
 * and only counts are written, with every source file's sha256. The output carries no Blockworks data, so it is committed with the v3a config, which pins its hash.
 * `--out` never overwrites an existing file.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exportPassRates } from "../economy/v3a-pass-rates.js";
import { CR_PUBLIC_DIR } from "../paths.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const records = arg("records");
const label = arg("label");
if (records === undefined || label === undefined) {
  console.error("--records <the trial's records directory> and --label <its name in the export> are required");
  process.exit(2);
}
const out = arg("out") ?? join(CR_PUBLIC_DIR, "v3a", "pass-rates.json");
if (existsSync(out)) {
  console.error(`${out} already exists; the export never overwrites. Remove it deliberately or write to a new path.`);
  process.exit(2);
}
const e = exportPassRates(records, label);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(e, null, 1)}\n`);
console.log(`${e.files.length} ledger files, source sha256 ${e.sourceSha256}; wrote ${out}`);
for (const [issuer, byTask] of Object.entries(e.issuers))
  console.log(`  ${issuer}: ${Object.entries(byTask).map(([t, r]) => `${t} ${(r.bps / 100).toFixed(2)}%`).join(", ")}`);
