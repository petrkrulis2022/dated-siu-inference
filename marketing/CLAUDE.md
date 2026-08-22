# AGENTS.md

Conventions for this Astro project. AI agents and contributors should follow these by default.

New to the repo? [README.md](./README.md) covers setup, the Ploy CLI import
flow, and the constraints that break a deploy if changed. This file is the
detailed convention reference.

## Commands

```bash
npm run verify          # typecheck + build (run after every change)
npm run dev             # dev server at localhost:3000
npm run check           # astro typecheck only
npm run build           # production build to ./dist/
npm run lint            # eslint
npm run format          # prettier
```

`npm run verify` is the gate. If it fails, your change is broken.

## Stack

| Layer      | Tool                              |
| ---------- | --------------------------------- |
| Framework  | Astro 6 (SSR, file-based routing) |
| UI         | React 19                          |
| Types      | TypeScript (strict)               |
| Styling    | Tailwind CSS v4                   |
| Components | CVA (+ shadcn/ui when needed)     |
| Animations | motion/react                      |
| Icons      | lucide-react                      |
| Forms      | react-hook-form + zod             |
| Deploy     | Cloudflare Workers                |

**Tailwind v4:** Config lives in `src/styles/globals.css`, not a config file.

**Path alias:** `@/*` maps to `./src/*`.

## File organization

```
src/pages/              # Astro routes (thin shells)
src/components/
  pages/
    home/               # everything local to the home route
      page.tsx          # page composition (entry point)
      sections/         # page-only sections
      components/       # page-only sub-components
      svgs/             # page-only SVGs
  sections/             # shared sections (navbar, footer)
  ui/                   # shared primitives (custom, or shadcn when added)
  svgs/                 # shared SVGs
src/content/pages/      # Markdown/MDX rendered by [...slug].astro
src/lib/                # framework-agnostic helpers, hooks, utils
src/styles/globals.css  # Tailwind v4 config + theme tokens
src/layouts/Layout.astro # HTML shell
```

Directories in this tree that don't exist yet (`sections/`, `svgs/`, a page's
`components/`) are promotion targets — create them when the promotion ladder
below says to, not preemptively.

### Promotion ladder

Keep things local until a second consumer needs them.

| Thing     | Starts in                  | Promote to             | When                       |
| --------- | -------------------------- | ---------------------- | -------------------------- |
| Component | `pages/<page>/components/` | `components/ui/`       | A second page needs it     |
| Section   | `pages/<page>/sections/`   | `components/sections/` | A second page needs it     |
| SVG       | `pages/<page>/svgs/`       | `components/svgs/`     | Used by shared ui/sections |
| Helper    | inline in file             | `src/lib/`             | A second file needs it     |

Never import from `pages/<page>/` into shared code. If shared code needs it, promote first.

## Routing

Astro uses file-based routing. `.astro` files are thin shells that mount React components — all visual work lives in `.tsx` files.

**To add a new page** (e.g., `/pricing`):

1. Create the React page at `src/components/pages/pricing/page.tsx`:

```tsx
export function PricingPage() {
  return <div>Pricing</div>;
}
```

2. Create the Astro route at `src/pages/pricing.astro`:

```astro
---
import Layout from "../layouts/Layout.astro";
import { PricingPage } from "@/components/pages/pricing/page";

export const prerender = true;
---

<Layout title="Pricing">
  <PricingPage client:load />
</Layout>
```

`export const prerender = true` builds the page to a static file (fast, edge-cached loads) and auto-includes it in the sitemap.

**Prerender by default.** Add it to every page unless the route is one of these — `output: "server"` makes SSR the framework default, so this is a per-page opt-in; don't forget the export. Keep these SSR (just omit `prerender`); prerendering them would bloat build/deploy time or serve stale data:

