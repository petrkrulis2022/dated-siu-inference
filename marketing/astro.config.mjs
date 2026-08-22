// @ts-check
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, sessionDrivers } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import { sitemapWithCustomPages } from "./src/lib/sitemap/sitemap-with-custom-pages-plugin.ts";

// Ploy generates `wrangler.toml` at deploy time; it isn't checked in (and is
// gitignored). `wrangler.jsonc` IS checked in as a local-development fallback,
// because without any wrangler config the Cloudflare adapter defaults the
// compatibility date to today's date and every local command fails against the
// older workerd pinned in the lockfile. See wrangler.jsonc for the full note.
//
// Order matters: `wrangler.toml` is probed first, so a Ploy deploy always wins
// over the checked-in fallback.
// Also see: https://developers.cloudflare.com/workers/wrangler/configuration/
const wranglerConfig = [
  "./wrangler.toml",
  "./wrangler.jsonc",
  "./wrangler.json",
].find((path) => existsSync(fileURLToPath(new URL(path, import.meta.url))));

// Separate vite cache dirs so `astro dev` and `astro build`/`check` don't conflict.
const astroCommand = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
const viteCacheDir =
  astroCommand === "dev" || astroCommand === "preview"
    ? "node_modules/.vite-dev"
    : "node_modules/.vite-build";

// https://astro.build/config
export default defineConfig({
  // Patched at deploy time by Ploy — must remain a string literal. See AGENTS.md "Sitemap".
  // Deployed independently of Ploy now (Cloudflare Pages, git-connected to this repo), so the
  // real production hostname lives here instead.
  site: "https://touchstoneassay.com",
  // Static export: every route here is prerender = true (confirmed: index, 404, robots.txt,
  // llms.txt already were; [...slug].astro converted to getStaticPaths()). No server runtime
  // needed, which also sidesteps the Cloudflare Workers/workerd dev-server crash this project
  // hit locally earlier ("require_dist is not a function").
  output: "static",
  trailingSlash: "never",
  // Disable automatic Cloudflare KV session provisioning. Ploy sites don't
  // use Astro sessions; without this the adapter auto-creates a KV namespace
  // per deploy. The in-memory driver tells the adapter no KV binding is needed.
  session: {
    driver: sessionDrivers.lruCache(),
  },
  build: {
    // Ploy-reserved directory so tenant assets don't collide with a `defaultFallback`
    // origin that serves its own `/_astro/`. Keep in sync with
    // WELL_KNOWN_ASSET_ROUTES in ploy-world.
    assets: "_ploy_static/_astro",
  },
  adapter: cloudflare({
    imageService: "compile",
    ...(wranglerConfig && { configPath: wranglerConfig }),
  }),
  integrations: [
    mdx(),
    react(),
    // For SSR-only dynamic routes, edit src/lib/sitemap/get-sitemap-paths.ts.
    ...sitemapWithCustomPages(),
  ],
  vite: {
    cacheDir: viteCacheDir,
    plugins: [tailwindcss()],
    resolve: {
      // Use react-dom/server.edge instead of react-dom/server.browser for React 19.
      // Without this, MessageChannel from node:worker_threads needs to be polyfilled.
      alias: import.meta.env.PROD
        ? { "react-dom/server": "react-dom/server.edge" }
        : undefined,
    },
    ssr: {
      noExternal: ["xxhash-wasm"],
      ...(import.meta.env.PROD && {
        resolve: {
          conditions: ["workerd", "worker", "node"],
          externalConditions: ["workerd", "worker", "node"],
        },
      }),
    },
    server: {
      strictPort: true,
    },
  },
  server: {
    port: 3000,
    open: false,
  },
  devToolbar: {
    enabled: false,
  },
});
