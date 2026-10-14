import type { Print } from "@touchstone/sdk";
import { computeDatedSiu, D, resolveWeights, type DecimalValue } from "@touchstone/print";
import type { ChainInfo, PrintIndexEntry } from "../data.js";
import { esc, formatDate, percent, truncateHex, usd } from "../format.js";
import { buildVerifyInfo } from "../verify.js";
import { EXCLUDED_FIELDS, RAW_PRINT_URL, VERIFY_JSON_URL, VERIFY_SCRIPT_URL, chainName, chainSlug } from "../verify-recipe.js";

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
  /**
   * Every chain prints are, or are about to be, anchored on, in the order the sections follow (Base Sepolia, then Arc Testnet). Defaults to `[chain]`, so a
   * caller that knows of one chain renders exactly what it always did.
   */
  chains?: ChainInfo[];
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

/** An anchor as the page reads it: the first chain's own, or an entry of `anchor.additional_anchors`. */
interface AnchorView {
  chain: string;
  status: string;
  tx_hash?: string;
  posted_at?: string;
  notes?: string;
}

/**
 * The anchor this print carries on `chain`. The first chain's is the print's own `anchor`, whatever label an old print gave it. Any other chain's is its entry in
 * `anchor.additional_anchors`, found by the chain's name; a print published before anchoring on that chain began has none.
 */
function anchorOn(print: Print, chains: ChainInfo[], chain: ChainInfo): AnchorView | undefined {
  if (chain === chains[0]) return print.anchor;
  const slug = chainSlug(chain);
  return print.anchor?.additional_anchors?.find((a) => a.chain === slug);
}

/** The anchor transaction as a row value: a link to the chain's explorer, or an honest statement of why there is none. */
function anchorLine(print: Print, anchor: AnchorView | undefined, chain: ChainInfo, chains: ChainInfo[], full = false): string {
  const name = esc(chainName(chain));
  if (!anchor) {
    if (chain === chains[0]) return "not yet submitted";
    if (chain.anchoringStartedOn !== undefined && print.date < chain.anchoringStartedOn) {
      return `not anchored: anchoring on ${name} began with the print dated ${esc(chain.anchoringStartedOn)}`;
    }
    return chain.anchoringLive === false
      ? `not anchored: no print has been anchored on ${name} yet`
      : `not anchored on ${name}`;
  }
  if (anchor.status === "anchored" && anchor.tx_hash) {
    return `<a href="${esc(chain.explorerBaseUrl)}/tx/${esc(anchor.tx_hash)}" title="${esc(anchor.tx_hash)}">${esc(full ? anchor.tx_hash : truncateHex(anchor.tx_hash))}</a> (${esc(anchor.chain)})`;
  }
  if (anchor.status === "already-anchored") {
    return `anchored${anchor.posted_at ? ` ${esc(anchor.posted_at)}` : ""}; the transaction was sent by an earlier run and is not recorded here`;
  }
  if (chain !== chains[0]) {
    return `not anchored on ${name}: ${esc(anchor.status)}${anchor.notes ? ` — ${esc(anchor.notes)}` : ""}. The print was published anyway; this chain is best-effort`;
  }
  return `not yet anchored — ${esc(anchor.notes ?? anchor.status)}`;
}

function renderMethodologyAndSigning(print: Print, runsUrl: string, chains: ChainInfo[]): string {
  // The rule set this print was computed under, as distinct from `methodology_version` (which has
  // read "v0-draft" on every print ever published and so distinguishes nothing). A replicator
  // recomputing an old print needs to know which revision's rules applied on the day — it is what
  // cli/verify-support.ts itself keys historical reconstruction off. Omitted rather than shown
  // blank on prints published before the field existed.
  const revisionRow = print.methodology_revision
    ? `<dt>Methodology revision</dt><dd>${esc(print.methodology_revision)}</dd>`
    : "";
  const methodologyLine = print.methodology_url
    ? `<a href="${esc(print.methodology_url)}">${esc(print.methodology_version)}</a>`
    : esc(print.methodology_version);

  const anchorRows = chains
    .map(
      (chain) =>
        `<dt>Anchor tx${chains.length > 1 ? ` — ${esc(chainName(chain))}` : ""}</dt><dd>${anchorLine(print, anchorOn(print, chains, chain), chain, chains)}</dd>`,
    )
    .join("\n      ");

  return `<section class="block">
    <h2>Methodology, signature &amp; anchor</h2>
    <dl class="kv">
      <dt>Methodology</dt><dd>${methodologyLine}</dd>
      ${revisionRow}
      <dt>Cost of production</dt><dd>${esc(usd(print.cost_of_production_usd))}</dd>
      <dt>Signature</dt><dd title="${esc(print.signature)}">${esc(truncateHex(print.signature))}</dd>
      <dt>Public key</dt><dd title="${esc(print.public_key)}">${esc(truncateHex(print.public_key))}</dd>
      ${anchorRows}
      <dt>Raw runs</dt><dd><a href="${esc(runsUrl)}">${esc(runsUrl)}</a></dd>
    </dl>
    <p class="note">Dated SIU is an assessment of qualifying inference work under this basket version, model/provider configuration and quality gate — not a prediction of production agent costs, which vary with workflow design, tool reliability, retry policy and context handling.</p>
  </section>`;
}