- **Dynamic / collection-backed** — paths grow with content (see [Content collections](#content-collections)); prerendering emits one HTML file per page per deploy, SSR keeps build time flat.
- **External-API-backed** — fetches from an API / CMS / DB whose data must stay fresh without a redeploy.
- **Request-time** — needs per-request data (auth-gated, personalized, headers/cookies).

## Sitemap

`astro.config.mjs` is wired up with the `sitemapWithCustomPages` helper (`src/lib/sitemap/sitemap-with-custom-pages-plugin.ts`) — a thin wrapper around `@astrojs/sitemap` that emits `sitemap-index.xml` at build. `src/pages/robots.txt.ts` points crawlers at it. Anything prerendered is auto-included; SSR routes aren't, so their paths are enumerated in `get-sitemap-paths.ts` (below).

**Ploy patches the `site:` literal** in `astro.config.mjs` to the tenant's domain at deploy time. Don't replace it with an env-var lookup — the AST patcher needs a string literal, and it only rewrites that one literal (so `${site}/...` elsewhere in the config never gets patched). The helper works around this with a placeholder host that gets rewritten at sitemap-emit time.

### SSR dynamic routes

Dynamic, collection-backed routes are an exception to [prerender-by-default](#routing): render them on demand (SSR), not prerendered via `getStaticPaths` — that keeps build/deploy time flat as content grows (see [Content collections](#content-collections)). SSR routes are invisible to `@astrojs/sitemap`, so enumerate their paths in `src/lib/sitemap/get-sitemap-paths.ts`.

The `pages` collection is already wired there — it reads `src/content/pages/` from disk and derives slugs. Add more sources alongside it (helper, API client, hardcoded array) using relative imports:

```ts
// src/lib/sitemap/get-sitemap-paths.ts
import { getAllProducts } from "../../products"; // or wherever your data lives

export function getSitemapPaths(): string[] {
  return getAllProducts().map((p) => `/products/${p.slug}`);
}
```

`getSitemapPaths()` runs **synchronously in Astro's config chain** (plain Node) — so `astro:content`/`getCollection` and the `@/` alias aren't available there. Read collection files from disk (as the `pages` source does) rather than calling `getCollection`. The plugin reads `getSitemapPaths()` at config time and accepts a `SitemapOptions` argument (`filter`, `i18n`, custom `serialize`, etc.). It's spread into `integrations` because it returns two integrations (a capture-site hook plus the configured `sitemap()`).

### Sitemap proxy (reverse-proxy tenants)

For tenants reverse-proxying an existing site at a different origin, set `SITE_CONFIG.sourceSitemapUrl` to that origin's sitemap URL. `/sitemap.xml` then mirrors it with every URL's host rewritten to the live Ploy domain. It's **request-time (SSR)** with a ~1h edge cache (Cloudflare `cf.cacheTtl`), so upstream page edits propagate without redeploying. A `<sitemapindex>` source is mirrored structurally via the `/proxied-sitemap-[i].xml` route (one entry per upstream entry); pass an array of URLs instead if the upstream has no single root sitemap. Nested indexes are intentionally unsupported (the entry route fails safe to an empty sitemap), as is a non-XML upstream response.

`sitemapWithCustomPages` injects both routes only when `sourceSitemapUrl` is set, and `robots.txt` advertises `/sitemap.xml` alongside the build-time `sitemap-index.xml` (which still covers the tenant's own prerendered pages). Leave `sourceSitemapUrl` empty to disable. The runtime is split across `src/lib/sitemap/sitemap.ts` (the `/sitemap.xml` route), `src/lib/sitemap/proxy-sitemap.ts` (the per-entry `/proxied-sitemap-[i].xml` route), and `src/lib/sitemap/shared.ts` (fetch / parse / rewrite helpers).

## Conventions

- **Files:** kebab-case (`hero-section.tsx`). **Exports:** PascalCase (`HeroSection`).
- **Imports within a page subtree** — relative: `../components/hero-card`, `./sections/hero`.
- **Imports into shared code** — use `@/`: `@/components/ui/button`, `@/lib/utils`.
- **Responsive styling:** use Tailwind breakpoints (`md:`, `lg:`), not `useEffect` + `matchMedia`.
- **Icons:** use `lucide-react`, not emoji.

## Styling with ploy tokens

All colors use the `ploy-*` token system defined in `globals.css`. Grep `@theme` in `globals.css` to see available tokens. Always use token classes (`bg-ploy-accent-primary`), never raw `var()` refs or hex values. If a shade doesn't exist, add it to `@theme`.

### Reach-for hierarchy

Pick the highest tier that expresses your intent. Drop a tier only when the one above can't carry the meaning.

1. **Semantic aliases** — `bg-ploy-background-primary`, `text-ploy-text-primary`, `border-ploy-border-primary`, `ploy-button-primary-*`. Default choice. Binds to role and swaps correctly across themes.
2. **Surface slots (S0–S5)** — `bg-ploy-neutral-primary-s0` … `-s5`. For layered surfaces that must stay visually distinct as they stack (nested cards, popovers, hovered rows).
3. **Base neutrals / accents** — `bg-ploy-neutral-primary`, `bg-ploy-accent-primary`. For brand/CTA moments where you want the exact root color, not a surface layer.
4. **Color scales (50–950)** — `bg-ploy-accent-primary-500`, `bg-ploy-neutral-primary-100`. For specific shades, gradients, or when opacity doesn't give enough contrast.

**Hover states:** Prefer opacity first (`hover:bg-primary/90`). Fall back to scales when opacity reveals content underneath.

### Surface slots

| Slot | Role              | Typical use                                   |
| ---- | ----------------- | --------------------------------------------- |
| `s0` | Highlight         | Sticky top bar, lifted element above the page |
| `s1` | Base surface      | Page background (= `ploy-neutral-primary`)    |
| `s2` | Alternate surface | Cards, alternating sections                   |
| `s3` | Elevated surface  | Popovers, nested cards, menus                 |
| `s4` | Stronger contrast | Input wells, inset regions                    |
| `s5` | Deepest contrast  | Borders, dividers, input outlines             |

### Token groups

| Group       | Examples                                                             | Use for                    |
| ----------- | -------------------------------------------------------------------- | -------------------------- |
| Backgrounds | `bg-ploy-background-primary`, `-secondary`, `-inverse`               | Page/section backgrounds   |
| Text        | `text-ploy-text-primary`, `-secondary`, `-inverse`                   | Body copy                  |
| Accents     | `bg-ploy-accent-primary`, `-secondary`, `-tertiary`                  | Brand/CTA colors           |
| Surfaces    | `bg-ploy-neutral-primary-s0` … `-s5`                                 | Layered surfaces (depth)   |
| Buttons     | `bg-ploy-button-primary-background`, `text-ploy-button-primary-text` | Button styling             |
| Borders     | `border-ploy-border-primary`                                         | Dividers, outlines         |
| Neutrals    | `bg-ploy-neutral-primary`, `-secondary`, `-inverse`                  | Surface colors             |
| Scales      | `bg-ploy-accent-primary-500`, `bg-ploy-neutral-primary-100`          | Specific shades, gradients |

## Component patterns

### Props and defaults

Section and page components that render copy or repeated children should be drop-in editable:

```tsx
interface Props {
  heading?: string;
  description?: string;
  features?: Feature[];
}

const DEFAULT_FEATURES: Feature[] = [
  /* ... */
];

export function FeaturesSection({
  heading = "Why choose us",
  description = "...",
  features = DEFAULT_FEATURES,
}: Props) {
  /* ... */
}
```

- Plain text: `string` prop with default.
- Rich copy with markup: `ReactNode` prop.
- Repeated items: array prop with typed shape + `DEFAULT_*` constant.
- Props that represent data (IDs, user input, API responses) should be required — don't fabricate defaults for those.

### Variants with CVA

When a prop maps to className combinations, use `class-variance-authority`. See `src/components/ui/button.tsx` for the pattern. Shared classes go in the base string — variants hold only what differs.

### Base components

Check `src/components/ui/` first — the component may already exist. If not, **prefer building a brand-adapted base component** that follows shadcn/ui conventions (composition, `cn()` + CVA variants, `forwardRef`, named exports) and uses the ploy token system for styling.

Reach for shadcn/ui itself when it's a better fit — complex primitives (dialogs, popovers, comboboxes) where reimplementing accessibility and interaction would be wasteful. Install it, then adapt it to the brand tokens:

```bash
bunx shadcn@latest add <component>
```

### Extracted sub-components

Repeated JSX inside a single file becomes a local function component in that file. Promote only when a second file needs it.

## Animations

| Complexity | Tool         | When to use                                |
| ---------- | ------------ | ------------------------------------------ |
| Simple     | Tailwind     | Hover states, fades, basic transforms      |
| Complex    | motion/react | Sequenced, scroll-triggered, choreographed |

Import from `motion/react` (not `framer-motion`). Animations run in the browser — the `.astro` shell mounts with `client:load`, which hydrates the React tree.

```tsx
import { motion } from "motion/react";

<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.5 }}
/>;
```

- **Always set `initial`** on motion elements that animate on mount/scroll. Missing `initial` = flash of final state (FOUC).
- For imperative animations (`useAnimate`, manual timelines) where `initial` can't capture the starting state, gate with `opacity-0` / `invisible` in CSS and let the animation clear it on the first frame.
- Wrap animated trees in `<MotionConfig reducedMotion="user">` to respect accessibility preferences.
- When animation doesn't appear: diagnose (is the island hydrated? is `initial` set? is there an `opacity-0` gate nothing is clearing?) before rewriting.

## Forms

### PloyForm (simple HTML forms in .astro)

```astro
<PloyForm name="contact" successMessage="Thanks!">
  <input name="email" type="email" required />
  <button type="submit">Send</button>
</PloyForm>
```

Submits via fetch to `/_ploy/form-submit`. No page reload.

### submitForm (React forms)

```tsx
import { submitForm } from "@/lib/ploy-forms/submit-form";

await submitForm("signup", { email, plan });
```

Use with react-hook-form + zod for complex validation flows.

## Analytics

Pageviews and SPA navigation are tracked automatically — no code needed. The Ploy platform injects the analytics script at the edge.

To track custom events:

```tsx
navigator.sendBeacon(
  "/_ploy/ingest",
  JSON.stringify({
    type: "track",
    event: "formSubmitted",
    properties: { formName: "contact" },
    timestamp: new Date().toISOString(),
  }),
);
```

Event types: `page` (automatic), `track` (custom events), `identify` (user association).

## Content pages

The `src/pages/[...slug].astro` catch-all renders markdown from `src/content/pages/` **on demand (SSR)** — it reads the slug from `Astro.params` and resolves the entry with `getEntry()` at request time, so adding pages never grows the build. Frontmatter shape:

```md
---
title: Page title
description: For SEO
pubDate: 2025-01-01
draft: true
---
```

`draft: true` pages are visible in dev only. Omit `draft` to publish.

## Content collections

Define collections in `src/content.config.ts` with Astro content loaders and zod schemas. Use `glob()` loaders for file-backed Markdown/MDX collections, and keep each collection's schema strict enough to catch bad frontmatter early.

Use `z.coerce.date()` for frontmatter dates. Markdown frontmatter starts as serialized data, so `z.date()` is usually too strict for author-edited files.

Use schema defaults for optional publishing fields and repeatable references:

```ts
draft: z.boolean().default(false),
tags: z.array(reference("tags")).default([]),
```

References are validated by entry ID. If a post references:

```yaml
tags:
  - astro
category: guides
```

then `src/content/tags/astro.md` and `src/content/categories/guides.md` must exist. Rename referenced files carefully because the filename/path is the reference ID.

Nested content IDs include their folder path. A file at `src/content/posts/2026/example.md` is referenced as `2026/example`, not just `example`.

Draft filtering is the route/helper's responsibility. Use a shared helper for collection listings so draft behavior stays consistent:

```ts
const isPublished = <T extends { data: { draft?: boolean } }>(entry: T) =>
  !entry.data.draft || !import.meta.env.PROD;
```

**Collection-backed routes are the main exception to [prerender-by-default](#routing) — keep them SSR (on demand).** A catch-all or content route should read `Astro.params`, fetch the entry at request time with `getEntry()` (or `getCollection()` + filter), and return a 404 `Response` on a miss — see `src/pages/[...slug].astro`. Since `output: "server"` is SSR by default, you keep these on demand simply by _not_ adding `export const prerender = true`. This keeps build/deploy time O(1) no matter how many entries the collection has (prerendering instead emits — and re-uploads — one HTML file per entry on every deploy). SSR routes don't auto-register in the sitemap, so their slugs go in `src/lib/sitemap/get-sitemap-paths.ts` (the `pages` collection is already wired).

Reserve `getStaticPaths()` + `export const prerender = true` for routes with a small, fixed set of paths worth pre-building to static HTML. Note `getStaticPaths()`/`paginate()` require `prerender = true`; if you keep a route on demand, don't depend on `Astro.props` from `getStaticPaths()` — read `Astro.params` and compute the result at request time.

For external CMS/API/DB content that must update without a redeploy, use a live content collection (`src/live.config.ts`, stable in Astro 6) instead of a build-time collection. Its routes won't appear in the build-time sitemap — `get-sitemap-paths.ts` can't enumerate them — so if you need them indexed, add a custom prerendered `*.xml.ts` endpoint that fetches the slugs.

Render Markdown/MDX content inside a `.prose` container when article typography should apply. Wrap custom MDX UI in `not-prose` when it should keep its own component styling instead of inheriting Tailwind Typography article styles.

Keep MDX content lightweight. Avoid importing client-heavy React components into content unless the content explicitly needs that behavior.

For simple site search, searching title, description/summary, and body is acceptable. For production-grade search, prefer a normalized or indexed search layer rather than expanding ad hoc string matching in route files.

## Working with Git and the Ploy GitHub Integration

See: [GitHub Integration](https://docs.ploy.ai/integrations/#development)

This repository may be edited from a Ploy sandbox or from a direct GitHub
checkout. Treat git as shared durable site history, not as a private scratch
branch. Prefer forward-moving history so Ploy and direct editors can reconcile
cleanly.

### Identify Your Editing Context

Before choosing a git workflow, identify where you are running. The files may
look the same, but remotes, local git config, and save behavior can differ.

Start with `git remote -v`. A direct checkout normally points at `github.com`.
A Ploy sandbox normally uses a Ploy-managed remote instead of the direct GitHub
URL.

If you are Korra working in a Ploy workspace, treat that as the Ploy sandbox
context.

### Safe Inspection

These commands are safe when you need context:

```bash
git status --short --branch
git log --oneline --decorate -20
git diff
git show <sha>
git fetch --all --prune
git config --local --list
```

Use them before broad edits, especially when a user mentions GitHub, rollback,
restore, missing sections, or unexpected overwrites.

### Editing Inside a Ploy Sandbox

Ploy automatically saves sandbox changes and may sync them to the remote in the
background. Prefer normal file edits plus Ploy's save/checkpoint flow.

- Use Ploy save/checkpoint for intentional versions. It may run git operations
  for you.
- Do not create shell git commits or push to `main` from inside Ploy unless the
  user explicitly asks for git recovery.
- Do not assume a Ploy checkpoint hash is the GitHub hash. Verify the visible
  git state when the exact commit matters.
- Keep changes small and coherent.

### Editing a Direct GitHub Checkout

When a user asks you to edit or publish from a direct clone, pushing to `main` is
allowed as a normal forward-moving operation:

1. Fetch first: `git fetch origin main`.
2. Confirm the local branch is based on the current `origin/main`.
3. Make a small coherent commit.
4. Run `npm run verify`.
5. Push with a normal fast-forward push, for example `git push origin main`.

If the direct checkout is behind, update from `origin/main` before committing or
stop and explain the divergence. Do not use force-push to make a local checkout
"win" over GitHub.

After a normal push to `main`, Ploy should pick up the updated remote history for
the site. This may be asynchronous, so before making more edits inside Ploy,
verify that Ploy shows the expected latest commit or use the visible sync/refresh
control.

### Commands That Need Explicit Recovery Intent

Do not run these during ordinary site editing:

```bash
git push --force
git reset --hard
git rebase
git merge
git pull --rebase
git checkout <sha> -- .
git restore .
```

Only use them when the user explicitly asks for git recovery and you have
verified the visible Ploy/repo state first. A normal `git push origin main` from
a direct checkout is fine after the user asks you to publish and verification
passes.

### Rollback and Recovery

When a user asks to recover to a commit hash, restore from GitHub, undo broad
changes, or fix unexpected overwrites:

1. Stop and inspect state before editing: `git status --short --branch`,
   `git log --oneline --decorate -20`, and the target commit with `git show`.
2. Prefer a forward recovery commit: use `git revert` or Ploy's restore/checkpoint
   flow instead of `git reset` or force-push.
3. If the remote was intentionally force-pushed or rewound, fetch first and make
   sure the workspace is based on the desired remote head before new edits.
4. After recovery, avoid additional edits until the user confirms the recovered
   site is the desired starting point.
5. If local state, GitHub state, and Ploy state disagree, report the exact
   commits and ask for confirmation instead of guessing.

### Deploying outside of Ploy is Unsupported

We support local editing of their Ploy site. However, publishing the Ploy-built site outside of our platform is possible but not a supported use case. We also cannot guarantee that your edits will be valid when sync'ed back into the Ploy editor and web preview.

If you use the Ploy site's [GitHub Integration](https://docs.ploy.ai/integrations/#development) to `git clone` to the repo to your own computer, here are some recommended workflows:

1. If you want to add third party GitHub Integrations to this project, please fork/mirror the repo to your own GitHub organization where you can self approve any integrations.
2. If you want to publish to your own Cloudflare Workers, perhaps as a self-hosted preview environment, we discourage `git add` your own `wrangler.toml|jsonc` files or changes to this repo. Doing so will conflict with Ploy's publishing platform assumptions. To publish to your own Workers, point at a config file maintained outside the repo, e.g. `wrangler deploy --config /some/path/outside/repo/wrangler.toml` where you maintain your own configs.
3. If you want to publish the site to other platforms, please consult their respective docs.

### Troubleshooting

#### package.json edits

Please do not edit the `scripts` in `package.json`, this will most likely disable your Ploy deployment.

The `name` field must stay exactly `ploy-web` — Ploy Code Sync matches on it,
so "fixing" it to match the repo or client name breaks the sync.

#### Lockfiles

Both `package-lock.json` and `bun.lock` are committed, since npm and bun are
both supported. If you change dependencies, regenerate **both** in the same
commit so they don't drift.

#### Cloudflare compatibility date

`wrangler.jsonc` is checked in as a local-development fallback and pins
`compatibility_date`. Without a wrangler config, `@astrojs/cloudflare` defaults
that date to _today_, which the workerd pinned in the lockfile can't support —
`dev`, `check`, and `build` all fail with:

> This Worker requires compatibility date "<today>", but the newest date
> supported by this server binary is "<older>"

Ploy generates its own `wrangler.toml` at deploy time and `astro.config.mjs`
prefers it, so the checked-in file never affects a deploy. Keep the pinned date
at or after 2026-02-19 (see the note in `wrangler.jsonc`).

#### frontend rendering issues

The Ploy sandbox for the site may be stale or outdated vs the `package.json` specifications.

Try `rm -rf ./node_modules` and then `npm|bun install` again to refresh the local package.

You should try to do this before any extensive debugging.

#### xxhash.wasm error

> `The requested module './xxhash.wasm' does not provide an export named 'default'`

Try adding this override to `package.json`:

```json
  "overrides": {
    "xxhash-wasm": "1.0.2"
  }
```
