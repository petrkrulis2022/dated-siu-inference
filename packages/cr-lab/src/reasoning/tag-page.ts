/**
 * The local tagging page (D107): one self-contained HTML file, opened from disk in a browser. It is NOT an artifact and loads nothing from the network, because an agent's reasoning can
 * restate licensed figures and Blockworks' terms keep their data off any hosted page; the figures are masked all the same (`draw.ts`). The person sees only a random id and the passage,
 * never the model, the task, the window, the outcome or what the keyword rules made of it. Tags are kept in the browser as the person goes, and at the end downloaded as a file that
 * `reasoning-tagging import` reads back against the sample it was made on.
 */
import type { TagItem } from "./draw.js";
import type { TagScheme } from "./schemes.js";
import { TAG_PAGE_CSS } from "./tag-page-style.js";
import { TAG_PAGE_SCRIPT } from "./tag-page-script.js";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** JSON that is safe inside a script element: `<` and the line separators are escaped. */
const scriptJson = (v: unknown): string =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

export interface TagPageInput {
  scheme: TagScheme;
  mode: "practice" | "real";
  items: readonly TagItem[];
  sampleSha256: string;
}

export function renderTagPage(input: TagPageInput): string {
  const { scheme, items } = input;
  const real = input.mode === "real";
  const n = items.length;
  const cats = scheme.categories
    .map((c, i) =>
      `<li><strong>${escapeHtml(c.name)}</strong><br><span class="def">${escapeHtml(c.meaning)}</span></li>`.replace(
        "<li>",
        `<li value="${i + 1}">`,
      ),
    )
    .join("\n");
  const flag =
    scheme.flag === undefined
      ? ""
      : `<li><strong>${escapeHtml(scheme.flag.name)}</strong> (flag)<br><span class="def">${escapeHtml(scheme.flag.meaning)}</span></li>`;
  const notes = scheme.notes.map((t) => `<p>${escapeHtml(t)}</p>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(scheme.title)} tagging</title>
<style>${TAG_PAGE_CSS}</style></head>
<body>
<div class="wrap">
  <div class="top">
    <h1>${escapeHtml(scheme.title)}: tagging</h1>
    <span class="badge${real ? "" : " practice"}">${real ? `Real round, ${n} passages` : `Practice round, ${n} passages, not counted`}</span>
  </div>
  <details class="how" open>
    <summary>How this works</summary>
    <p>${escapeHtml(scheme.about)} You tag ${real ? `${n} of them` : "a few practice ones"} by hand, so we can see how far a keyword rule, written before any of this was collected, agrees with a person reading the same words. Nobody looks at the rule's answers until you have finished, and nothing on this page says which agent wrote what.</p>
    <ol class="steps">
      <li>Read the passage.</li>
      <li>Tick every box that fits. One passage can fit several.</li>
      <li>If none fits, tick <em>None of these</em>.</li>
      <li>Press <em>Next</em>. <em>Back</em> lets you change an earlier answer.</li>
      <li>At the end, download your tags: the file is what the import step reads. Your answers are also kept in this browser as you go, and the page resumes at the first passage you have not tagged.</li>
    </ol>
    ${notes}
    <h2>The categories</h2>
    <ul class="cats">
${cats}
${flag}
    </ul>
    <p class="hint">Keys: the number shown ticks that category, n ticks <em>None of these</em>${scheme.flag === undefined ? "" : ", a ticks the flag"}, Enter moves on.</p>
  </details>
  <section class="card" id="card" aria-live="polite">
    <div class="meter"><span id="count"></span><div class="bar"><i id="bar"></i></div><span class="rid" id="rid"></span></div>
    <blockquote id="passage"></blockquote>
    <fieldset id="options"><legend>Tick every box that fits this passage</legend></fieldset>
    <div class="row">
      <button type="button" id="back">Back</button>
      <button type="button" id="next" class="primary" disabled>Next</button>
    </div>
  </section>
  <section class="card" id="done" hidden>
    <h2 style="margin:0">All ${n} tagged</h2>
    <p>Download the tags; the file is what the import step reads. Nothing has left this computer.</p>
    <div class="row">
      <button type="button" id="download" class="primary">Download tags (.json)</button>
      <button type="button" id="copy">Copy tags</button>
      <button type="button" id="review">Review answers</button>
    </div>
    <textarea id="dump" readonly hidden aria-label="Your tags as JSON"></textarea>
  </section>
</div>
<script type="application/json" id="data">${scriptJson({ scheme, mode: input.mode, items, sampleSha256: input.sampleSha256 })}</script>
<script>${TAG_PAGE_SCRIPT}</script>
</body></html>
`;
}