/** A full value in a monospace cell that wraps, with a copy button the page script reveals: a reader pastes these into an explorer, so none is shortened. */
function copyable(value: string): string {
  return `<code class="hash">${esc(value)}</code> <button type="button" class="copy" data-copy="${esc(value)}" hidden>Copy</button>`;
}

function renderChainAnchor(print: Print, chains: ChainInfo[], chain: ChainInfo, info: ReturnType<typeof buildVerifyInfo>): string {
  const name = chainName(chain);
  const contractUrl = `${chain.explorerBaseUrl}/address/${chain.attestationAddress}`;
  const anchor = anchorOn(print, chains, chain);
  const matchLine = info.matchesPublisher
    ? "the recovered signer above is this publisher"
    : "does NOT match the recovered signer above — treat this print as unverified";
  const chainIdLine = chain.chainId === undefined ? "" : ` · chain id ${chain.chainId}`;
  const anchored = (anchor?.status === "anchored" && anchor.tx_hash) || anchor?.status === "already-anchored";
  const notLiveNote =
    !anchored && chain !== chains[0] && chain.anchoringLive === false
      ? `<p class="note">Anchoring on ${esc(name)} has not started: the contract is deployed (above) and no print has been anchored on it yet. Anchors will appear here from the first print anchored on it.</p>`
      : !anchored && chain !== chains[0] && chain.anchoringStartedOn !== undefined && print.date >= chain.anchoringStartedOn
        ? `<p class="note">Anchoring on ${esc(name)} is best-effort: this print is anchored on ${esc(chainName(chains[0]))}, and ${anchor ? "the reason it is not anchored here is above" : "it carries no record of an attempt on this chain"}.</p>`
        : "";
  // The contract-check steps show for a chain that has an anchor, and always for the first chain, as before; a later chain with nothing anchored on it has nothing to check.
  const steps = anchored || chain === chains[0]
    ? `<ol class="verify-steps">
      <li>Open the contract link above on its explorer, go to "Read Contract", call <code>publisher()</code>, and confirm it equals the recovered signer shown above.</li>
      <li>On the same "Read Contract" tab, call <code>postedAt(bytes32)</code> with the body hash above and confirm it returns a non-zero timestamp: the Unix time, in seconds, at which this hash was first recorded.</li>
      ${anchor?.tx_hash ? '<li>Open the anchor transaction, go to its Logs tab, and confirm a <code>PrintPosted</code> event whose <code>bodyHash</code> equals the body hash above.</li>' : ""}
    </ol>`
    : "";
  return `<h3>Anchored on ${esc(name)}</h3>
    <dl class="kv">
      <dt>TouchstoneAttestation</dt><dd><a href="${esc(contractUrl)}">${esc(chain.attestationAddress)}</a> (${esc(chainSlug(chain))}${esc(chainIdLine)})</dd>
      <dt>Publisher (fixed in the contract)</dt><dd>${esc(info.publisherAddress)} — ${esc(matchLine)}</dd>
      <dt>Anchor tx</dt><dd>${anchorLine(print, anchor, chain, chains, true)}</dd>
    </dl>
    ${notLiveNote}
    ${steps}`;
}

