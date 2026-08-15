import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadAllPrints, type PrintIndexEntry } from "./data.js";
import { renderLayout } from "./render/layout.js";
import { renderPrintPage } from "./render/print-page.js";

// pnpm --filter site run build => cwd = site/, which sits directly at the repo root.
const REPO_ROOT = resolve(process.cwd(), "..");
const PRINTS_DIR = join(REPO_ROOT, "data/prints");
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

function renderEmptyState(): string {
  return `<div class="empty-state">
    <p>No print has been published yet. Once <code>publish-print</code> runs, this page renders the latest one directly from <code>data/prints/</code>.</p>
  </div>`;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await cp(join(STATIC_DIR, "styles.css"), join(OUT_DIR, "styles.css"));

  const prints = await loadAllPrints(PRINTS_DIR);

  if (prints.length === 0) {
    await writeHtml(
      join(OUT_DIR, "index.html"),
      renderLayout({ title: "Dated SIU", bodyHtml: renderEmptyState(), basePath: "" }),
    );
    console.log(`No prints found in ${PRINTS_DIR} — wrote an empty-state index.html only.`);
    return;
  }

  const allPrints: PrintIndexEntry[] = prints.map((p) => ({
    print_id: p.print_id,
    date: p.date,
    status: p.status,
    dated_siu: p.dated_siu,
  }));
  const latest = prints[prints.length - 1];

  for (const print of prints) {
    // The dated, permanent URL always lives one level deep: prints/YYYY-MM-DD.html.
    const datedHtml = renderLayout({
      title: `Dated SIU — ${print.date} (${print.status})`,
      bodyHtml: renderPrintPage({ print, allPrints, basePath: "../", runsBaseUrl: RUNS_BASE_URL }),
      basePath: "../",
    });
    await writeHtml(join(OUT_DIR, "prints", `${print.date}.html`), datedHtml);

    // The latest print is ALSO the site root — rendered separately, not reused, since its
    // links are one directory shallower than the dated page's.
    if (print.print_id === latest.print_id) {
      const indexHtml = renderLayout({
        title: `Dated SIU — ${print.date} (${print.status})`,
        bodyHtml: renderPrintPage({ print, allPrints, basePath: "", runsBaseUrl: RUNS_BASE_URL }),
        basePath: "",
      });
      await writeHtml(join(OUT_DIR, "index.html"), indexHtml);
    }
  }

  console.log(`Built ${prints.length} print page(s) -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
