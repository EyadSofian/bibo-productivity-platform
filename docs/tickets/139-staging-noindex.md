# 139 — Block crawlers on staging (robots.txt + noindex)

**Status: Done** (deployed 2026-07-04)

## Problem

Staging (`https://employeetracking.namnguyen.pro`) served the same crawler-welcoming
`robots.txt` as production (Allow all + explicit AI-bot welcomes + staging sitemap), so
search engines could crawl and index the staging copy — duplicate content competing with
bibotracker.com.

Also latent bug: `deploy/build.sh` calls `node marketing/build.mjs staging`, but the
`staging` entry had been dropped from `ENVS` in `build.mjs` (only `default`/`production`
remained), so the staging deploy's marketing render would have thrown.

## Change

- `marketing/build.mjs`:
  - Re-added the `staging` env (`base=employeetracking.namnguyen.pro`, no GA,
    `out=site-staging/`, `noindex: true`).
  - When `ENV.noindex`: `robots.txt` becomes `User-agent: * / Disallow: /` (no Sitemap
    line), and the template's `<meta name="robots" content="index, follow, …">` is
    swapped for `noindex, nofollow` on every locale page.
  - Production/default output unchanged.
- `deploy/build.sh` (local-only): staging render now goes to `marketing/site-staging/`
  (mirrors the prod `site-prod/` pattern) and is layered over the committed
  `marketing/site/` assets when staging the web root — the committed `site/` is no
  longer overwritten by staging builds.
- `.gitignore`: ignore `marketing/site-staging/`.

## Verify (done, live)

```
curl -s https://employeetracking.namnguyen.pro/robots.txt   # → Disallow: /
curl -s https://employeetracking.namnguyen.pro/ | grep robots  # → noindex, nofollow
curl -s https://bibotracker.com/robots.txt                  # prod still Allow (unchanged)
```
