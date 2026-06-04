<div align="center">

<img src="assets/logo.svg" width="96" height="96" alt="RedditDownloader logo" />

# RedditDownloader

**Download Reddit images, GIFs & videos — entirely in your browser.**
No account. No tracking. No backend storing your data. Just a static page.

[![CI](https://github.com/RedditDownloader/redditdownloader.github.io/actions/workflows/ci.yml/badge.svg)](https://github.com/RedditDownloader/redditdownloader.github.io/actions/workflows/ci.yml)
[![CodeQL](https://github.com/RedditDownloader/redditdownloader.github.io/actions/workflows/codeql.yml/badge.svg)](https://github.com/RedditDownloader/redditdownloader.github.io/actions/workflows/codeql.yml)
[![Deploy](https://github.com/RedditDownloader/redditdownloader.github.io/actions/workflows/deploy.yml/badge.svg)](https://github.com/RedditDownloader/redditdownloader.github.io/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

[**▶ Open the app**](https://redditdownloader.github.io/)

</div>

---

## What it is

A complete, security-focused rewrite of the original RedditDownloader. It is a **100% static
site** (HTML + CSS + vanilla ES modules) that you can host on GitHub Pages or open from any
static web server. All work — fetching listings, previewing media, packaging ZIPs — happens
in the visitor's browser.

The original relied on a third-party CORS proxy (`allOrigins`) that could see all your
traffic. This rewrite removes that dependency and gives you **three explicit modes**, so you
choose your own privacy/convenience trade-off.

## Features

- 🔗 Paste a **post URL**, a `redd.it` short link, `r/subreddit`, `u/username`, or just a
  subreddit name.
- 🖼 Previews images, GIFs, native **galleries**, Reddit-hosted **videos**, and **crossposts**.
- 🔀 Sort subreddits (hot / new / top / rising / …) with a time window.
- ✅ Select what you want, download **individually** or as a single **ZIP**.
- 🔒 Switchable proxy mode (see below). Your choice is remembered locally.
- 🛡 Hardened: strict Content-Security-Policy, locally-bundled libraries (no CDN), strict
  host allowlisting, no `innerHTML` with data, server-free.
- 🧪 65 unit tests covering the security-critical logic.

## Proxy modes (and why ZIP needs one)

Browsers refuse to let JavaScript **read the bytes** of a cross-origin file unless that server
sends CORS headers. Reddit's image CDN (`i.redd.it`) does **not**. So images can be *shown* and
*opened*, but to **bundle them into a ZIP** the bytes must pass through something that adds CORS.

| Mode | Bulk ZIP | Who sees your traffic | Setup |
|------|:--------:|-----------------------|-------|
| **Direct** (default) | ❌ | Only Reddit | None — most private |
| **Your Cloudflare Worker** | ✅ | Only you (your own proxy) | ~5 min, free — see [`worker/`](worker/README.md) |
| **Public CORS proxy** | ✅ | A third party relays it | None — most convenient |

> In **Direct** mode you still get full previews and one-by-one downloads. Only the *bulk ZIP*
> requires a proxy, and the recommended way to get it safely is your own Cloudflare Worker.

## Run locally

```bash
npm install
npm run serve      # serves the repo root at http://localhost:8080
```

Open <http://localhost:8080>. (A static server is required because ES modules don't load over
`file://` — opening `index.html` by double-click won't work, just like the live site.)

## Deploy to GitHub Pages

This repo ships a workflow that does it automatically:

1. Push to `main`.
2. In **Settings → Pages**, set **Source = GitHub Actions**.
3. The [`deploy`](.github/workflows/deploy.yml) workflow stages the static files and publishes
   them. (It uploads only `index.html`, `styles.css`, `assets/`, `src/`, `vendor/` — never
   `node_modules`.)

A `.nojekyll` file is included so Pages serves the files as-is.

## Security model

- **No third-party code at runtime.** JSZip and FileSaver are vendored into `vendor/` (pinned,
  checksummed) and loaded from the same origin — no CDN supply-chain risk.
- **Strict CSP** in `index.html`: `default-src 'none'`, `script-src 'self'`, `object-src`
  disabled, `base-uri`/`form-action` locked, and a `connect-src` allowlist of exactly Reddit +
  the curated proxies.
- **Host allowlisting** (`src/url-guard.js`): every media URL is validated against an allowlist
  and rejected if it resolves to a private/reserved/loopback address — the client-side analogue
  of SSRF protection. The **Cloudflare Worker** enforces the same allowlist server-side and is
  **not an open proxy**.
- **Resource guards:** per-request timeouts and a streamed hard size cap on every download.
- **Safe DOM:** all rendering uses `createElement` + `textContent`; user/Reddit data is never
  injected as HTML.

## Project structure

```
index.html              # UI shell + strict CSP
styles.css              # dark-first responsive styles
assets/logo.svg         # logo / favicon
src/
  config.js             # allowlists, limits, proxy presets
  url-guard.js          # URL/host validation, IP checks, filename sanitizing
  reddit.js             # input parsing + listing normalization
  proxy.js              # proxy modes + hardened fetch (timeout, size cap)
  download.js           # single + ZIP downloads
  app.js                # UI controller
vendor/                 # JSZip + FileSaver (pinned, local)
worker/                 # optional self-hosted secure proxy (Cloudflare)
test/                   # vitest suites
.github/workflows/      # CI, Pages deploy, CodeQL, security scans
```

## Development

```bash
npm test          # run the vitest suites
npm run check     # syntax-check every shipped JS file
npm run build     # check + test (the CI gate)
```

## Disclaimer & responsible use

This software is provided **“as is”, without warranty of any kind**, and the authors accept
**no liability** — see the [MIT License](LICENSE).

You are solely responsible for what you download and how you use it. Respect **copyright**, the
original creators, and [Reddit's User Agreement](https://www.redditinc.com/policies/user-agreement).
Download only content you have the right to. Do not use this tool for harassment, unauthorized
redistribution, or any unlawful purpose.

**RedditDownloader is an independent project and is not affiliated with, endorsed by, or
sponsored by Reddit, Inc.** “Reddit” is a trademark of Reddit, Inc.

## License

[MIT](LICENSE) © RedditDownloader contributors
