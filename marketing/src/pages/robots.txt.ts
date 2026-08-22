import type { APIRoute } from "astro";

import { SITE_CONFIG } from "@/site-config";
import { normalizeSourceUrls } from "@/lib/sitemap/shared";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const sitemap = site
    ? [
        `Sitemap: ${new URL("sitemap-index.xml", site).href}`,
        // Mirrored sitemap, only when sourceSitemapUrl is configured.
        ...(normalizeSourceUrls(SITE_CONFIG.sourceSitemapUrl).length > 0
          ? [`Sitemap: ${new URL("sitemap.xml", site).href}`]
          : []),
      ].join("\n") + "\n"
    : "";

  const body = `User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: Twitterbot
Allow: /

User-agent: facebookexternalhit
Allow: /

User-agent: *
Allow: /

${sitemap}`;

  return new Response(body, {
    headers: { "Content-Type": "text/plain" },
  });
};
