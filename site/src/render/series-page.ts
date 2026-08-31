import type { Incident, PrintIndexEntry } from "../data.js";
import { esc, formatDate, usd } from "../format.js";

export interface SeriesPageOptions {
  /** Every published print, oldest first. */
  allPrints: PrintIndexEntry[];
  /** Days the scheduled run failed to produce a print — see data.ts's loadIncidents. */
  incidents?: Incident[];
  /** "" at the site root. */
  basePath: string;
  /** Distance-to-root for links into the shared /prints/<id>.html detail-page directory —
   * distinct from basePath because a tier page (e.g. /frontier/index.html) lives at a
   * different nesting depth than the "All prints" list it links to (its own /frontier/prints/
   * directory) versus a print's own detail page (always the single shared /prints/ directory
   * at the site root, since print_id is already globally unique across every series). Defaults
   * to basePath, which is correct whenever both happen to coincide — the blended Dated SIU
   * page today, where there's only one "prints/" directory in the first place. */
  detailBasePath?: string;
  /** "Dated SIU", "Frontier SIU" or "Commodity SIU" — which series this page is presenting.
   * Defaults to "Dated SIU" for the blended headline series. */
  seriesLabel?: string;
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const PAD_X = 24;
const PAD_TOP = 16;
const PAD_BOTTOM = 32;

/**
 * A single inline <svg>, computed at build time — the site has no client JS (layout.test.ts
 * enforces this), so there is no chart library involved. Provisional vs. final is carried by
 * marker fill (hollow vs. solid), not color — "no red-for-down, no gradients, monochrome" is
 * the site's existing design register (styles.css's own header comment).
 */
function renderMultiPointChart(prints: PrintIndexEntry[]): string {
  const values = prints.map((p) => Number(p.dated_siu));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // flat series: keep the line centered rather than dividing by 0.
  const plotWidth = CHART_WIDTH - PAD_X * 2;
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  const points = prints.map((p, i) => {
    const x = prints.length === 1 ? PAD_X : PAD_X + (plotWidth * i) / (prints.length - 1);
    const t = (Number(p.dated_siu) - min) / span;
    const y = PAD_TOP + plotHeight * (1 - t);
    return { ...p, x, y };
  });

  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Superseded is rendered as a distinct marker style, layered over the status-based one — the
  // chart shows every print that was ever published, including a same-day redo's predecessor.
  // Dropping it here would make the chart disagree with the Prints list, which does show it.
  const markers = points
    .map((p) => {
      const markerClass = p.superseded_by
        ? "series-point-superseded"
        : `series-point-${esc(p.status)}`;
      const title = p.superseded_by
        ? `${esc(formatDate(p.date))} — ${esc(usd(p.dated_siu))} (superseded by ${esc(p.superseded_by.print_id)}: ${esc(p.superseded_by.reason)})`
        : `${esc(formatDate(p.date))} — ${esc(usd(p.dated_siu))} (${esc(p.status)})`;
      const supersededAnnotation = p.superseded_by
        ? `<text x="${p.x.toFixed(1)}" y="${(p.y + 16).toFixed(1)}" text-anchor="middle" class="series-annotation">superseded</text>`
        : "";
      // A registry change is exactly the kind of thing that can make the line jump between two
      // points for a reason that has nothing to do with the market — the annotation sits right
      // on the point where it happened, not only in a note below the chart a reader might miss.
      const constituentAnnotation =
        p.constituent_changes && p.constituent_changes.length > 0
          ? `<text x="${p.x.toFixed(1)}" y="${(p.y + (p.superseded_by ? 30 : 16)).toFixed(1)}" text-anchor="middle" class="series-annotation">registry changed</text>`
          : "";
      return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" class="series-point ${markerClass}"><title>${title}</title></circle>${supersededAnnotation}${constituentAnnotation}`;
    })
    .join("\n");

  const firstLabel = `<text x="${PAD_X}" y="${CHART_HEIGHT - 8}" class="series-axis-label">${esc(formatDate(points[0]!.date))}</text>`;
  const lastLabel = `<text x="${CHART_WIDTH - PAD_X}" y="${CHART_HEIGHT - 8}" class="series-axis-label" text-anchor="end">${esc(formatDate(points[points.length - 1]!.date))}</text>`;

  return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="Dated SIU over time" class="series-chart">
    <line x1="${PAD_X}" y1="${CHART_HEIGHT - PAD_BOTTOM}" x2="${CHART_WIDTH - PAD_X}" y2="${CHART_HEIGHT - PAD_BOTTOM}" class="series-axis" />
    <polyline points="${line}" class="series-line" fill="none" />
    ${markers}
    ${firstLabel}
    ${lastLabel}
  </svg>`;
}

/** With one print there is no trend to draw — a single point plus a caption, not a faked line. */
function renderSinglePointChart(print: PrintIndexEntry): string {
  const x = CHART_WIDTH / 2;
  const y = CHART_HEIGHT / 2 - 10;
  return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="Dated SIU — first print" class="series-chart">
    <line x1="${PAD_X}" y1="${CHART_HEIGHT - PAD_BOTTOM}" x2="${CHART_WIDTH - PAD_X}" y2="${CHART_HEIGHT - PAD_BOTTOM}" class="series-axis" />
    <circle cx="${x}" cy="${y}" r="5" class="series-point series-point-${esc(print.status)}"><title>${esc(formatDate(print.date))} — ${esc(usd(print.dated_siu))} (${esc(print.status)})</title></circle>
    <text x="${x}" y="${y - 14}" class="series-axis-label" text-anchor="middle">${esc(formatDate(print.date))}</text>
  </svg>`;
}

/**
 * Missed days aren't points on the value chart — there is no dated_siu to plot for a run that
 * never produced a print. Listed instead, each linking straight to the failed run so "what
 * happened" is one click away, not buried in a separate incidents page — dropping this list
 * would make the chart look like a clean, unbroken series when it wasn't.
 */
function renderIncidentsNote(incidents: Incident[]): string {
  if (incidents.length === 0) return "";
  const items = incidents
    .map(
      (incident) =>
        `<li><a href="${esc(incident.run_url)}" target="_blank" rel="noopener">${esc(formatDate(incident.date))} — no print published, run failed &rarr;</a></li>`,
    )
    .join("\n");
  return `<div class="note incidents">
    <p>Days a scheduled run failed to produce a print:</p>
    <ul>${items}</ul>
  </div>`;
}

/**
 * A reader looking at the chart's own shape needs to see WHY the level jumped, right next to
 * where the jump is visible — not only on the individual print's own page (print-page.ts's
 * renderConstituentChangesNotice). Registry inclusion policy requires the announcement; this is
 * where a reader of the series (not a single print) actually encounters it.
 */
function renderConstituentChangeNotes(
  allPrints: PrintIndexEntry[],
  detailBasePath: string,
): string {
  const withChanges = allPrints.filter(
    (p) => p.constituent_changes && p.constituent_changes.length > 0,
  );
  if (withChanges.length === 0) return "";
  const items = withChanges
    .map((p) => {
      const admitted = p.constituent_changes!.filter((c) => c.change === "admitted");
      const removed = p.constituent_changes!.filter((c) => c.change === "removed");
      const parts: string[] = [];
      if (admitted.length > 0)
        parts.push(`admitted ${admitted.map((c) => esc(c.model_id)).join(", ")}`);
      if (removed.length > 0)
        parts.push(`removed ${removed.map((c) => esc(c.model_id)).join(", ")}`);
      return `<li><a href="${detailBasePath}prints/${esc(p.print_id)}.html">${esc(formatDate(p.date))}</a> — ${parts.join("; ")}</li>`;
    })
    .join("\n");
  return `<div class="note incidents">
    <p>Registry changes reflected in this series:</p>
    <ul>${items}</ul>
  </div>`;
}

export function renderSeriesPage({
  allPrints,
  incidents = [],
  basePath,
  detailBasePath = basePath,
  seriesLabel = "Dated SIU",
}: SeriesPageOptions): string {
  if (allPrints.length === 0) {
    return `<div class="headline">
      <div class="label">${esc(seriesLabel)}</div>
      <p class="note">No print has been published yet.</p>
    </div>`;
  }

  // "Latest" means the current print of record, not merely the last-loaded entry: a superseded
  // print can share the newest date with the print that replaced it, so it must be explicitly
  // excluded here rather than relied on to sort last by accident.
  const standing = allPrints.filter((p) => !p.superseded_by);
  const latest = (standing.length > 0 ? standing : allPrints).at(-1)!;
  const chart =
    allPrints.length === 1 ? renderSinglePointChart(latest) : renderMultiPointChart(allPrints);
  const seriesNote =
    allPrints.length === 1
      ? "The series begins here. Prints publish daily."
      : "A falling line is normal and expected: one SIU always buys the same work, so a falling line means inference got cheaper, not that the measurement is drifting.";

  return `<div class="headline">
  <div class="label">${esc(seriesLabel)} — ${esc(latest.print_id)}</div>
  <div class="figure">${esc(usd(latest.dated_siu))}</div>
  <div class="meta">
    <span>${esc(formatDate(latest.date))}</span>
    <span class="badge status-${esc(latest.status)}">${esc(latest.status)}</span>
  </div>
</div>

<section class="block">
  <h2>${esc(seriesLabel)} over time</h2>
  <div class="table-scroll">${chart}</div>
  <p class="note">${esc(seriesNote)}</p>
  <p class="note">
    <span class="legend-marker series-point series-point-final"></span> final
    <span class="legend-marker series-point series-point-provisional"></span> provisional
    <span class="legend-marker series-point series-point-superseded"></span> superseded
  </p>
  ${renderIncidentsNote(incidents)}
  ${renderConstituentChangeNotes(allPrints, detailBasePath)}
  <p class="note"><a href="${basePath}prints/index.html">All prints &rarr;</a></p>
</section>`;
}
