/**
 * `pnpm --filter @touchstone/cr-lab run studio -- --seed <the run's real seed> --params <path> [--out <path>]`
 *
 * Agent Studio, screen 1 (Part 2 of the marketplace redesign): writes one self-contained HTML file — open it from disk, same convention as `reasoning-tagging`'s page, no
 * server, no new dependency. Shows every agent's full configuration from the parameters file it is given, with starting wallets from running genesis itself. `--seed` is
 * REQUIRED and has no default: the committed params file's own `seed` field ("dev-0") is a development default, never a real run's seed, and defaulting to it silently is
 * exactly the mistake D133 found in the scorer. `--params` is REQUIRED for the same reason (v3a Phase 2 item 6): it defaulted to the v1 file, so the committed page showed
 * v1's agents while v2 ran.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadParams } from "../economy/params.js";
import { loadCrPrint } from "../economy/runner.js";
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

const paramsPath = arg("params");
if (paramsPath === undefined) {
  console.error(
    "--params <path> is required (for example data/lab/cr/economy-params.v2.json); there is no default, because a silent default showed the v1 file's agents while v2 ran",
  );
  process.exit(2);
}

const params = loadParams(paramsPath);
const roster = buildRoster(params, seed, loadCrPrint());
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
