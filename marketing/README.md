# Ploy Astro Starter

A production-ready starter for marketing sites, built to be picked up by an
agency or freelancer at the start of a client project and imported into
[Ploy](https://ploy.ai) with the CLI.

**Astro 6** (SSR on Cloudflare Workers) · **React 19** · **TypeScript (strict)** ·
**Tailwind CSS v4** · **CVA / shadcn-compatible** · **motion/react**

Out of the box you get SEO metadata and JSON-LD, a sitemap (including a
reverse-proxy mirroring mode), `robots.txt`, a generated `llms.txt`, a
Markdown/MDX content pipeline, form handling, and a themeable design-token
system — so the first day of a client build is spent on their brand, not on
wiring.

---

## Quick start

```bash
git clone https://github.com/Ploy-AI/tenant-starter-astro.git my-client-site
cd my-client-site
npm install
npm run dev            # http://localhost:3000
```

Then, before anything else:

1. Fill in `src/site-config.ts` (`name`, `description`) — these drive `<title>`,
   meta description, and `llms.txt`.
2. Replace the placeholder theme in `src/styles/globals.css` (look for the
   `PLACEHOLDER THEME` marker) with the client's colors, radii, and fonts.
3. Replace the placeholder home page at
   `src/components/pages/home/page.tsx`.

### Commands

| Command                           | What it does                              |
| --------------------------------- | ----------------------------------------- |
| `npm run dev`                     | Dev server at `localhost:3000`            |
| `npm run verify`                  | **The gate** — eslint + typecheck + build |
| `npm run check`                   | Astro typecheck only                      |
| `npm run build`                   | Production build to `./dist/`             |
| `npm run lint` / `npm run format` | eslint / prettier                         |

`npm run verify` is the contract. If it fails, the change is broken. CI runs
exactly this on every pull request.

---

## Importing into Ploy

Requires a Ploy **Pro plan or higher** (Code Sync). Full docs:
[docs.ploy.ai/cli](https://docs.ploy.ai/cli)

```bash
curl -fsSL https://ploy.ai/install.sh | sh   # install the CLI

ploy login
ploy workspace use
ploy site use
ploy site code-sync init                     # prints clone/connection instructions
ploy skills init                             # install agent skills at the repo root

# ...build the site, push to main...

ploy site code-sync sync
ploy site publish --wait
```

### Things that will break your import if you change them

These look like cleanup opportunities. They are not.

- **`package.json` `name` must stay exactly `ploy-web`.** Code Sync matches on
  it. Renaming it to match your project breaks the sync.
- **Don't edit the `scripts` block in `package.json`.** Ploy's deploy pipeline
  invokes these by name.
- **`package.json` must be a real file, not a symlink**, and `src/pages/` must
  exist.
- **Keep `site:` in `astro.config.mjs` a plain string literal.** Ploy rewrites
  that literal to the tenant domain at deploy time with an AST patcher; an
  env-var lookup or template string won't be patched.
- **Keep your work on `main`.** Code Sync reconciles against it.

---

## Project layout

```
src/pages/                  Astro routes — thin shells that mount React
src/components/
  pages/<page>/page.tsx     page composition (entry point)
  pages/<page>/sections/    page-local sections
  ui/                       shared primitives (CVA + ploy tokens)
  sections/                 shared sections (navbar, footer)
src/content/pages/          Markdown/MDX rendered by [...slug].astro
src/lib/                    framework-agnostic helpers
src/styles/globals.css      Tailwind v4 config + design tokens
```

Keep things local to a page until a second consumer needs them, then promote.
The full conventions — the promotion ladder, the `ploy-*` token hierarchy,
prerender-vs-SSR rules, forms, animations, content collections — live in
**[AGENTS.md](./AGENTS.md)**, which is also what coding agents read.

### Adding a page

```tsx
// src/components/pages/pricing/page.tsx
export function PricingPage() {
  return <div>Pricing</div>;
}
```

```astro
---
// src/pages/pricing.astro
import Layout from "../layouts/Layout.astro";
import { PricingPage } from "@/components/pages/pricing/page";

export const prerender = true;
---

<Layout title="Pricing">
  <PricingPage client:load />
</Layout>
```

Prerender by default; leave collection-backed, external-API-backed, and
request-time routes on SSR. SSR routes don't auto-register in the sitemap —
add their paths to `src/lib/sitemap/get-sitemap-paths.ts`.

### Adding content

Drop a Markdown file in `src/content/pages/` and it's served at `/<filename>`
by the catch-all route. See `src/content/pages/example-page.md` for the
frontmatter shape. `draft: true` renders in dev only and stays out of the
sitemap.

---

## Local build configuration

`wrangler.jsonc` is checked in as a **local-development fallback**. Ploy
generates its own `wrangler.toml` at deploy time, and `astro.config.mjs`
prefers that file, so the committed config never affects a Ploy deploy — it
exists so a clean `git clone` can run `dev`, `check`, and `build` without one.

Without it, the Cloudflare adapter defaults the compatibility date to _today's
date_, which the pinned workerd in the lockfile can't support.

Deploying outside Ploy isn't a supported use case. If you want your own
Cloudflare Workers preview environment, point wrangler at a config kept
**outside** this repo rather than committing your own:

```bash
wrangler deploy --config /path/outside/repo/wrangler.toml
```

### Lockfiles

Both `package-lock.json` and `bun.lock` are committed — npm and bun are both
supported runtimes. If you change dependencies, regenerate **both** so they
don't drift.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). For security reports, see
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) — use it for client work, commercial or otherwise.
