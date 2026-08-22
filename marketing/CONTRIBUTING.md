# Contributing

Thanks for helping improve the starter. This repo is the template thousands of
client sites get cloned from, so the bar is "does this make the first day of a
new build better."

## Setup

```bash
npm install
npm run dev
```

## The gate

```bash
npm run verify
```

This runs eslint, `astro check`, and a production build. It must pass before
you open a pull request — CI runs the same command with `npm ci`, so a change
that only works against a warm `node_modules` will fail there.

`verify` is silent on success and prints the full failing step's output on
failure.

## Conventions

Read [AGENTS.md](./AGENTS.md) first. It's the source of truth for file
organization, the component promotion ladder, the `ploy-*` design-token
hierarchy, prerender-vs-SSR rules, and content collections. It applies to human
contributors and coding agents alike.

The short version:

- Files are kebab-case, exports are PascalCase.
- Within a page subtree, import relatively; into shared code, use `@/`.
- Never import from `pages/<page>/` into shared code — promote it first.
- Style with `ploy-*` token classes, never raw `var()` or hex.
- Use Tailwind breakpoints for responsive work, not `matchMedia`.
- Icons come from `lucide-react`, not emoji.

## Things to leave alone

Changing these breaks Ploy deploys for every site built on the template:

- The `name` field and `scripts` block in `package.json`.
- The `site:` string literal in `astro.config.mjs` (patched at deploy time).
- The `build.assets` path in `astro.config.mjs`.
- The wrangler config lookup order in `astro.config.mjs`.

If you have a reason to change one, say so explicitly in the pull request so it
gets a closer look.

## Dependencies

npm and bun are both supported. If you add, remove, or bump a dependency,
regenerate **both** `package-lock.json` and `bun.lock` in the same commit.

## Pull requests

- Keep changes small and coherent.
- Describe what a site builder gains from the change.
- Include the `npm run verify` result.
