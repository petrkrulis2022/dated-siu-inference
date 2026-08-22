import type { Print } from "@touchstone/sdk";
import type { ChainInfo, PrintIndexEntry } from "../data.js";
import { esc, formatDate, percent, truncateHex, usd } from "../format.js";
import { buildVerifyInfo } from "../verify.js";

export interface PrintPageOptions {
  print: Print;
  /** Every published print, oldest first — for the change note and the previous-prints list. */
  allPrints: PrintIndexEntry[];
  /** "" at the site root, "../" one level deep. */
  basePath: string;
  /** Base URL for a print's raw run records, e.g. a GitHub tree URL. print_id is appended. */
  runsBaseUrl: string;
  /** TouchstoneAttestation address/publisher/explorer — for the anchor link and verify block. */
  chain: ChainInfo;
}

function findPreviousPrint(
  allPrints: PrintIndexEntry[],
  current: Print,
): PrintIndexEntry | undefined {
  const sorted = [...allPrints].sort((a, b) => a.date.localeCompare(b.date));
  const index = sorted.findIndex((p) => p.print_id === current.print_id);
  return index > 0 ? sorted[index - 1] : undefined;
}

function renderChangeNote(print: Print, previous: PrintIndexEntry | undefined): string {
  if (!previous) {
    return "";
  }
  const prev = Number(previous.dated_siu);
  const curr = Number(print.dated_siu);
  if (prev === 0 || !Number.isFinite(prev) || !Number.isFinite(curr)) {
    return "";
  }
  const deltaRatio = (curr - prev) / prev;
  const arrow = deltaRatio < 0 ? "▼" : deltaRatio > 0 ? "▲" : "—";
  const deltaStr = percent(deltaRatio.toFixed(6), 1);

  // Falling prices are the expected, healthy direction for a compute-cost index over time —
  // stated plainly, not styled as a loss. A rise gets the same plain, factual treatment.
  const commentary =
    deltaRatio < 0
      ? "Cheaper than the previous print. Falling prices are the expected direction for this index over time."
      : deltaRatio > 0
        ? "More expensive than the previous print."
        : "Unchanged from the previous print.";

  return `<div class="change-note">
    <span class="delta">${arrow} ${esc(deltaStr)}</span> since ${esc(formatDate(previous.date))} — ${esc(commentary)}
  </div>`;
}

