/**
 * `pnpm --filter @touchstone/cr-lab run economy-steps -- --log <path to a run's log.jsonl> --agent <agent id> [--out <path>]`
 * `pnpm --filter @touchstone/cr-lab run economy-steps -- --log <path> --all [--scoring <path to scoring.md>] [--out <path>]`
 *
 * Writes one self-contained HTML file from a run's own ordered log -- same convention as `studio.ts`'s page: no server, no new dependency, opened from disk.
 * `--agent` writes one agent's own page; `--all` writes ONE combined page covering every model agent that reasoned in the log (auto-detected from the log
 * itself, nothing from params), with a sidebar nav and, when `--scoring` is given, that run's pre-registered scoring text verbatim at the top.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadLog, modelAgentsIn, renderCombinedRunPage, renderStepPage } from "../economy/step-page.js";
import { CR_PUBLIC_DIR } from "../paths.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function windowsPath(p: string): string {
  const distro = process.env.WSL_DISTRO_NAME;
  const abs = p.startsWith("/") ? p : `${process.cwd()}/${p}`;
  return distro === undefined ? abs : `\\\\wsl.localhost\\${distro}${abs.replace(/\//g, "\\")}`;
}

const logPath = arg("log");
if (logPath === undefined) {
  console.error("--log <path to a run's log.jsonl> is required");
  process.exit(2);
}
const log = loadLog(logPath);

if (flag("all")) {
  const agents = modelAgentsIn(log);
  const scoringPath = arg("scoring");
  const scoringText = scoringPath === undefined ? undefined : readFileSync(scoringPath, "utf-8");
  const runId = logPath.split("/").filter((s) => s !== "").at(-2);
  const page = renderCombinedRunPage(log, agents, { scoringText, runId });
  const out = arg("out", join(CR_PUBLIC_DIR, "studio", "run-reasoning.html")) as string;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page, { mode: 0o600 });
  console.log(
    `${agents.length} agents' steps written to one page${scoringText === undefined ? "" : " (with scoring)"}. Open this file in a browser:\n  ${windowsPath(out)}`,
  );
} else {
  const agent = arg("agent");
  if (agent === undefined) {
    console.error("--agent <agent id> is required (or pass --all for every agent in one page)");
    process.exit(2);
  }
  const page = renderStepPage(log, agent);
  const out = arg("out", join(CR_PUBLIC_DIR, "studio", `steps-${agent}.html`)) as string;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page, { mode: 0o600 });
  console.log(`${agent}'s steps written. Open this file in a browser:\n  ${windowsPath(out)}`);
}
