interface SiteConfig {
  name: string;
  description: string;
  // URL(s) of an existing sitemap to mirror at /sitemap.xml with hosts
  // rewritten to this site's domain. Empty to disable.
  sourceSitemapUrl: string | string[];
}

export const SITE_CONFIG: SiteConfig = {
  name: "Touchstone Assay",
  description:
    "Touchstone Assay publishes Dated SIU, the benchmark price of AI inference work — measured by executing a versioned task basket, not by surveying list prices.",
  sourceSitemapUrl: "",
};
