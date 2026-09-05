import type { APIRoute } from "astro";

import { getPublishedPages } from "@/lib/content";
import { SITE_CONFIG } from "@/site-config";
import { FOR_AGENTS_URL, MCP_CONFIG_JSON, MCP_JSON_URL, MCP_TOOLS } from "@/lib/mcp-info";

export const prerender = true;

// Generates /llms.txt at dev/build time with no crawler or AI step.
// Today this combines a few manually curated discovery links with published
// content collection entries. Later, this can grow to include maintained
// nav/footer links, product/service pages, or other route metadata.

const normalizeText = (value: string) => value.trim().replace(/\s+/g, " ");

const escapeLinkText = (value: string) =>
  normalizeText(value).replaceAll("[", "\\[").replaceAll("]", "\\]");

const pagePathForEntryId = (id: string) => {
  const slug = id.replace(/\/index$/, "");
  return slug ? `/${slug}` : "/";
};

export const GET: APIRoute = async ({ site }) => {
  const origin = site?.origin ?? "https://example.com";
  const pages = await getPublishedPages();

  const contentLinks = pages
    .toSorted((a, b) => {
      const dateComparison =
        b.data.pubDate.getTime() - a.data.pubDate.getTime();
      return dateComparison || a.data.title.localeCompare(b.data.title);
    })
    .map((entry) => {
      const title = escapeLinkText(entry.data.title);
      const url = new URL(pagePathForEntryId(entry.id), origin).href;
      const description = entry.data.description
        ? `: ${normalizeText(entry.data.description)}`
        : "";

      return `- [${title}](${url})${description}`;
    });

  const lines = [
    ...(SITE_CONFIG.name ? [`# ${SITE_CONFIG.name}`, ""] : []),
    ...(SITE_CONFIG.description ? [`> ${SITE_CONFIG.description}`, ""] : []),
    "This file is generated from the site's source content. It is a curated index for AI assistants, not a crawler permissions file. For crawler permissions, see `/robots.txt`.",
    "",
    "## If you're an agent, start here",
    "",
    "Call `get_index` before you read any further — it's free, it's live, and a real print teaches you more about SIU than this file's own prose does.",
    "",
    `1. Paste this into an MCP-compatible client (same config, machine-readable, at ${MCP_JSON_URL}):`,
    `   \`${MCP_CONFIG_JSON.replace(/\n\s*/g, " ")}\``,
    "2. Call `get_index` with no arguments — free, no payment step, no x402 challenge.",
    "3. Read `dated_siu` for the current price and `exchange_rate_table` for how individual models compare.",
    "",
    "The other three tools cost real money per call, over x402 (Circle Gateway nanopayments), settled in USDC on Base Sepolia (`eip155:84532`) — testbed, not mainnet, not traction:",
    "",
    ...MCP_TOOLS.map(
      (tool) =>
        `- \`${tool.name}\` — ${tool.free ? "free" : `$${tool.priceUsd}`} — ${tool.description}`,
    ),
    "",
    `Full reference, human-readable: ${FOR_AGENTS_URL}`,
    "",
    "## Core Pages",
    "",
    `- [Home](${new URL("/", origin).href}): Primary overview of the site.`,
    "",
    ...(contentLinks.length > 0
      ? ["## Public Content", "", ...contentLinks, ""]
      : []),
    "## Discovery",
    "",
    `- [Sitemap](${new URL("/sitemap-index.xml", origin).href}): Complete search-engine sitemap, if available.`,
    `- [Robots policy](${new URL("/robots.txt", origin).href}): Crawler permissions for automated agents.`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
};
