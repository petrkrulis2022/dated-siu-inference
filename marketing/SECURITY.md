# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security reports.

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Ploy-AI/tenant-starter-astro/security/advisories/new)
on this repository, or email **security@ploy.ai**.

Include enough detail to reproduce: affected files or routes, the version or
commit, and the impact you observed.

We aim to acknowledge reports within three business days.

## Scope

This repository is a starter template. In scope:

- Vulnerabilities in the template's own code — the SSR routes, sitemap
  proxying, form submission helpers, and SEO/JSON-LD rendering.
- Defaults that would make a site built from this template insecure.

Out of scope:

- Vulnerabilities in a site built _from_ this template after it has been
  modified — report those to whoever operates that site.
- Issues in the Ploy platform itself, rather than this template. Send those to
  **security@ploy.ai**.
- Third-party dependency advisories with no exploitable path through this
  template; prefer opening a pull request bumping the dependency.

## A note on the sitemap proxy

`SITE_CONFIG.sourceSitemapUrl` makes the site fetch and mirror an upstream
sitemap at request time. Only point it at an origin you control — it performs
server-side fetches on behalf of your site.
