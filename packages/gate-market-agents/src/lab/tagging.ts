/**
 * The blind tagging page (docs/marketplace_plan.md §14.6): a person tags a random 40 of the stated reasons with the nine categories, seeing only the
 * reason, never the cell, arm, model or what the keyword rules made of it, so the rules' agreement with a reader can be measured.
 *
 * `drawTagSample` draws the reasons and returns two things that never meet: the items, which carry an opaque id and the text and nothing else, and a key
 * from each id back to its call, which stays on disk and is not read until the tags are in. `renderTaggingPage` writes one self-contained page from the
 * items. The page saves each answer to the artifact's database (so no file needs handing back) and offers a download as a backup.
 */
import { deriveSeed, mulberry32 } from "@touchstone/basket";
import { CATEGORY_LABELS, REASON_CATEGORIES } from "./reason-codes.js";

export const TAG_SAMPLE_SIZE = 40;
export const PRACTICE_SAMPLE_SIZE = 8;

export interface TagItem {
  id: string;
  text: string;
}

export interface TagSource {
  runId: string;
  key: string;
  statedReason?: string;
}

export interface DrawnSample {
  items: TagItem[];
  /** From each opaque id to the call it came from. Kept apart from the page. */
  key: Record<string, { runId: string; callKey: string }>;
}

/** A seeded draw of `n` of the sources that have a stated reason, shown in a random order under ids `<prefix>01`, `<prefix>02`, … */
export function drawTagSample(sources: readonly TagSource[], n: number, seed: number, prefix: string): DrawnSample {
  const eligible = sources.filter((s) => s.statedReason !== undefined && s.statedReason.trim() !== "");
  if (eligible.length < n) throw new Error(`only ${eligible.length} stated reasons to draw ${n} from`);
  const rng = mulberry32(deriveSeed(seed, `tagging:${prefix}`));
  const pool = [...eligible];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, n);
  const width = String(n).length;
  const items: TagItem[] = [];
  const key: DrawnSample["key"] = {};
  picked.forEach((s, i) => {
    const id = `${prefix}${String(i + 1).padStart(width, "0")}`;
    items.push({ id, text: s.statedReason!.trim() });
    key[id] = { runId: s.runId, callKey: s.key };
  });
  return { items, key };
}

/** The category's short name and what counts, split from the label the rules file keeps for it. */
const parts = (c: (typeof REASON_CATEGORIES)[number]): { name: string; rest: string } => {
  const [name, ...rest] = CATEGORY_LABELS[c].split(" — ");
  return { name, rest: rest.join(" — ") };
};

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** JSON that is safe inside a script element: `<` and the line separators are escaped. */
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028").replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

export interface TaggingPageInput {
  mode: "practice" | "real";
  items: readonly TagItem[];
}

export const TAGGING_TITLE = "Reason Tagging";

