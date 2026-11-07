/**
 * `pnpm --filter @touchstone/cr-lab run studio -- --seed <the run's real seed> [--params <path>] [--out <path>]`
 *
 * Agent Studio, screen 1 (Part 2 of the marketplace redesign): writes one self-contained HTML file — open it from disk, same convention as `reasoning-tagging`'s page, no
 * server, no new dependency. Shows the seven agents' full configuration from the committed parameters file. `--seed` is REQUIRED and has no default: the committed params
 * file's own `seed` field ("dev-0") is a development default, never a real run's seed, and defaulting to it silently is exactly the mistake D133 found in the scorer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadParams, PARAMS_PATH } from "../economy/params.js";
import { buildRoster } from "../studio/roster.js";
import { renderStudioPage } from "../studio/studio-page.js";
import { CR_PUBLIC_DIR } from "../paths.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const seed = arg("seed");
if (seed === undefined) {
  console.error(
    '--seed <the run\'s real seed> is required (for example "counted-2026-11-06"); there is no default, because the committed params file\'s own seed ("dev-0") is a development default, never a real run\'s seed',
  );
  process.exit(2);
}

const params = loadParams(arg("params", PARAMS_PATH));
const roster = buildRoster(params, seed);
const page = renderStudioPage(roster);

const out = arg("out", join(CR_PUBLIC_DIR, "studio", "agents.html")) as string;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, { mode: 0o600 });

/** Where a Windows browser can find a WSL path (same helper as `reasoning-tagging`). */
function windowsPath(p: string): string {
  const distro = process.env.WSL_DISTRO_NAME;
  const abs = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
  return distro === undefined ? abs : `\\\\wsl.localhost\\${distro}${abs.replace(/\//g, "\\")}`;
}

console.log(`${roster.agents.length} agents written. Open this file in a browser:\n  ${windowsPath(out)}`);
