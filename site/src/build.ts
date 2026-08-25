import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  loadAllPrints,
  loadChainInfo,
  loadIncidents,
  loadRunRecordsFor,
  type PrintIndexEntry,
} from "./data.js";
import { renderLayout } from "./render/layout.js";
import { renderPrintPage } from "./render/print-page.js";
import { renderSeriesPage } from "./render/series-page.js";
import { renderPrintsList } from "./render/prints-list.js";
import { renderModelsPage, type ModelGatePoint } from "./render/models-page.js";

// pnpm --filter site run build => cwd = site/, which sits directly at the repo root.
const REPO_ROOT = resolve(process.cwd(), "..");
const PRINTS_DIR = join(REPO_ROOT, "data/prints");
const RUNS_DIR = join(REPO_ROOT, "data/runs");
const INCIDENTS_DIR = join(REPO_ROOT, "data/prints/incidents");
const DEPLOYMENT_FILE = join(REPO_ROOT, "data/deployments/base-sepolia.json");
// Deliberately not "dist" — tsc already compiles this package's own TypeScript to dist/, and
// writing the deployable HTML/CSS site into the same directory would mix generator tooling
// output with the thing meant to be deployed. "public/" is the conventional, unambiguous name
// for a static site's deployable output.
const OUT_DIR = resolve(process.cwd(), "public");
const STATIC_DIR = resolve(process.cwd(), "static");

// CLAUDE.md: "data/prints/ being a public git repo is the publication strategy" — the same is
// true of data/runs/, so "link to the raw runs" points at that path in the published repo.
const RUNS_BASE_URL = "https://github.com/petrkrulis2022/dated-siu-inference/tree/main/data/runs";

async function writeHtml(path: string, html: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, "utf-8");
}

async function buildGateHistory(printIds: string[]): Promise<Record<string, ModelGatePoint[]>> {
  const gateHistory: Record<string, ModelGatePoint[]> = {};
  for (const printId of printIds) {
    const records = await loadRunRecordsFor(RUNS_DIR, printId);
    for (const record of records) {
      const points = gateHistory[record.model_id] ?? [];
      points.push({ print_id: printId, task_class: record.task_class, passed: record.gate_passed });
      gateHistory[record.model_id] = points;
    }
  }
  return gateHistory;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await cp(join(STATIC_DIR, "styles.css"), join(OUT_DIR, "styles.css"));

  const prints = await loadAllPrints(PRINTS_DIR);
  const incidents = await loadIncidents(INCIDENTS_DIR);
  const chain = await loadChainInfo(DEPLOYMENT_FILE);
  const allPrints: PrintIndexEntry[] = prints.map((p) => ({
    print_id: p.print_id,
    date: p.date,
    status: p.status,
    dated_siu: p.dated_siu,
    superseded_by: p.superseded_by,
  }));

  // SERIES — the public landing page.
  await writeHtml(
    join(OUT_DIR, "index.html"),
    renderLayout({
      title: "Touchstone Assay — Dated SIU",
      bodyHtml: renderSeriesPage({ allPrints, incidents, basePath: "" }),
      basePath: "",
    }),
  );

  // PRINTS — the list, plus one detail page per print (unchanged structure, just parameterised
  // over every print instead of the latest one).
  await writeHtml(
    join(OUT_DIR, "prints", "index.html"),
    renderLayout({
      title: "Touchstone Assay — Prints",
      bodyHtml: renderPrintsList({ allPrints: prints, incidents, basePath: "../", chain }),
      basePath: "../",
    }),
  );
  for (const print of prints) {
    const datedHtml = renderLayout({
      title: `Dated SIU — ${print.date} (${print.status})`,
      bodyHtml: renderPrintPage({
        print,
        allPrints,
        basePath: "../",
        runsBaseUrl: RUNS_BASE_URL,
        chain,
      }),
      basePath: "../",
    });
    await writeHtml(join(OUT_DIR, "prints", `${print.print_id}.html`), datedHtml);
  }

  // MODELS — per-model rate/spread history plus gate pass/fail history.
  const gateHistory = await buildGateHistory(prints.map((p) => p.print_id));
  await writeHtml(
    join(OUT_DIR, "models", "index.html"),
    renderLayout({
      title: "Touchstone Assay — Models",
      bodyHtml: renderModelsPage({ allPrints: prints, gateHistory, basePath: "../" }),
      basePath: "../",
    }),
  );

  console.log(
    `Built Series, Prints (${prints.length}, ${incidents.length} missed) and Models -> ${OUT_DIR}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
