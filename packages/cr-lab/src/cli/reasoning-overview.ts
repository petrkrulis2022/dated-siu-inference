/**
 * One window's reasoning overview (D107), written to the private tables directory: what each model returned of its reasoning, and which MCP sessions carry an objective flag. Spends nothing,
 * calls nothing, reads no key. The file can restate licensed figures, so it is private; this command prints only counts and the path.
 *
 *   pnpm --filter @touchstone/cr-lab run reasoning-overview [-- --window 2026-10-18]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildReasoningOverview, fileSessionLoader } from "../reasoning/overview.js";
import { FileRecordStore, tablesDir } from "../runner/records.js";

const argv = process.argv.slice(2);
const i = argv.indexOf("--window");
const store = new FileRecordStore();
const window = (i >= 0 ? argv[i + 1] : undefined) ?? store.windows().at(-1);
if (window === undefined) {
  console.error("no window has any records yet");
  process.exit(1);
}
const records = store.forWindow(window);
if (records.length === 0) {
  console.error(`no records for ${window}`);
  process.exit(1);
}
const { markdown, readings } = buildReasoningOverview(records, fileSessionLoader(), { window });
const file = tablesDir(`${window}-reasoning.md`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, markdown, { mode: 0o600 });
const flagged = readings.filter((r) => r.flags.length > 0).length;
console.log(
  `${records.length} answers in ${window}, ${flagged} sessions with a flag. Overview written (private): ${file}`,
);
