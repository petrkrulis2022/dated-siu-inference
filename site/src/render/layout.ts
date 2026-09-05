import { esc } from "../format.js";

export interface LayoutOptions {
  title: string;
  bodyHtml: string;
  /** "" for pages at the site root, "../" for one level deep (prints/*.html), etc. — every
   * internal link is relative to this, so the build output works when deployed at any path,
   * not just a domain root. */
  basePath: string;
  /** Which audience-toggle option this page represents — "for-agents" for for-agents.html only,
   * "human" (the default) for every other page. Drives which toggle link gets `aria-current`
   * server-side, so the initial render is correct with no client JS at all; mode-toggle.js only
   * adds localStorage persistence and the wordmark-redirect convenience on top. "For agents" and
   * "Try it here" both point at for-agents.html (the latter with a same-page anchor) — they're
   * not two audiences, the second is a connection *method* nested under the agent path, so both
   * mark the same toggle option active. */
  mode?: "human" | "for-agents";
}

export function renderLayout({ title, bodyHtml, basePath, mode = "human" }: LayoutOptions): string {
  const isForAgents = mode === "for-agents";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Dated SIU: the benchmark price of AI inference work, measured by executing a versioned task basket, not by surveying list prices.">
<link rel="icon" type="image/png" href="${basePath}favicon.png">
<link rel="stylesheet" href="${basePath}styles.css">
</head>
<body data-mode="${mode}">
<div class="container">
<header class="site-header">
  <a class="wordmark" href="${basePath}index.html"><img class="wordmark-icon" src="${basePath}logo.png" alt="" width="40" height="40">Touchstone Assay</a>
  <nav class="site-nav">
    <a href="${basePath}index.html">Series</a>
    <a href="${basePath}prints/index.html">Prints</a>
    <a href="${basePath}models/index.html">Models</a>
    <a href="${basePath}frontier/index.html">Frontier SIU</a>
    <a href="${basePath}commodity/index.html">Commodity SIU</a>
  </nav>
</header>
<nav class="mode-toggle" aria-label="Audience">
  <a href="${basePath}index.html"${isForAgents ? "" : ' aria-current="page"'}>Human</a>
  <a href="${basePath}for-agents.html"${isForAgents ? ' aria-current="page"' : ""}>For agents</a>
  <a href="${basePath}for-agents.html#try-it-here" title="Live, in-browser tools — a connection method, not a third audience">Try it here</a>
</nav>
${bodyHtml}
<footer class="site-footer">
  <p>SIU is a measurement standard and data publication. Nothing on this site is an offer of any token, security or investment.</p>
</footer>
</div>
<script src="https://chat.touchstoneassay.com/widget.js" defer></script>
<script type="module" src="${basePath}client/mode-toggle.js" defer></script>
</body>
</html>
`;
}
