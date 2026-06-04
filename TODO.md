# RedditDownloader — Rebuild TODO

Static, browser-only rebuild (GitHub-Pages-hostable, no backend you must run).
Switchable proxy mode: (1) direct/no-proxy, (2) own Cloudflare Worker, (3) public proxy.
Hardened: strict CSP, locally-bundled libs (no CDN), host allowlist, no innerHTML, tests,
CI/CD (auto-deploy + security scans), SVG logo, About section, MIT + liability disclaimer,
public release.

## Phase 0 — Scaffolding
- [x] 0.1 git init, `main` branch, dirs (`src/ vendor/ worker/ test/ scripts/`)
- [x] 0.2 Bundle vendor libs locally (JSZip 3.10.1, FileSaver 2.0.5) + checksums
- [x] 0.3 `package.json` + `.gitignore` (incl. `.claude/`) + `scripts/syntax-check.mjs`
- [x] 0.4 `npm install` + clear audit (0 vulnerabilities)
- [ ] 0.5 Initial commit

## Phase 1 — Core safe modules (pure, testable, ES modules)
- [x] 1.1 `src/config.js` — host allowlists, proxy presets, size/count limits, app meta
- [x] 1.2 `src/url-guard.js` — parseHost, isAllowedMediaHost, validateMediaUrl, sanitizeFilename, extFromUrl
- [x] 1.3 `test/url-guard.test.js` — allowlist, rejects (private IPs, javascript:, data:, lookalikes), filenames

## Phase 2 — Reddit logic
- [ ] 2.1 `src/reddit.js` — parseInput (post/subreddit/user/url/shorthand), buildJsonUrl
- [ ] 2.2 `src/reddit.js` — normalizeListing -> MediaItem[] (image/gif/video/gallery/crosspost)
- [ ] 2.3 `test/reddit.test.js` — input parsing + normalization fixtures

## Phase 3 — Proxy + fetch layer
- [ ] 3.1 `src/proxy.js` — ProxyMode, presets, buildProxiedUrl, zip capability flag
- [ ] 3.2 `src/proxy.js` — fetchJson (direct), fetchBytes (via proxy) w/ timeout + size guard
- [ ] 3.3 `test/proxy.test.js` — proxied URL building per mode + validation

## Phase 4 — Download + ZIP
- [ ] 4.1 `src/download.js` — downloadSingle (named via proxy, else open) via FileSaver
- [ ] 4.2 `src/download.js` — downloadZip (JSZip, progress, per-file error tolerance)

## Phase 5 — UI + branding
- [ ] 5.1 `assets/logo.svg` + `assets/favicon.svg` — custom Reddit-downloader logo
- [ ] 5.2 `index.html` — strict CSP meta, semantic structure, About section, vendor + app scripts
- [ ] 5.3 `styles.css` — responsive dark UI, grid, progress, logo
- [ ] 5.4 `src/app.js` — input, proxy settings panel, fetch, render grid, select, download/zip
- [ ] 5.5 Persist settings (localStorage), accessibility, keyboard, About content

## Phase 6 — Cloudflare Worker (own secure proxy)
- [ ] 6.1 `worker/cloudflare-worker.js` — host allowlist, method/size/timeout guards, CORS, no SSRF
- [ ] 6.2 `worker/README.md` — deploy steps (wrangler + dashboard), CSP note

## Phase 7 — CI/CD (GitHub Actions)
- [ ] 7.1 `.github/workflows/ci.yml` — install, syntax-check, tests on push/PR
- [ ] 7.2 `.github/workflows/deploy.yml` — auto-deploy to GitHub Pages on main
- [ ] 7.3 `.github/workflows/codeql.yml` — CodeQL JS security scan
- [ ] 7.4 `.github/workflows/security.yml` — npm audit + dependency review
- [ ] 7.5 `.github/dependabot.yml` — weekly dep + actions updates

## Phase 8 — Docs, license & finalize
- [ ] 8.1 `LICENSE` (MIT — disclaims warranty & liability)
- [ ] 8.2 `README.md` — features, security model, proxy modes, run/deploy, About, DISCLAIMER (ToS/copyright/no-liability), badges
- [ ] 8.3 `.nojekyll` + Pages notes (avoid Jekyll processing)
- [ ] 8.4 `npm run build` green + manual smoke (serve + load)

## Phase 9 — Public release / GitHub setup
- [ ] 9.1 Final commit, tag `v1.0.0`
- [ ] 9.2 Create public GitHub repo via `gh` (if authed), push `main` + tags
- [ ] 9.3 Enable GitHub Pages (Actions source), create GitHub Release
- [ ] 9.4 Hand over: live URL + any manual steps needed
