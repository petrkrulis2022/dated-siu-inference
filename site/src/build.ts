import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Print } from "@touchstone/sdk";
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

/**
 * Splits every published print by which grade it is — design-doc §4a "grades, not refineries".
 * `dated` (no `series`) is the blended Dated SIU headline, unchanged from before this field
 * existed; `commodity`/`frontier` are the same underlying runs, sliced by tier. Exported as a
 * pure function, separate from main()'s filesystem I/O, so the split itself is unit-testable
 * without a real data/prints/ directory on disk.
 */
export function partitionBySeries(prints: Print[]): {
  dated: Print[];
  commodity: Print[];
  frontier: Print[];
} {
  return {
    dated: prints.filter((p) => p.series === undefined),
    commodity: prints.filter((p) => p.series === "commodity"),
    frontier: prints.filter((p) => p.series === "frontier"),
  };
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

  const allPublishedPrints = await loadAllPrints(PRINTS_DIR);
  const incidents = await loadIncidents(INCIDENTS_DIR);
  const chain = await loadChainInfo(DEPLOYMENT_FILE);

  // All three series read from the one shared data/prints/ directory — a print's detail page
  // is only ever written once, at prints/<id>.html, regardless of which series it belongs to.
  const {
    dated: prints,
    commodity: commodityPrints,
    frontier: frontierPrints,
  } = partitionBySeries(allPublishedPrints);

  const toIndexEntry = (p: (typeof allPublishedPrints)[number]): PrintIndexEntry => ({
    print_id: p.print_id,
    date: p.date,
    status: p.status,
    dated_siu: p.dated_siu,
    superseded_by: p.superseded_by,
    constituent_changes: p.constituent_changes,
    series: p.series,
  });
  const allPrints: PrintIndexEntry[] = prints.map(toIndexEntry);
  const commodityIndexEntries = commodityPrints.map(toIndexEntry);
  const frontierIndexEntries = frontierPrints.map(toIndexEntry);
  const indexEntriesBySeries = { frontier: frontierIndexEntries, commodity: commodityIndexEntries };

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
  // over every print instead of the latest one). Every print's detail page — Dated SIU,
  // Commodity SIU and Frontier SIU alike — is written here, in the single shared directory;
  // the tier pages below only ever link into it, never duplicate it.
  await writeHtml(
    join(OUT_DIR, "prints", "index.html"),
    renderLayout({
      title: "Touchstone Assay — Prints",
      bodyHtml: renderPrintsList({ allPrints: prints, incidents, basePath: "../", chain }),
      basePath: "../",
    }),
  );
  for (const print of allPublishedPrints) {
    // A print's own detail page — its change-note and "All prints" archive — compares against
    // its own series only. A Commodity SIU print sits beside other Commodity SIU prints, not
    // Dated SIU's, even though every detail page lives in the one shared prints/ directory.
    const seriesIndexEntries = print.series ? indexEntriesBySeries[print.series] : allPrints;
    const datedHtml = renderLayout({
      title: `${print.series === "frontier" ? "Frontier SIU" : print.series === "commodity" ? "Commodity SIU" : "Dated SIU"} — ${print.date} (${print.status})`,
      bodyHtml: renderPrintPage({
        print,
        allPrints: seriesIndexEntries,
        basePath: "../",
        runsBaseUrl: RUNS_BASE_URL,
        chain,
      }),
      basePath: "../",
    });
    await writeHtml(join(OUT_DIR, "prints", `${print.print_id}.html`), datedHtml);
  }

  // FRONTIER SIU / COMMODITY SIU — tier prints, same renderers as the blended series above,
  // called with each tier's own filtered prints and basePath adjusted for the extra nesting
  // level. detailBasePath stays pointed at the single shared /prints/ directory (one level up
  // from these tier pages, two up from their own prints/index.html list) since print detail
  // pages are never duplicated per tier — only written once, above.
  const tierSeries: {
    series: "frontier" | "commodity";
    label: string;
    tierPrints: Print[];
    tierIndexEntries: PrintIndexEntry[];
  }[] = [
    {
      series: "frontier",
      label: "Frontier SIU",
      tierPrints: frontierPrints,
      tierIndexEntries: frontierIndexEntries,
    },
    {
      series: "commodity",
      label: "Commodity SIU",
      tierPrints: commodityPrints,
      tierIndexEntries: commodityIndexEntries,
    },
  ];
  for (const { series, label, tierPrints, tierIndexEntries } of tierSeries) {
    await writeHtml(
      join(OUT_DIR, series, "index.html"),
      renderLayout({
        title: `Touchstone Assay — ${label}`,
        bodyHtml: renderSeriesPage({
          allPrints: tierIndexEntries,
          basePath: "",
          detailBasePath: "../",
          seriesLabel: label,
        }),
        basePath: "../",
      }),
    );
    await writeHtml(
      join(OUT_DIR, series, "prints", "index.html"),
      renderLayout({
        title: `Touchstone Assay — ${label} Prints`,
        bodyHtml: renderPrintsList({
          allPrints: tierPrints,
          basePath: "../../",
          chain,
          seriesLabel: label,
        }),
        basePath: "../../",
      }),
    );
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
    `Built Series, Prints (${prints.length}, ${incidents.length} missed), Models, ` +
      `Frontier SIU (${frontierPrints.length}) and Commodity SIU (${commodityPrints.length}) -> ${OUT_DIR}`,
  );
}

// Guarded so importing this module (build.test.ts, testing partitionBySeries in isolation)
// doesn't also trigger the whole filesystem-writing build as a side effect — only running it
// directly as the CLI entry point (`node dist/build.js`) does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