function renderExchangeRateTable(print: Print): string {
  const rows = [...print.exchange_rate_table]
    .map((row) => {
      if (row.usd_per_siu === undefined) {
        return `<tr class="excluded">
          <td>${esc(row.model_id)}</td>
          <td>—</td>
          <td>—</td>
          <td>—</td>
        </tr>
        <tr class="excluded">
          <td colspan="4" class="reason">${esc(row.excluded_reason ?? "excluded")}</td>
        </tr>`;
      }
      return `<tr>
        <td>${esc(row.model_id)}</td>
        <td>${esc(usd(row.usd_per_siu))}</td>
        <td>${esc(percent(row.spread_to_index as string))}</td>
        <td>${esc(row.siu_per_usd as string)}</td>
      </tr>`;
    })
    .join("\n");

  return `<section class="block">
    <h2>Exchange-rate table</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Model</th><th>USD / SIU</th><th>Spread to index</th><th>SIU per $1</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderFloorSection(print: Print): string {
  if (!print.floor || !print.market_spread) {
    return `<section class="block">
      <h2>Floor &amp; market spread</h2>
      <p class="note">Not yet published — the floor needs a measured hardware-rental rate for the reference configuration, which this print does not yet include.</p>
    </section>`;
  }
  return `<section class="block">
    <h2>Floor &amp; market spread</h2>
    <dl class="kv">
      <dt>Floor</dt><dd>${esc(usd(print.floor.value))}${print.floor.notes ? ` — ${esc(print.floor.notes)}` : ""}</dd>
      <dt>Market spread</dt><dd>${esc(print.market_spread)}×</dd>
    </dl>
  </section>`;
}

function renderSensitivityBlock(print: Print): string {
  const rows = [...print.sensitivity_block]
    .map(
      (row) => `<tr>
        <td>${esc(row.policy_variant)}</td>
        <td>${esc(usd(row.dated_siu))}</td>
        <td>${esc(percent(row.delta, 1))}</td>
        <td>${row.applies_to ? esc([...row.applies_to].join(", ")) : "—"}</td>
      </tr>`,
    )
    .join("\n");

  return `<section class="block">
    <h2>Sensitivity</h2>
    <p class="note">The print recomputed under alternative cache and batch-discount policies, so the effect of those policy choices is stated rather than hidden inside one number.</p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Policy variant</th><th>Dated SIU</th><th>Delta</th><th>Applies to</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function renderMethodologyAndSigning(print: Print, runsUrl: string, chain: ChainInfo): string {
  const methodologyLine = print.methodology_url
    ? `<a href="${esc(print.methodology_url)}">${esc(print.methodology_version)}</a>`
    : esc(print.methodology_version);

  const anchorLine = !print.anchor
    ? "not yet submitted"
    : print.anchor.status === "anchored" && print.anchor.tx_hash
      ? `<a href="${esc(chain.explorerBaseUrl)}/tx/${esc(print.anchor.tx_hash)}" title="${esc(print.anchor.tx_hash)}">${esc(truncateHex(print.anchor.tx_hash))}</a> (${esc(print.anchor.chain)})`
      : `not yet anchored — ${esc(print.anchor.notes ?? print.anchor.status)}`;

  return `<section class="block">
    <h2>Methodology, signature &amp; anchor</h2>
    <dl class="kv">
      <dt>Methodology</dt><dd>${methodologyLine}</dd>
      <dt>Cost of production</dt><dd>${esc(usd(print.cost_of_production_usd))}</dd>
      <dt>Signature</dt><dd title="${esc(print.signature)}">${esc(truncateHex(print.signature))}</dd>
      <dt>Public key</dt><dd title="${esc(print.public_key)}">${esc(truncateHex(print.public_key))}</dd>
      <dt>Anchor tx</dt><dd>${anchorLine}</dd>
      <dt>Raw runs</dt><dd><a href="${esc(runsUrl)}">${esc(runsUrl)}</a></dd>
    </dl>
  </section>`;
}

/**
 * A reader shouldn't have to trust this page's own "verified" claim — the point of anchoring is
 * that anyone can check it independently. bodyHash/recoveredSigner are computed offline at
 * build time (buildVerifyInfo); the three numbered steps let a reader re-derive the same check
 * live against the contract itself, the same thing verify-onchain.ts / the console check.
 */
function renderVerifyBlock(print: Print, chain: ChainInfo): string {
  const info = buildVerifyInfo(print, chain.publisherAddress);
  const contractUrl = `${chain.explorerBaseUrl}/address/${chain.attestationAddress}`;
  const matchLine = info.matchesPublisher
    ? "matches the TouchstoneAttestation publisher below"
    : "does NOT match the TouchstoneAttestation publisher below — treat this print as unverified";

  return `<section class="block">
    <h2>Verify this yourself</h2>
    <p class="note">Don't take this page's word for it — every value below is checkable independently.</p>
    <dl class="kv">
      <dt>Body hash</dt><dd title="${esc(info.bodyHash)}">${esc(truncateHex(info.bodyHash))}</dd>
      <dt>Recovered signer</dt><dd title="${esc(info.recoveredSigner)}">${esc(truncateHex(info.recoveredSigner))} — ${esc(matchLine)}</dd>
      <dt>TouchstoneAttestation</dt><dd><a href="${esc(contractUrl)}" title="${esc(chain.attestationAddress)}">${esc(truncateHex(chain.attestationAddress))}</a> (${esc(print.anchor?.chain ?? "base-sepolia")})</dd>
    </dl>
    <ol class="verify-steps">
      <li>Recompute this print's body hash from the published JSON (JCS-canonicalised, signature fields excluded) and confirm it matches the body hash shown above.</li>
      <li>Open the contract link above on Blockscout, go to "Read Contract", call <code>publisher()</code>, and confirm it matches the recovered signer shown above.</li>
      <li>On the same "Read Contract" tab, call <code>postedAt(bytes32)</code> with the body hash shown above and confirm it returns a non-zero timestamp.</li>
    </ol>
  </section>`;
}

/**
 * Links to every other published print. Named "All prints", not "Previous prints": on an
 * older print's page, a chronologically later print would otherwise be mislabelled as
 * "previous" — this is an archive index, not a strictly-earlier-than-this-page list.
 */
function renderPrintArchive(
  allPrints: PrintIndexEntry[],
  currentPrintId: string,
  basePath: string,
): string {
  const others = [...allPrints]
    .filter((p) => p.print_id !== currentPrintId)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (others.length === 0) {
    return `<section class="block">
      <h2>All prints</h2>
      <p class="note">This is the first published print.</p>
    </section>`;
  }

  const items = others
    .map(
      (p) => `<li>
        <a href="${basePath}prints/${esc(p.date)}.html">${esc(formatDate(p.date))}</a>
        <span class="siu">${esc(usd(p.dated_siu))} · ${esc(p.status)}</span>
      </li>`,
    )
    .join("\n");

  return `<section class="block">
    <h2>All prints</h2>
    <ul class="link-list">${items}</ul>
  </section>`;
}

export function renderPrintPage({
  print,
  allPrints,
  basePath,
  runsBaseUrl,
  chain,
}: PrintPageOptions): string {
  const previous = findPreviousPrint(allPrints, print);
  const runsUrl = `${runsBaseUrl}/${print.print_id}`;

  return `<div class="headline">
  <div class="label">Dated SIU — ${esc(print.version)}</div>
  <div class="figure">${esc(usd(print.dated_siu))}</div>
  <div class="meta">
    <span>${esc(formatDate(print.date))}</span>
    <span class="badge status-${esc(print.status)}">${esc(print.status)}</span>
  </div>
  ${renderChangeNote(print, previous)}
</div>

${renderExchangeRateTable(print)}
${renderFloorSection(print)}
${renderSensitivityBlock(print)}
${renderMethodologyAndSigning(print, runsUrl, chain)}
${renderVerifyBlock(print, chain)}
${renderPrintArchive(allPrints, print.print_id, basePath)}`;
}
