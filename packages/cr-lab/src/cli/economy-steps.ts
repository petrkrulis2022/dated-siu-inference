/**
 * `pnpm --filter @touchstone/cr-lab run economy-steps -- --log <path to a run's log.jsonl> --agent <agent id> [--out <path>]`
 *
 * Writes one self-contained HTML file showing ONE agent's full step-by-step turns from a run's own ordered log -- same convention as `studio.ts`'s page: no server, no new
 * dependency, opened from disk. Built for the marketplace redesign v2 dev-test's "show an example of one agent's step-by-step reasoning" deliverable.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadLog, renderStepPage } from "../economy/step-page.js";
import { CR_PUBLIC_DIR } from "../paths.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const logPath = arg("log");
const agent = arg("agent");
if (logPath === undefined || agent === undefined) {
  console.error("--log <path to a run's log.jsonl> and --agent <agent id> are both required");
  process.exit(2);
}

const log = loadLog(logPath);
const page = renderStepPage(log, agent);
const out = arg("out", join(CR_PUBLIC_DIR, "studio", `steps-${agent}.html`)) as string;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page, { mode: 0o600 });

function windowsPath(p: string): string {
  const distro = process.env.WSL_DISTRO_NAME;
  const abs = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
  return distro === undefined ? abs : `\\\\wsl.localhost\\${distro}${abs.replace(/\//g, "\\")}`;
}

console.log(`${agent}'s steps written. Open this file in a browser:\n  ${windowsPath(out)}`);