/**
 * A reader shouldn't have to trust this page's own "verified" claim — the point of anchoring is that anyone can check it independently. bodyHash/recoveredSigner
 * are computed offline at build time (buildVerifyInfo). The page gives the exact recipe (which fields come out, how it is canonicalised and hashed), a one-command
 * script that does it with plain Node, and, for each chain, the steps to check the contract itself. Nothing here is shortened: a value is meant to be pasted.
 */
function renderVerifyBlock(print: Print, chains: ChainInfo[]): string {
  const primary = chains[0];
  const info = buildVerifyInfo(print, primary.publisherAddress);
  const rawUrl = `${RAW_PRINT_URL}${print.print_id}.json`;
  const fields = EXCLUDED_FIELDS.map((f) => `<code>${esc(f)}</code>`).join(", ");
  return `<section class="block" id="verify">
    <h2>Verify this yourself</h2>
    <p class="note">Don't take this page's word for it — every value below is checkable independently. Read the steps, run one command, or have an agent read <a href="${esc(VERIFY_JSON_URL)}">verify.json</a>.</p>
    <h3>The body hash</h3>
    <dl class="kv">
      <dt>Body hash</dt><dd>${copyable(info.bodyHash)}</dd>
      <dt>Recovered signer</dt><dd>${esc(info.recoveredSigner)}</dd>
    </dl>
    <p class="note">The body hash is made like this:</p>
    <ol class="verify-steps">
      <li>Download this print's JSON: <a href="${esc(rawUrl)}">${esc(rawUrl)}</a>.</li>
      <li>Remove exactly these five fields and keep everything else as published: ${fields}. The last three are added after signing, which is why they cannot be part of the hash.</li>
      <li>Canonicalise what is left with RFC 8785 (JCS): keys sorted, no whitespace, numbers and strings as JSON writes them.</li>
      <li>Take the keccak256 hash of the UTF-8 bytes of that text (the original Keccak padding Ethereum uses, not NIST SHA3-256). Written as 0x and 64 hex digits, it equals the body hash above.</li>
    </ol>
    <details class="run-it">
      <summary>Or run one command</summary>
      <pre>curl -O ${esc(VERIFY_SCRIPT_URL)}
node verify-print.mjs ${esc(print.print_id)}</pre>
      <p class="note">Plain Node 18 or later, nothing to install, no keys. It does the four steps above, then looks the anchor transaction up on the chain's explorer and looks for a <code>PrintPosted</code> event carrying your hash. Exit code 0 means it matched. It does not check the signature: see the recovered signer above and the publisher below.</p>
    </details>
    ${chains.map((chain) => renderChainAnchor(print, chains, chain, buildVerifyInfo(print, chain.publisherAddress))).join("\n    ")}
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
    // Secondary key on print_id: date alone isn't unique (a same-day re-run shares it with the
    // print it supersedes).
    .sort((a, b) => b.date.localeCompare(a.date) || b.print_id.localeCompare(a.print_id));

  if (others.length === 0) {
    return `<section class="block">
      <h2>All prints</h2>
      <p class="note">This is the first published print.</p>
    </section>`;
  }

  const items = others
    .map(
      (p) => `<li>
        <a href="${basePath}prints/${esc(p.print_id)}.html">${esc(formatDate(p.date))}</a>
        <span class="siu">${esc(usd(p.dated_siu))} · ${p.final ? "final" : "provisional"}${p.superseded_by ? " · superseded" : ""}</span>
      </li>`,
    )
    .join("\n");

  return `<section class="block">
    <h2>All prints</h2>
    <ul class="link-list">${items}</ul>
  </section>`;
}

/**
 * A reader who lands directly on a superseded print's own page (a bookmark, a shared link, a
 * search result) must see this before anything else — cross-references from the Prints list or
 * Series chart aren't enough on their own. The original is never edited or deleted; this is
 * disclosure on the print's own face, per the revision policy.
 */
function renderSupersessionNotice(print: Print, basePath: string): string {
  if (!print.superseded_by) return "";
  return `<div class="change-note">
    <strong>Superseded</strong> by <a href="${basePath}prints/${esc(print.superseded_by.print_id)}.html">${esc(print.superseded_by.print_id)}</a> — ${esc(print.superseded_by.reason)}
  </div>`;
}

type CorrectionNoteType = "precision" | "pricing" | "attribution" | "other";

/**
 * A lightweight, keyword-based read of what a correction note is about — not a schema field.
 * correction_notes has no `type` today, and retrofitting one onto the ~100+ historical notes
 * already published (the Gemini cost-gap saga, every prior correction) would be a much bigger,
 * riskier rewrite than a grouped summary needs. This infers from the note's own prose instead,
 * used only to group notes under the short summary line below when there are several — the full,
 * unclassified prose is still rendered beneath, unchanged, for every note regardless of how it
 * was classified.
 */
export function classifyCorrectionNote(note: string): CorrectionNoteType {
  const lower = note.toLowerCase();
  if (
    lower.includes("dated_siu previously rounded") ||
    lower.includes("restores rounding precision")
  ) {
    return "precision";
  }
  if (lower.includes("reasoning") || lower.includes("cached_input") || lower.includes("cache")) {
    return "pricing";
  }
  // "billing" alone is too broad — a provider-outage note ("a provider-side billing failure")
  // is not the same kind of thing as the Gemini cost-gap attribution saga; found live writing
  // this classifier's own test. "gemini cloud billing"/"shared project"/"isolat" are specific
  // enough to that saga not to also match an unrelated outage disclosure.
  if (
    lower.includes("gemini") &&
    (lower.includes("cloud billing") ||
      lower.includes("shared project") ||
      lower.includes("isolat"))
  ) {
    return "attribution";
  }
  return "other";
}

const CORRECTION_TYPE_ORDER: CorrectionNoteType[] = [
  "precision",
  "pricing",
  "attribution",
  "other",
];

/** "4 corrections: 2 pricing, 1 precision, 1 attribution" — only categories actually present are
 * listed, in a fixed order so the same category always reads in the same place across prints. */
function summarizeCorrectionNotes(notes: readonly { note: string }[]): string {
  const counts = new Map<CorrectionNoteType, number>();
  for (const { note } of notes) {
    const type = classifyCorrectionNote(note);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const parts = CORRECTION_TYPE_ORDER.filter((type) => counts.has(type)).map(
    (type) => `${counts.get(type)} ${type}`,
  );
  const plural = notes.length === 1 ? "correction" : "corrections";
  return `${notes.length} ${plural}: ${parts.join(", ")}`;
}

/**
 * The revision policy's error procedure (methodology.md's Index governance): a fact discovered
 * after publication that doesn't change dated_siu — unlike renderSupersessionNotice, there's no
 * redo to link to, so this renders in place, at the top, before anything else on the page. Most
 * prominent of the disclosure notices deliberately: it exists specifically for the failure mode
 * where a reader would otherwise mistake a computed-correctly-from-incomplete-data number for a
 * real market move.
 *
 * With several notes, a short summary line (grouped by classifyCorrectionNote) sits above the
 * full list — found live, 2026-09-25: some prints had accumulated 4-7 notes, becoming a wall a
 * reader would reasonably skim past, defeating the point of disclosing at all.
 */
function renderCorrectionNotesNotice(print: Print): string {
  if (!print.correction_notes || print.correction_notes.length === 0) return "";
  const summary =
    print.correction_notes.length >= 2
      ? `<p class="note">${esc(summarizeCorrectionNotes(print.correction_notes))}</p>`
      : "";
  const items = print.correction_notes
    .map((n) => `<li>${esc(formatDate(n.published_at.slice(0, 10)))} — ${esc(n.note)}</li>`)
    .join("\n");
  return `<div class="change-note">
    <strong>Correction notice</strong> — published after this print, disclosing a fact that does not change dated_siu:
    ${summary}
    <ul class="link-list">${items}</ul>
  </div>`;
}

/**
 * "A late print tells the truth about when it was actually computed" — docs/methodology.md's
 * retry policy. Same visibility principle as renderSupersessionNotice: on the print's own page,
 * before anything else, not buried in a separate log a reader has to already know to look for.
 */
function renderPriorAttemptsNotice(print: Print): string {
  if (!print.prior_attempts || print.prior_attempts.length === 0) return "";
  const items = print.prior_attempts
    .map((a) => {
      const time = a.attempted_at.length >= 16 ? a.attempted_at.slice(11, 16) : "";
      return `<li>${esc(formatDate(a.attempted_at.slice(0, 10)))}${time ? ` at ${esc(time)} UTC` : ""} — ${esc(a.reason)} (${a.qualifying_models} of ${a.registered_models} qualified, ${esc(usd(a.cost_usd))} spent)</li>`;
    })
    .join("\n");
  const plural = print.prior_attempts.length === 1 ? "attempt" : "attempts";
  return `<div class="change-note">
    <strong>Published late</strong> — ${print.prior_attempts.length} earlier ${plural} failed before this print was produced:
    <ul class="link-list">${items}</ul>
  </div>`;
}

/** "+$0.0009" / "-$0.0002" — percent()'s sign convention (leading sign outside the currency
 * symbol), applied to a DecimalValue instead of a ratio string. */
function signedUsd(delta: DecimalValue): string {
  const s = delta.toFixed(4);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `+$${s}`;
}

/**
 * Splits a composition-changing print's move against the previous one into a compositional
 * component (attributable to the admitted/removed constituents themselves) and a continuous
 * component (movement among constituents present in both prints), computed live from both
 * prints' own basket_costs via @touchstone/print's own aggregation (the same equal-weighting
 * formula the print itself uses, restricted to the qualifying set both prints share) — never
 * hand-written per print, so it can't go stale the way a prose figure would.
 *
 * totalDelta = driftDelta + compositionalDelta always holds by construction (a telescoping
 * identity: compositionalDelta is defined as whatever's left after subtracting driftDelta from
 * the real observed move), so this generalises correctly to any mix of admissions and removals.
 * Deliberately does NOT attribute the move to any one admitted/removed model individually — with
 * more than one change in the same print that split is order-dependent (there's no canonical
 * order to attribute a nonlinear mean across), so this states only the two-way split.
 *
 * Deliberately neutral wording, and deliberately not "market signal": a compositional split
 * can't distinguish an actual market move from, say, a pricing-formula fix landing — see
 * docs/methodology.md's Index governance and, for a concrete instance, 2026-09-08's
 * correction_notes, which is where that distinction, when it applies, is actually made in prose.
 */
function computeCompositionalSplit(print: Print, previous?: PrintIndexEntry): string {
  if (!previous?.basket_costs) return "";
  const withCost = (bc: Print["basket_costs"][number]): bc is typeof bc & { cost_usd: string } =>
    bc.cost_usd !== undefined;
  const prevMap = new Map(
    previous.basket_costs.filter(withCost).map((b) => [b.model_id, new D(b.cost_usd)]),
  );
  const currMap = new Map(
    print.basket_costs.filter(withCost).map((b) => [b.model_id, new D(b.cost_usd)]),
  );
  const continuousIds = [...prevMap.keys()].filter((id) => currMap.has(id));
  if (continuousIds.length === 0) return "";

  const { weights: contWeights } = resolveWeights(continuousIds);
  const prevContinuous = computeDatedSiu(prevMap, contWeights);
  const currContinuous = computeDatedSiu(currMap, contWeights);
  const totalDelta = new D(print.dated_siu).minus(new D(previous.dated_siu));
  const driftDelta = currContinuous.minus(prevContinuous);
  const compositionalDelta = totalDelta.minus(driftDelta);
  const plural = continuousIds.length === 1 ? "" : "s";

  return ` Of the ${esc(usd(totalDelta.abs().toFixed(4)))} move since the previous print,
    ${esc(signedUsd(compositionalDelta))} is attributable to this composition change and
    ${esc(signedUsd(driftDelta))} to movement among the ${continuousIds.length}
    constituent${plural} present in both prints — a mechanical split, not a judgement of cause.`;
}

/**
 * The registry inclusion policy requires a constituent change to be announced ahead of the
 * print it takes effect in — this is where a reader actually encounters that announcement,
 * not just in docs/methodology.md's prose. Without this, a reader six months from now sees the
 * headline figure jump between two consecutive prints with no explanation on the record itself.
 */
function renderConstituentChangesNotice(print: Print, previous?: PrintIndexEntry): string {
  if (!print.constituent_changes || print.constituent_changes.length === 0) return "";
  const admitted = print.constituent_changes.filter((c) => c.change === "admitted");
  const removed = print.constituent_changes.filter((c) => c.change === "removed");
  const parts: string[] = [];
  if (admitted.length > 0) {
    parts.push(`admitted: ${admitted.map((c) => esc(c.model_id)).join(", ")}`);
  }
  if (removed.length > 0) {
    parts.push(`removed: ${removed.map((c) => esc(c.model_id)).join(", ")}`);
  }
  return `<div class="change-note">
    <strong>Registry changed</strong> since the previous print — ${parts.join("; ")}. See the
    registry inclusion policy in the methodology for why.${computeCompositionalSplit(print, previous)}
  </div>`;
}

/**
 * docs/methodology.md's Weighting section discloses the limitation in prose; this is where a
 * reader of a single print actually encounters it, computed live from that print's own
 * basket_costs rather than hand-written per print (a hand-written figure would go stale the
 * next time the qualifying set or its prices changed). Equal weighting gives every qualifying
 * constituent the same 1÷n nominal share — this states, plainly, how unevenly that translates
 * into the summed basket cost dated_siu is actually computed from, splitting on the mean cost
 * (a natural, non-cherry-picked line, not a threshold chosen to hit a particular number).
 */
function renderWeightingNotice(print: Print): string {
  if (print.weights.source !== "equal") return "";
  const costs = print.basket_costs
    .filter((b): b is typeof b & { cost_usd: string } => b.cost_usd !== undefined)
    .map((b) => Number(b.cost_usd));
  const n = costs.length;
  if (n < 2) return "";

  const total = costs.reduce((sum, c) => sum + c, 0);
  const mean = total / n;
  const aboveMean = costs.filter((c) => c >= mean);
  const spread = Math.max(...costs) / Math.min(...costs);
  if (!Number.isFinite(spread) || spread <= 1) return "";

  const aboveShare = aboveMean.reduce((sum, c) => sum + c, 0) / total;
  const constituentSharePct = ((aboveMean.length / n) * 100).toFixed(0);
  const costSharePct = (aboveShare * 100).toFixed(0);
  return `<div class="change-note">
    <strong>Equal weighting, disclosed:</strong> basket costs span ${spread.toFixed(1)}× across
    the ${n} qualifying constituents. ${aboveMean.length} of ${n} constituents
    (${constituentSharePct}%) sit at or above the mean basket cost and together account for
    ${costSharePct}% of the summed basket cost Dated SIU is computed from — equal weighting still
    gives each of them the same 1÷${n} nominal share. Dated SIU therefore tracks the more
    expensive end of the basket more closely than a demand-weighted index would. See the
    methodology's Weighting section, and Frontier SIU / Commodity SIU, the tier prints published
    alongside this one for exactly this reason.
  </div>`;
}

export function renderPrintPage({
  print,
  allPrints,
  basePath,
  runsBaseUrl,
  chain,
  chains: chainList,
}: PrintPageOptions): string {
  const chains = chainList ?? [chain];
  const previous = findPreviousPrint(allPrints, print);
  const runsUrl = `${runsBaseUrl}/${print.print_id}`;
  // docs/methodology.md §7: print.status stays "provisional" on every print's own signed body
  // forever — a print is "final" exactly when a signed reconciliation record exists for it,
  // carried on its own allPrints entry as `.final` (build.ts), never read from `.status` here.
  const isFinal = allPrints.find((p) => p.print_id === print.print_id)?.final ?? false;
  const status = isFinal ? "final" : "provisional";

  return `<div class="headline">
  <div class="label">Dated SIU — ${esc(print.version)}</div>
  <div class="figure">${esc(usd(print.dated_siu))}</div>
  <div class="meta">
    <span>${esc(formatDate(print.date))}</span>
    <span class="badge status-${status}">${status}</span>
  </div>
  ${renderCorrectionNotesNotice(print)}
  ${renderSupersessionNotice(print, basePath)}
  ${renderPriorAttemptsNotice(print)}
  ${renderConstituentChangesNotice(print, previous)}
  ${renderChangeNote(print, previous)}
  ${renderWeightingNotice(print)}
</div>

${renderExchangeRateTable(print)}
${renderFloorSection(print)}
${renderSensitivityBlock(print)}
${renderMethodologyAndSigning(print, runsUrl, chains)}
${renderVerifyBlock(print, chains)}
${renderPrintArchive(allPrints, print.print_id, basePath)}
<script type="module" src="${basePath}client/copy-hash.js"></script>`;
}
