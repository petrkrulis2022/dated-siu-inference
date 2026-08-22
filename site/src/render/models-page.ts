import type { Print } from "@touchstone/sdk";
import { esc, formatDate, percent, usd } from "../format.js";

export interface ModelGatePoint {
  print_id: string;
  task_class: string;
  passed: boolean;
}

export interface ModelsPageOptions {
  /** Every published print, oldest first — rate history is computed from this directly. */
  allPrints: Print[];
  /** Pre-loaded by build.ts (needs data/runs/ I/O), keyed by model_id. */
  gateHistory: Record<string, ModelGatePoint[]>;
  /** "../" — this page always lives one level deep, at models/index.html. */
  basePath: string;
}

interface RatePoint {
  date: string;
  print_id: string;
  usd_per_siu?: string;
  spread_to_index?: string;
  siu_per_usd?: string;
  excluded_reason?: string;
}

function buildRateHistory(allPrints: Print[]): Record<string, RatePoint[]> {
  const history: Record<string, RatePoint[]> = {};
  for (const print of allPrints) {
    for (const row of print.exchange_rate_table) {
      const points = history[row.model_id] ?? [];
      points.push({
        date: print.date,
        print_id: print.print_id,
        usd_per_siu: row.usd_per_siu,
        spread_to_index: row.spread_to_index,
        siu_per_usd: row.siu_per_usd,
        excluded_reason: row.excluded_reason,
      });
      history[row.model_id] = points;
    }
  }
  return history;
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 240;
const PAD_X = 24;
const PAD_TOP = 16;
const PAD_BOTTOM = 32;
/** Cycled by model index — identity, not a value judgment, so dash pattern rather than color
 * keeps the monochrome register the rest of the site uses. */
const LINE_STYLES = [
  "model-line-0",
  "model-line-1",
  "model-line-2",
  "model-line-3",
  "model-line-4",
  "model-line-5",
];

function renderRateChart(rateHistory: Record<string, RatePoint[]>, printCount: number): string {
  if (printCount < 2) return "";

  const modelIds = Object.keys(rateHistory).sort();
  const dates = [
    ...new Set(Object.values(rateHistory).flatMap((points) => points.map((p) => p.date))),
  ].sort();
  const allValues = Object.values(rateHistory)
    .flatMap((points) => points.map((p) => (p.usd_per_siu ? Number(p.usd_per_siu) : null)))
    .filter((v): v is number => v !== null);
  if (allValues.length === 0 || dates.length < 2) return "";

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = max - min || 1;
  const plotWidth = CHART_WIDTH - PAD_X * 2;
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const xForDate = (date: string) => PAD_X + (plotWidth * dates.indexOf(date)) / (dates.length - 1);
  const yForValue = (v: number) => PAD_TOP + plotHeight * (1 - (v - min) / span);

  const lines = modelIds
    .map((modelId, i) => {
      const points = rateHistory[modelId]!.filter((p) => p.usd_per_siu !== undefined).sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      if (points.length === 0) return "";
      const coords = points
        .map((p) => `${xForDate(p.date).toFixed(1)},${yForValue(Number(p.usd_per_siu)).toFixed(1)}`)
        .join(" ");
      return `<polyline points="${coords}" fill="none" class="model-line ${LINE_STYLES[i % LINE_STYLES.length]}"><title>${esc(modelId)}</title></polyline>`;
    })
    .join("\n");

  const legend = modelIds
    .map(
      (modelId, i) =>
        `<span class="legend-marker model-line-legend ${LINE_STYLES[i % LINE_STYLES.length]}"></span> ${esc(modelId)}`,
    )
    .join("  ");

  return `<div class="table-scroll">
    <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="USD per SIU by model, over time" class="series-chart">
      <line x1="${PAD_X}" y1="${CHART_HEIGHT - PAD_BOTTOM}" x2="${CHART_WIDTH - PAD_X}" y2="${CHART_HEIGHT - PAD_BOTTOM}" class="series-axis" />
      ${lines}
    </svg>
  </div>
  <p class="note">${legend}</p>`;
}

function renderRateTable(rateHistory: Record<string, RatePoint[]>): string {
  const modelIds = Object.keys(rateHistory).sort();
  const rows = modelIds.flatMap((modelId) =>
    [...rateHistory[modelId]!]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(
        (p) => `<tr class="${p.excluded_reason ? "excluded" : ""}">
          <td>${esc(modelId)}</td>
          <td>${esc(formatDate(p.date))}</td>
          <td>${p.usd_per_siu ? esc(usd(p.usd_per_siu)) : "—"}</td>
          <td>${p.spread_to_index ? esc(percent(p.spread_to_index)) : "—"}</td>
          <td>${p.siu_per_usd ?? "—"}</td>
          <td class="reason">${p.excluded_reason ? esc(p.excluded_reason) : "—"}</td>
        </tr>`,
      ),
  );

  return `<div class="table-scroll">
    <table>
      <thead>
        <tr><th>Model</th><th>Print</th><th>USD / SIU</th><th>Spread</th><th>SIU per $1</th><th>Excluded</th></tr>
      </thead>
      <tbody>${rows.join("\n")}</tbody>
    </table>
  </div>`;
}

function renderGateTable(gateHistory: Record<string, ModelGatePoint[]>): string {
  const modelIds = Object.keys(gateHistory).sort();
  const rows = modelIds.flatMap((modelId) =>
    (gateHistory[modelId] ?? []).map(
      (g) => `<tr>
        <td>${esc(modelId)}</td>
        <td>${esc(g.print_id)}</td>
        <td>${esc(g.task_class)}</td>
        <td>${g.passed ? "pass" : "fail"}</td>
      </tr>`,
    ),
  );

  if (rows.length === 0) {
    return `<p class="note">No run records yet.</p>`;
  }

  return `<div class="table-scroll">
    <table>
      <thead><tr><th>Model</th><th>Print</th><th>Class</th><th>Result</th></tr></thead>
      <tbody>${rows.join("\n")}</tbody>
    </table>
  </div>`;
}

export function renderModelsPage({ allPrints, gateHistory, basePath }: ModelsPageOptions): string {
  if (allPrints.length === 0) {
    return `<div class="headline">
      <div class="label">Models</div>
      <p class="note">No model has appeared in a print yet.</p>
    </div>`;
  }

  const rateHistory = buildRateHistory(allPrints);
  const chart = renderRateChart(rateHistory, allPrints.length);

  return `<div class="headline">
  <div class="label">Models</div>
  <p class="note">Each tracked model's exchange rate and gate history across every published print.</p>
</div>

<section class="block">
  <h2>Exchange rate over time</h2>
  ${chart || `<p class="note">A chart of USD/SIU over time appears once a second print exists.</p>`}
  ${renderRateTable(rateHistory)}
</section>

<section class="block">
  <h2>Gate pass/fail history</h2>
  ${renderGateTable(gateHistory)}
</section>

<p class="note"><a href="${basePath}prints/index.html">All prints &rarr;</a></p>`;
}
