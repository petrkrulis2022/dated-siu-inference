import type { Print } from "@touchstone/sdk";
import type { ChainInfo } from "../data.js";
import { esc, formatDate, truncateHex, usd } from "../format.js";

export interface PrintsListOptions {
  /** Every published print, oldest first. */
  allPrints: Print[];
  /** "../" — this page always lives one level deep, at prints/index.html. */
  basePath: string;
  chain: ChainInfo;
}

function renderStatusCell(print: Print, basePath: string): string {
  if (!print.superseded_by) return esc(print.status);
  return `${esc(print.status)} <a class="badge status-superseded" href="${basePath}prints/${esc(print.superseded_by.print_id)}.html" title="${esc(print.superseded_by.reason)}">superseded</a>`;
}

function renderAnchorCell(print: Print, chain: ChainInfo): string {
  if (!print.anchor) return `<span class="muted">not yet submitted</span>`;
  if (print.anchor.status === "anchored" && print.anchor.tx_hash) {
    return `<a href="${esc(chain.explorerBaseUrl)}/tx/${esc(print.anchor.tx_hash)}" title="${esc(print.anchor.tx_hash)}">${esc(truncateHex(print.anchor.tx_hash))}</a>`;
  }
  return `<span class="muted">${esc(print.anchor.status)}</span>`;
}

export function renderPrintsList({ allPrints, basePath, chain }: PrintsListOptions): string {
  if (allPrints.length === 0) {
    return `<div class="headline">
      <div class="label">Prints</div>
      <p class="note">No print has been published yet.</p>
    </div>`;
  }

  const rows = [...allPrints]
    // Secondary key on print_id: date alone isn't unique (a same-day re-run shares it with the
    // print it supersedes), so relying on date-only comparison leaves same-date entries in
    // whatever order they happened to load in.
    .sort((a, b) => b.date.localeCompare(a.date) || b.print_id.localeCompare(a.print_id))
    .map(
      (p) => `<tr class="${p.superseded_by ? "superseded" : ""}">
        <td><a href="${basePath}prints/${esc(p.print_id)}.html">${esc(formatDate(p.date))}</a></td>
        <td>${renderStatusCell(p, basePath)}</td>
        <td>${esc(usd(p.dated_siu))}</td>
        <td>${esc(p.weights.source)}</td>
        <td>${esc(p.methodology_version)}</td>
        <td>${renderAnchorCell(p, chain)}</td>
        <td title="${esc(p.signature)}">${esc(truncateHex(p.signature))}</td>
      </tr>`,
    )
    .join("\n");

  return `<div class="headline">
  <div class="label">Prints</div>
  <p class="note">Every published Dated SIU print, newest first.</p>
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
