/** The tagging page's stylesheet: system fonts only (the page is a local file and loads nothing from the network), light and dark, one column that works at phone width. */
export const TAG_PAGE_CSS = `
:root { --bg:#f4f6f3; --surface:#fff; --ink:#1c231f; --muted:#59655e; --line:#d5dcd6; --accent:#2c6b5a; --accent-ink:#fff; --soft:#e5efe9; --warn:#a4501c;
  --ui: system-ui, -apple-system, "Segoe UI", sans-serif; --read: Georgia, "Times New Roman", serif; --mono: ui-monospace, Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#111613; --surface:#19211d; --ink:#e5ebe6; --muted:#9ba8a0; --line:#2c3832; --accent:#78c6ac; --accent-ink:#0d1310; --soft:#223029; --warn:#e0925e; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#111613; --surface:#19211d; --ink:#e5ebe6; --muted:#9ba8a0; --line:#2c3832; --accent:#78c6ac; --accent-ink:#0d1310; --soft:#223029; --warn:#e0925e; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--ui); font-size: 15px; line-height: 1.5; padding: 24px 16px 48px; }
.wrap { max-width: 720px; margin-inline: auto; display: flex; flex-direction: column; gap: 20px; }
h1 { font-size: 24px; line-height: 1.2; margin: 0; font-weight: 600; text-wrap: balance; }
h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; font-weight: 600; }
p { margin: 0 0 8px; max-width: 65ch; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; }
.badge { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
.badge.practice { color: var(--warn); border-color: var(--warn); }
details.how, .card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
details.how summary { cursor: pointer; font-weight: 600; }
ul.cats, ol.steps { margin: 0 0 12px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.def { color: var(--muted); }
.card { padding: 18px 16px; display: flex; flex-direction: column; gap: 16px; }
.meter { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--muted); }
.bar { flex: 1; height: 6px; background: var(--soft); border-radius: 3px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--accent); width: 0; }
.rid { font-family: var(--mono); font-size: 12px; }
blockquote { margin: 0; font-family: var(--read); font-size: 18px; line-height: 1.55; max-width: 65ch; white-space: pre-wrap; overflow-wrap: anywhere; }
fieldset { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
legend { font-size: 13px; color: var(--muted); padding: 0; margin-bottom: 8px; }
label.opt { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
label.opt:hover { border-color: var(--accent); }
label.opt input { margin-top: 4px; width: 16px; height: 16px; accent-color: var(--accent); flex: none; }
label.opt:has(input:checked) { background: var(--soft); border-color: var(--accent); }
label.opt .t span { display: block; color: var(--muted); }
label.none { border-style: dashed; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
button { font: inherit; font-weight: 500; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, input:focus-visible, summary:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.status, .hint { font-size: 13px; color: var(--muted); }
textarea { width: 100%; min-height: 120px; font-family: var(--mono); font-size: 12px; background: var(--bg); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
`;