export function renderTaggingPage(input: TaggingPageInput): string {
  const real = input.mode === "real";
  const cats = REASON_CATEGORIES.map((c) => ({ id: c, ...parts(c) }));
  const catRows = cats
    .map(
      (c, i) =>
        `<li><span class="num">${i + 1}</span><span><strong>${escapeHtml(c.name)}</strong><br><span class="def">${escapeHtml(c.rest)}</span></span></li>`,
    )
    .join("\n        ");
  const n = input.items.length;
  return `<title>${TAGGING_TITLE}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap">
<style>
  /* One column that works as a form: instructions first, then one reason at a time. */
  :root {
    --bg: #f4f6f3;
    --surface: #ffffff;
    --ink: #1c231f;
    --muted: #59655e;
    --line: #d5dcd6;
    --accent: #2c6b5a;
    --accent-ink: #ffffff;
    --soft: #e5efe9;
    --warn: #a4501c;
    --font-ui: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
    --font-read: "Source Serif 4", Georgia, "Times New Roman", serif;
    --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #111613; --surface: #19211d; --ink: #e5ebe6; --muted: #9ba8a0; --line: #2c3832;
      --accent: #78c6ac; --accent-ink: #0d1310; --soft: #223029; --warn: #e0925e; color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg: #111613; --surface: #19211d; --ink: #e5ebe6; --muted: #9ba8a0; --line: #2c3832;
    --accent: #78c6ac; --accent-ink: #0d1310; --soft: #223029; --warn: #e0925e; color-scheme: dark;
  }
  body { background: var(--bg); color: var(--ink); font-family: var(--font-ui); font-size: 15px; line-height: 1.5; padding-inline: 16px; padding-block: 24px 48px; }
  .wrap { max-width: 720px; margin-inline: auto; display: flex; flex-direction: column; gap: 20px; }
  h1 { font-size: 24px; line-height: 1.2; margin: 0; font-weight: 600; text-wrap: balance; }
  h2 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
  p { margin: 0 0 8px; max-width: 65ch; }
  .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; }
  .badge { font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
  .badge.practice { color: var(--warn); border-color: var(--warn); }
  details.how { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  details.how summary { cursor: pointer; font-weight: 600; }
  details.how[open] summary { margin-bottom: 10px; }
  ol.steps { margin: 0 0 12px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
  ul.cats { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  ul.cats li { display: flex; gap: 10px; align-items: baseline; }
  .num { font-family: var(--font-mono); font-size: 13px; min-width: 1.4em; color: var(--muted); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 18px 16px; display: flex; flex-direction: column; gap: 16px; }
  .meter { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--muted); }
  .meter .bar { flex: 1; height: 6px; background: var(--soft); border-radius: 3px; overflow: hidden; }
  .meter .bar i { display: block; height: 100%; background: var(--accent); width: 0; }
  .rid { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }
  blockquote { margin: 0; font-family: var(--font-read); font-size: 18px; line-height: 1.55; max-width: 65ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  legend { font-size: 13px; color: var(--muted); padding: 0; margin-bottom: 8px; }
  label.opt { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
  label.opt:hover { border-color: var(--accent); }
  label.opt input { margin-top: 4px; width: 16px; height: 16px; accent-color: var(--accent); flex: none; }
  label.opt:has(input:checked) { background: var(--soft); border-color: var(--accent); }
  label.opt .t { min-width: 0; }
  label.opt .t span, .def { color: var(--muted); }
  label.opt .t span { display: block; }
  label.none { border-style: dashed; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  button { font: inherit; font-weight: 500; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .status { font-size: 13px; color: var(--muted); }
  .status.bad { color: var(--warn); }
  .hint { font-size: 13px; color: var(--muted); }
  textarea { width: 100%; min-height: 120px; font-family: var(--font-mono); font-size: 12px; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  @media (prefers-reduced-motion: no-preference) { .meter .bar i { transition: width 0.2s ease; } }
</style>

<div class="wrap">
  <div class="top">
    <h1>${TAGGING_TITLE}</h1>
    <span class="badge${real ? "" : " practice"}">${real ? `Real round, ${n} reasons` : `Practice round, ${n} reasons, not counted`}</span>
  </div>

  <details class="how" open>
    <summary>How this works</summary>
    <p>Each reason below is a line an AI agent wrote about what it was doing in a small market, mostly about how to pay: in USDC (dollars) or in fSIU (a claim for work). A keyword rule, written before any of these reasons were collected, sorts reasons like these into nine categories. You tag ${real ? `${n} of them` : "a few practice ones"} by hand, so we can see how far the rule agrees with a person reading the same words. Nobody looks at the rule's answers for these reasons until you have finished, and nothing on this page says which agent wrote what.</p>
    <p>Names such as TYPE-2, TRADER-3, qr-1 and ISSUER-B are labels from the game. TYPE-1 to TYPE-4 are four kinds of job, and each trader can deliver only one kind. TRADER-1 to TRADER-4 are the agents. qr-1 is one quote. ISSUER-B sells raw work, the input every job uses up. You do not need to follow them. Read for why the agent chose what it chose.</p>
    <ol class="steps">
      <li>Read the reason.</li>
      <li>Tick every category that fits. One reason can fit several.</li>
      <li>If none fits, tick <em>None of these</em>.</li>
      <li>Press <em>Next</em>. <em>Back</em> lets you change an earlier answer.</li>
      <li>After the last reason your tags are saved to Claude. You can also download them.</li>
    </ol>
    <p>Go by what the reason means, not by whether it contains a particular word. Do not try to guess which agent wrote it or what answer is expected. It takes about 30 minutes. You can close the page and come back: answers are saved as you go and the page resumes at the first reason you have not tagged. Keys 1 to 9 tick a category, 0 ticks <em>None of these</em>, Enter moves on.</p>
    <h2>The nine categories</h2>
    <ul class="cats">
        ${catRows}
    </ul>
    <p class="hint" style="margin-top:10px">Number 9 is for a reason that cites only the need or the obligation, such as "to meet my round 2 need", and nothing about why that asset or why now. <em>None of these</em> is for a reason that says something about the choice that fits none of the nine.</p>
  </details>

  <section class="card" id="card" aria-live="polite">
    <div class="meter"><span id="count">Reason 1 of ${n}</span><div class="bar"><i id="bar"></i></div><span class="rid" id="rid"></span></div>
    <blockquote id="reason"></blockquote>
    <fieldset id="options">
      <legend>Tick every category that fits this reason</legend>
    </fieldset>
    <div class="row">
      <button type="button" id="back">Back</button>
      <button type="button" id="next" class="primary" disabled>Next</button>
      <span class="status" id="status" role="status"></span>
    </div>
  </section>

  <section class="card" id="done" hidden>
    <h2 style="margin:0">All ${n} tagged</h2>
    <p id="doneStatus">Saving your tags to Claude…</p>
    <div class="row">
      <button type="button" id="download" class="primary" hidden>Download tags (.json)</button>
      <button type="button" id="copy">Copy tags</button>
      <button type="button" id="review">Review answers</button>
    </div>
    <textarea id="dump" readonly hidden aria-label="Your tags as JSON"></textarea>
    <p class="hint">${real ? "Tell Claude you have finished. It will read the tags from the saved copy." : "This was practice only. Nothing from it is used."}</p>
  </section>
</div>

<script type="application/json" id="data">${scriptJson({ mode: input.mode, items: input.items, categories: cats.map((c) => ({ id: c.id, name: c.name, rest: c.rest })) })}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var items = data.items, cats = data.categories, mode = data.mode;
  var NONE = "none_of_these";
  var tags = {};          // id -> { ids: [category ids], none: bool }
  var at = 0;
  var db = null, dbWorking = false, queue = Promise.resolve(), saved = 0, saveFailed = "";
  var collectionName = "tags_" + mode;
  var storeKey = "reason-tagging-" + mode;

  var el = function (id) { return document.getElementById(id); };
  var optsBox = el("options");

  function store(write, value) {
    try { if (write) localStorage.setItem(storeKey, JSON.stringify(value)); else return JSON.parse(localStorage.getItem(storeKey) || "null"); } catch (e) { return null; }
    return null;
  }

  // Build the ten options once.
  var inputs = [];
  cats.forEach(function (c, i) {
    var label = document.createElement("label"); label.className = "opt";
    var input = document.createElement("input"); input.type = "checkbox"; input.id = "cat-" + c.id; input.value = c.id;
    var t = document.createElement("div"); t.className = "t";
    var strong = document.createElement("strong"); strong.textContent = (i + 1) + ". " + c.name;
    var span = document.createElement("span"); span.textContent = c.rest;
    t.appendChild(strong); t.appendChild(span); label.appendChild(input); label.appendChild(t); optsBox.appendChild(label);
    input.addEventListener("change", function () { if (input.checked) noneInput.checked = false; refresh(); });
    inputs.push(input);
  });
  var noneLabel = document.createElement("label"); noneLabel.className = "opt none";
  var noneInput = document.createElement("input"); noneInput.type = "checkbox"; noneInput.id = "cat-none"; noneInput.value = NONE;
  var noneT = document.createElement("div"); noneT.className = "t";
  var noneStrong = document.createElement("strong"); noneStrong.textContent = "0. None of these";
  var noneSpan = document.createElement("span"); noneSpan.textContent = "It says something about the choice that fits none of the nine.";
  noneT.appendChild(noneStrong); noneT.appendChild(noneSpan); noneLabel.appendChild(noneInput); noneLabel.appendChild(noneT); optsBox.appendChild(noneLabel);
  noneInput.addEventListener("change", function () { if (noneInput.checked) inputs.forEach(function (i) { i.checked = false; }); refresh(); });

  function current() { return { ids: inputs.filter(function (i) { return i.checked; }).map(function (i) { return i.value; }), none: noneInput.checked }; }
  function answered(t) { return t && (t.none || t.ids.length > 0); }
  function refresh() { el("next").disabled = !answered(current()); }

  function show(i) {
    at = i;
    var item = items[i], t = tags[item.id];
    el("reason").textContent = item.text;
    el("rid").textContent = item.id;
    el("count").textContent = "Reason " + (i + 1) + " of " + items.length;
    el("bar").style.width = (100 * i / items.length) + "%";
    inputs.forEach(function (inp) { inp.checked = !!t && t.ids.indexOf(inp.value) !== -1; });
    noneInput.checked = !!t && t.none;
    el("back").disabled = i === 0;
    el("next").textContent = i === items.length - 1 ? "Finish" : "Next";
    el("status").textContent = ""; el("status").className = "status";
    refresh();
    el("card").hidden = false; el("done").hidden = true;
    window.scrollTo(0, 0);
  }

  function persist(item) {
    var t = tags[item.id];
    store(true, tags);
    if (db === null) return;
    queue = queue.then(function () {
      return db.doc(collectionName + "/" + item.id).set({ ids: t.ids, none: t.none, at: new Date().toISOString() });
    }).then(function () { saved += 1; el("status").textContent = "Saved."; }).catch(function (e) {
      saveFailed = (e && e.code) || "error";
      el("status").textContent = "Not saved to Claude (" + saveFailed + "). Your answers are kept in this browser; download them at the end.";
      el("status").className = "status bad";
    });
  }

  function finish() {
    el("card").hidden = true; el("done").hidden = false; el("bar").style.width = "100%";
    var out = { mode: mode, taggedAt: new Date().toISOString(), tags: items.map(function (it) { var t = tags[it.id] || { ids: [], none: false }; return { id: it.id, categories: t.ids, none_of_these: t.none }; }) };
    var text = JSON.stringify(out, null, 2);
    el("dump").value = text;
    queue.then(function () {
      el("doneStatus").textContent = db === null ? "Saving to Claude is not available in this view. Download the tags, or copy them, and send them to Claude."
        : saveFailed ? "Some answers did not reach Claude (" + saveFailed + "). Download the tags or copy them as a backup."
        : "All " + items.length + " answers are saved to Claude.";
    });
    window.claude && window.claude.use && window.claude.use("downloads").then(function (d) {
      if (d) { var b = el("download"); b.hidden = false; b.onclick = function () { d.save({ filename: "reason-tags-" + mode + ".json", data: text }).catch(function () {}); }; }
    }).catch(function () {});
  }

  el("next").addEventListener("click", function () {
    var item = items[at]; tags[item.id] = current(); persist(item);
    if (at === items.length - 1) finish(); else show(at + 1);
  });
  el("back").addEventListener("click", function () { if (at > 0) { var item = items[at]; if (answered(current())) { tags[item.id] = current(); persist(item); } show(at - 1); } });
  el("copy").addEventListener("click", function () {
    var d = el("dump"); d.hidden = false; d.focus(); d.select();
    try { navigator.clipboard.writeText(d.value).then(function () { el("doneStatus").textContent = "Copied. Paste it to Claude."; }, function () {}); } catch (e) {}
  });
  el("review").addEventListener("click", function () { show(0); });
  document.addEventListener("keydown", function (e) {
    if (el("card").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter" && !el("next").disabled && document.activeElement && document.activeElement.tagName !== "BUTTON") { el("next").click(); e.preventDefault(); return; }
    if (e.key >= "1" && e.key <= "9" && inputs[Number(e.key) - 1]) { inputs[Number(e.key) - 1].click(); e.preventDefault(); }
    else if (e.key === "0") { noneInput.click(); e.preventDefault(); }
  });

  // Resume: what the saved copy has wins over this browser's copy.
  function start(fromDb) {
    var local = store(false);
    var merged = {};
    [local, fromDb].forEach(function (src) { if (src) Object.keys(src).forEach(function (k) { merged[k] = src[k]; }); });
    items.forEach(function (it) { if (!tags[it.id] && merged[it.id] && answered(merged[it.id])) tags[it.id] = { ids: merged[it.id].ids || [], none: !!merged[it.id].none }; });
    var first = items.findIndex(function (it) { return !tags[it.id]; });
    if (first === -1) { finish(); } else show(first);
  }
  show(0);
  if (window.claude && window.claude.use) {
    window.claude.use("db").then(function (d) {
      if (!d) { start(null); return; }
      db = d;
      return d.collection(collectionName).get().then(function (snap) {
        var got = {};
        snap.docs.forEach(function (doc) { var v = doc.data(); if (v) got[doc.id] = { ids: v.ids || [], none: !!v.none }; });
        start(got);
      }, function () { start(null); });
    }).catch(function () { start(null); });
  } else { start(null); }
})();
</script>
`;
}
