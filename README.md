<div align="center">

<img src="assets/banner.webp?v=2" alt="Pulldit — download Reddit images, GIFs & videos in your browser" width="100%" />

**Download Reddit images, GIFs & videos — entirely in your browser.**
No account. No tracking. No backend storing your data. Just a static page.

[![CI](https://github.com/pulldit/pulldit.github.io/actions/workflows/ci.yml/badge.svg)](https://github.com/pulldit/pulldit.github.io/actions/workflows/ci.yml)
[![CodeQL](https://github.com/pulldit/pulldit.github.io/actions/workflows/codeql.yml/badge.svg)](https://github.com/pulldit/pulldit.github.io/actions/workflows/codeql.yml)
[![Deploy](https://github.com/pulldit/pulldit.github.io/actions/workflows/deploy.yml/badge.svg)](https://github.com/pulldit/pulldit.github.io/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

[**▶ Open the app**](https://pulldit.github.io/)

</div>

---

## What it is

A complete, security-focused rewrite of the original RedditDownloader. It is a **100% static
site** (HTML + CSS + vanilla ES modules) that you can host on GitHub Pages or open from any
static web server. All work — fetching listings, previewing media, packaging ZIPs — happens
in the visitor's browser.

The original relied on a third-party CORS proxy (`allOrigins`) that could see all your
traffic. This rewrite removes that hard dependency and gives you **explicit, switchable modes**,
so you choose your own privacy/convenience trade-off — including an optional **browser extension**
that fetches everything from your own IP (the most reliable, proxy-free path).

## Features

- 🔗 Paste a **post URL**, a `redd.it` short link, a `reddit.com/media?url=…` file link,
  `r/subreddit`, `u/username`, or just a subreddit name.
- 🖼 Previews images, GIFs, native **galleries**, Reddit-hosted **videos**, and **crossposts**.
  Previews are lightweight **thumbnails** (a grid of hundreds stays smooth); **downloads & ZIPs
  are always the full-quality originals**.
- 🔀 Sort subreddits (hot / new / top / rising / …) with a time window.
- 📄 **Auto-pagination** — Reddit caps a listing request at 100 items, so a **Limit above 100**
  transparently fetches multiple pages (following the `after` cursor) up to a configurable **Max
  items**, with a delay between requests; the Limit field shows a hint when it kicks in.
- ✅ Select what you want, download **individually** or as **ZIP(s)** — big selections are split
  into **automatic batches** so one click downloads them all, named after the source
  (`pulldit-<subreddit>-<sort>[-<time>]`). Progress bars plus **Stop** (fetch & download) and
  **Pause/Resume** (download) controls, and a **Hide saved** toggle to clear already-grabbed items
  from view.
- 🧩 Optional **browser extension** for proxy-free ZIP from your own IP (most reliable; the page
  shows its version and an **update notice** when a newer build is released). Switchable proxy
  mode otherwise (see below). Your choice is remembered locally.
- 🔗 **Link history** — re-fetch past links in one click (newest = latest fetch), remove
  individual links, and an **auto-save** toggle (off = curate manually via “+ Add current link”).
- 🕘 **Activity history** — a detailed log (fetch shows sort · time · proxy mode; downloads show
  filename · size; ZIPs show skipped · elapsed) with a configurable **display limit**, an
  **auto-overwrite vs. keep-everything** mode, a **“Show more”** expander, and per-entry delete.
- ⏭ **Skip already-downloaded** — remembers grabbed posts/images so big subreddits only fetch
  what's new (with a “count discarded as downloaded” toggle); a **Skipped** stat shows the rest.
- 🔬 **Media validation** — before saving/zipping, **Check 1** verifies each download's magic
  bytes are genuine image/video and rejects mislabeled payloads (HTML error/“removed”/rate-limit
  pages, executables, archives, scripts); optional **Check 2** decode-probes the few files with no
  known signature. Both toggleable in Advanced settings.
- 🛠 **Advanced settings** — download rate-limit (delay), request timeout, max file size, max files
  per ZIP, history limit/overwrite, link auto-save, the two validation checks, **auto-pagination**
  (toggle + max items + page-request delay), and the **Clear stored data** tool. Everything is
  saved locally and re-loaded automatically.
- 🛡 Hardened: strict Content-Security-Policy, locally-bundled libraries (no CDN), strict
  host allowlisting, no `innerHTML` with data, server-free.
- 🧪 An extensive vitest suite (163 tests) covering the security-critical logic.

## Proxy modes (and why ZIP needs one)

Browsers refuse to let JavaScript **read the bytes** of a cross-origin file unless that server
sends CORS headers. Reddit's image CDN (`i.redd.it`) does **not**. So images can be *shown* and
*opened*, but to **bundle them into a ZIP** the bytes must pass through something that adds CORS.

| Mode | Bulk ZIP | Who sees your traffic | Setup |
|------|:--------:|-----------------------|-------|
| **Pulldit Extension** | ✅ | Only you (your own IP, no relay) | One-time install — see [`extension/`](extension/README.md) |
| **Direct** (default) | ❌ | Only Reddit | None — most private |
| **Your Cloudflare Worker** | ✅ | Only you (your own proxy) | ~5 min, free — see [`worker/`](worker/README.md) |
| **Public CORS proxy** | ✅ | A third party relays it | None — most convenient |

> In **Direct** mode you still get full previews and one-by-one downloads. Only the *bulk ZIP*
> requires reading raw bytes, which the browser blocks cross-origin.

### Most reliable: the Pulldit Bridge extension

Reddit also returns `403 Blocked` to **datacenter IPs** — where every public proxy and even a
Cloudflare Worker live — so those are best-effort. The optional [**Pulldit Bridge**](extension/README.md)
extension sidesteps both walls: its background worker is exempt from CORS and runs from **your own
residential IP**, so it fetches the listing JSON (no 403) *and* reads `i.redd.it` bytes (no CORS).
The website detects the extension automatically and unlocks an **“Extension”** mode — same page,
same UI, full proxy-free ZIP. It is locked to Reddit/imgur hosts and only serves the Pulldit page.

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
3. The [`deploy`](.github/workflows/deploy.yml) workflow stages the static files, packages the
   browser extension, and publishes everything. (It uploads only `index.html`, `styles.css`,
   `assets/`, `src/`, `vendor/`, and the generated `pulldit-bridge.zip` — never `node_modules`.)

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
- **Content validation** (`src/media-validate.js`): fetched bytes are sniffed by magic number
  before being saved or zipped — known image/video formats pass, non-media/dangerous payloads
  (executables, archives, scripts, HTML/JSON error pages) are rejected, and an optional decode
  probe (`createImageBitmap`, freed immediately) settles the unknown remainder. This is content
  sniffing, **not** an antivirus — media is decoded data, not executed code.
- **Safe DOM:** all rendering uses `createElement` + `textContent`; user/Reddit data is never
  injected as HTML.
- **Least-privilege extension:** the optional [browser extension](extension/README.md) requests
  only `host_permissions` for Reddit/imgur (no tabs, storage, or `<all_urls>`), enforces the same
  host allowlist in its background worker, and only serves requests from the Pulldit page — it is
  **not an open proxy**.

## Project structure

```
index.html              # UI shell + strict CSP
styles.css              # dark-first responsive styles
assets/logo.svg         # logo / favicon
src/
  config.js             # allowlists, limits, proxy presets
  url-guard.js          # URL/host validation, IP checks, filename sanitizing
  reddit.js             # input parsing + listing normalization + thumbnails
  proxy.js              # proxy modes (direct/worker/public/extension) + hardened fetch
  bridge-client.js      # page-side client for the optional browser extension
  filters.js            # type/source filtering
  stats.js              # fetch/download statistics (cumulative)
  history.js            # activity log helpers (entry rendering + caps)
  media-validate.js     # magic-byte sniffing (Check 1) + decode probe (Check 2)
  download.js           # single + ZIP downloads (rate-limit, size/timeout caps, validation)
  app.js                # UI controller (panels, link/activity history, advanced settings, skip registry)
vendor/                 # JSZip + FileSaver (pinned, local)
worker/                 # optional self-hosted secure proxy (Cloudflare)
extension/              # optional MV3 browser extension (proxy-free ZIP via your own IP)
scripts/                # syntax-check, extension pack/bump, publish
test/                   # vitest suites
.github/workflows/      # CI, Pages deploy, CodeQL, security scans
```

## Development

```bash
npm test          # run the vitest suites
npm run check     # syntax-check every shipped JS file
npm run build     # check + test (the CI gate)
npm run pack:ext  # package extension/ into pulldit-bridge.zip
npm run bump:ext  # bump the extension's patch version (manifest = single source of truth)
```

## Disclaimer & responsible use

This software is provided **“as is”, without warranty of any kind**, and the authors accept
**no liability** — see the [MIT License](LICENSE).

You are solely responsible for what you download and how you use it. Respect **copyright**, the
original creators, and [Reddit's User Agreement](https://www.redditinc.com/policies/user-agreement).
Download only content you have the right to. Do not use this tool for harassment, unauthorized
redistribution, or any unlawful purpose.

**Pulldit is an independent project and is not affiliated with, endorsed by, or
sponsored by Reddit, Inc.** “Reddit” is a trademark of Reddit, Inc.

## License

[MIT](LICENSE) © Pulldit contributors
