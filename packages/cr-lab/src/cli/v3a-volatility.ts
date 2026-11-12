/**
 * `pnpm --filter @touchstone/cr-lab run v3a-volatility -- [--ref origin/main] [--grade commodity]`
 *
 * Measures v3a's low-volatility setting (docs/experiment-3a-design.md, "Prints"): the daily volatility of the real published Dated SIU history, read with git from a ref
 * (default origin/main, where the print pipeline publishes), so the measure names exactly which history it read. The fixed-basket Commodity grade print is the series the
 * v3a path stands for; the main print and the Frontier grade are reported beside it for comparison. Read-only.
 */
import { execFileSync } from "node:child_process";
import { dailyVolatility, type DatedPrint } from "../economy/price-path.js";
import { REPO_ROOT } from "../paths.js";

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] as string) : dflt;
};
const ref = arg("ref", "origin/main");
const git = (...a: string[]): string => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 64 << 20 });
const commit = git("rev-parse", "--short", ref).trim();
const names = git("ls-tree", "--name-only", ref, "data/prints/").split("\n");

function series(suffix: string): DatedPrint[] {
  const re = new RegExp(`^data/prints/(\\d{4}-\\d{2}-\\d{2})${suffix}\\.json$`);
  const out: DatedPrint[] = [];
  for (const n of names) {
    const m = re.exec(n);
    if (m === null) continue;
    const p = JSON.parse(git("show", `${ref}:${n}`)) as { dated_siu?: string };
    if (typeof p.dated_siu === "string") out.push({ date: m[1] as string, datedSiu: p.dated_siu });
  }
  return out;
}

const pct = (ppm: bigint): string => `${(Number(ppm) / 10_000).toFixed(4)}%`;
console.log(`real Dated SIU history at ${ref} (${commit}):`);
for (const [name, suffix] of [
  ["commodity grade (the v3a low setting)", "-commodity"],
  ["frontier grade", "-frontier"],
  ["main print", ""],
] as const) {
  const v = dailyVolatility(series(suffix));
  console.log(
    `  ${name}: ${v.first}..${v.last}, ${v.pairs} one-day moves, daily volatility ${pct(v.sdPpm)} (${v.sdPpm} ppm), largest move ${pct(v.maxMove.ppm)} on ${v.maxMove.date}`,
  );
}
