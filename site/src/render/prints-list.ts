import type { Print } from "@touchstone/sdk";
import type { ChainInfo, Incident } from "../data.js";
import { esc, formatDate, truncateHex, usd } from "../format.js";

export interface PrintsListOptions {
  /** Every published print, oldest first. */
  allPrints: Print[];
  /** Days the scheduled run failed to produce a print — see data.ts's loadIncidents. */
  incidents?: Incident[];
  /** "../" — this page always lives one level deep, at prints/index.html. A tier page
   * (/frontier/prints/index.html) lives one level deeper still, so its basePath ("../../")
   * points all the way back to the shared root /prints/ detail-page directory — every link
   * this renderer emits already uses that same basePath for every purpose, so no split like
   * series-page.ts's detailBasePath is needed here. */
  basePath: string;
  chain: ChainInfo;
  /** "Prints", "Frontier SIU prints" or "Commodity SIU prints" — defaults to "Prints" for the
   * blended Dated SIU list. */
  seriesLabel?: string;
}

function renderStatusCell(print: Print, basePath: string): string {
  const badges: string[] = [];
  if (print.prior_attempts && print.prior_attempts.length > 0) {
    const count = print.prior_attempts.length;
    const title = `${count} earlier attempt(s) failed before this print was produced — see the print's own page for the full disclosure.`;
    badges.push(
      `<a class="badge status-late" href="${basePath}prints/${esc(print.print_id)}.html" title="${esc(title)}">late</a>`,
    );
  }
  if (print.superseded_by) {
    badges.push(
      `<a class="badge status-superseded" href="${basePath}prints/${esc(print.superseded_by.print_id)}.html" title="${esc(print.superseded_by.reason)}">superseded</a>`,
    );
  }
  return badges.length === 0 ? esc(print.status) : `${esc(print.status)} ${badges.join(" ")}`;
}

function renderAnchorCell(print: Print, chain: ChainInfo): string {
  if (!print.anchor) return `<span class="muted">not yet submitted</span>`;
  if (print.anchor.status === "anchored" && print.anchor.tx_hash) {
    return `<a href="${esc(chain.explorerBaseUrl)}/tx/${esc(print.anchor.tx_hash)}" title="${esc(print.anchor.tx_hash)}">${esc(truncateHex(print.anchor.tx_hash))}</a>`;
  }
  return `<span class="muted">${esc(print.anchor.status)}</span>`;
}

function renderIncidentRow(incident: Incident): string {
  const breakdown = incident.infra_failures
    ? `<br /><pre class="infra-breakdown">${esc(incident.infra_failures)}</pre>`
    : "";
  const counts =
    incident.qualifying_models != null && incident.registered_models != null
      ? `<br />${incident.qualifying_models} of ${incident.registered_models} registered models qualified` +
        (incident.cost_usd != null ? ` · $${esc(incident.cost_usd)} spent on this attempt` : "")
      : "";
  // A second consecutive failure discloses the day's whole story, not just this attempt —
  // one retry only (docs/methodology.md's retry policy), so at most one prior entry here.
  const retryNote =
    incident.prior_attempts && incident.prior_attempts.length > 0
      ? `<br />An earlier attempt the same day also failed: ${esc(incident.prior_attempts[0]!.reason)}`
      : "";
  return `<tr class="incident">
    <td>${esc(formatDate(incident.date))}</td>
    <td><a class="badge status-failed" href="${esc(incident.run_url)}" title="${esc(incident.reason)}" target="_blank" rel="noopener">no print — run failed</a></td>
    <td colspan="5" class="muted" title="${esc(incident.reason)}">${esc(incident.reason)}${counts}${retryNote}${breakdown}</td>
  </tr>`;
}

export function renderPrintsList({
  allPrints,
  incidents = [],
  basePath,
  chain,
  seriesLabel = "Dated SIU",
}: PrintsListOptions): string {
  if (allPrints.length === 0 && incidents.length === 0) {
    return `<div class="headline">
      <div class="label">${esc(seriesLabel)} Prints</div>
      <p class="note">No print has been published yet.</p>
    </div>`;
  }

  type Row = { date: string; sortKey: string; html: string };
  const printRows: Row[] = allPrints.map((p) => ({
    date: p.date,
    // Secondary key on print_id: date alone isn't unique (a same-day re-run shares it with the
    // print it supersedes), so relying on date-only comparison leaves same-date entries in
    // whatever order they happened to load in.
    sortKey: p.print_id,
    html: `<tr class="${p.superseded_by ? "superseded" : ""}">
        <td><a href="${basePath}prints/${esc(p.print_id)}.html">${esc(formatDate(p.date))}</a></td>
        <td>${renderStatusCell(p, basePath)}</td>
        <td>${esc(usd(p.dated_siu))}</td>
        <td>${esc(p.weights.source)}</td>
        <td>${esc(p.methodology_version)}</td>
        <td>${renderAnchorCell(p, chain)}</td>
        <td title="${esc(p.signature)}">${esc(truncateHex(p.signature))}</td>
      </tr>`,
  }));
  const incidentRows: Row[] = incidents.map((incident) => ({
    date: incident.date,
    sortKey: incident.date,
    html: renderIncidentRow(incident),
  }));

  const rows = [...printRows, ...incidentRows]
    .sort((a, b) => b.date.localeCompare(a.date) || b.sortKey.localeCompare(a.sortKey))
    .map((r) => r.html)
    .join("\n");

  return `<div class="headline">
  <div class="label">${esc(seriesLabel)} Prints</div>
  <p class="note">Every published ${esc(seriesLabel)} print, newest first${incidents.length > 0 ? " — including days a scheduled run failed and no print was produced" : ""}.</p>
</div>

<section class="block">
  <div class="table-scroll">
    <table>
      <thead>
        <tr>
          <th>Date</th><th>Status</th><th>Dated SIU</th><th>Weights</th>
          <th>Methodology</th><th>Anchor</th><th>Signature</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}
