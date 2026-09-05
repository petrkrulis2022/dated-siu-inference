import { esc } from "../format.js";

export interface LayoutOptions {
  title: string;
  bodyHtml: string;
  /** "" for pages at the site root, "../" for one level deep (prints/*.html), etc. — every
   * internal link is relative to this, so the build output works when deployed at any path,
   * not just a domain root. */
  basePath: string;
}

export function renderLayout({ title, bodyHtml, basePath }: LayoutOptions): string {
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
<body>
<div class="container">
<header class="site-header">
  <a class="wordmark" href="${basePath}index.html"><img class="wordmark-icon" src="${basePath}logo.png" alt="" width="40" height="40">Touchstone Assay</a>
  <nav class="site-nav">
    <a href="${basePath}index.html">Series</a>
    <a href="${basePath}prints/index.html">Prints</a>
    <a href="${basePath}models/index.html">Models</a>
    <a href="${basePath}frontier/index.html">Frontier SIU</a>
    <a href="${basePath}commodity/index.html">Commodity SIU</a>
    <a href="${basePath}for-agents.html">For agents</a>
  </nav>
</header>
${bodyHtml}
<footer class="site-footer">
  <p>SIU is a measurement standard and data publication. Nothing on this site is an offer of any token, security or investment.</p>
</footer>
</div>
<script src="https://chat.touchstoneassay.com/widget.js" defer></script>
</body>
</html>
`;
}
