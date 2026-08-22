---
title: Example Page
description: Shows the frontmatter shape for Markdown pages in this starter.
pubDate: 2026-01-01
draft: true
---

This file demonstrates the Markdown content pipeline. It lives at
`src/content/pages/example-page.md` and is rendered on demand by the catch-all
route `src/pages/[...slug].astro` at `/example-page`.

It is marked `draft: true`, so it renders in development only and is excluded
from the sitemap — that keeps it from showing up on a client's production site.
Delete this file, or drop the `draft` line to publish it.

## Frontmatter

| Field         | Required | Notes                                               |
| ------------- | -------- | --------------------------------------------------- |
| `title`       | yes      | Used for `<title>` and the Article JSON-LD headline |
| `pubDate`     | yes      | Coerced from a plain date string                    |
| `description` | no       | Meta description                                    |
| `slug`        | no       | Overrides the filename-derived path                 |
| `draft`       | no       | Defaults to `false`; drafts are dev-only            |

The schema is defined in `src/content.config.ts`. Body content renders inside a
`.prose` container, so Tailwind Typography styles apply automatically.

Nested files work too: `src/content/pages/legal/privacy.md` is served at
`/legal/privacy`.
