# Feature TODO — Pulldit Bridge Extension (Variante 1) — 2026-06-04

## Goal
Optional MV3 browser extension that ENHANCES the existing static site (pulldit.github.io).
When installed, the page detects it and routes Reddit listing JSON + media bytes through the
extension's background worker → fetched from the user's OWN (residential) IP with NO CORS limit.
This unlocks proxy-free ZIP and avoids Reddit's datacenter-IP 403 (see [[project-reddit-ip-block]]).
Page still works fully without the extension (direct / public / worker modes unchanged).

## Verified facts driving the design
- i.redd.it withholds CORS from third-party origins (`Vary: Origin`, no ACAO) → static page CANNOT
  read its bytes. Extension background (host_permissions) CAN — no CORS in that context.
- i.redd.it media CDN does NOT IP-block datacenter; only reddit.com (listing) does. Extension uses
  the user's residential IP for BOTH → listing + bytes both work.
- MV3 content-script fetch IS CORS-bound; only the background service worker bypasses CORS. So bytes
  must flow background → content → page. chrome.runtime serializes to JSON → binary via base64.
- Content scripts are exempt from page CSP; window.postMessage is not CSP-restricted → no CSP edit.

## Phase 1 — Extension package (extension/)
- [x] `extension/icons/icon-{16,48,128}.png` from assets/logo-512.png (ImageMagick `convert`)
- [x] `extension/manifest.json` — MV3, minimal host_permissions (reddit + redd.it + imgur), no broad perms
- [x] `extension/background.js` — service worker: strict host allowlist (SSRF guard), size caps,
      fetchJson (text) + fetchBytes (base64), sender-origin check
- [x] `extension/bridge.js` — content script: window.postMessage ↔ chrome.runtime, ping/pong + ready
- [x] `extension/README.md` — load-unpacked + store steps, security model
- [x] add `extension` to scripts/syntax-check.mjs dirs
- [x] build + commit

## Phase 2 — Page-side transport + proxy routing
- [ ] `src/bridge-client.js` — detectExtension(), extensionFetchJson(), extensionFetchBytes(),
      b64ToBytes() — all window access guarded so it imports cleanly under node
- [ ] `src/proxy.js` — add `ProxyMode.EXTENSION`; resolveProxy/canZip/buildProxiedUrl; route
      fetchJson/fetchBytes via the bridge; extract `parseListingText()` helper (reused by all modes)
- [ ] `test/proxy.test.js` — extension-mode tests (mock bridge-client): resolve/zip + fetchJson/fetchBytes
- [ ] `test/bridge-client.test.js` — b64ToBytes roundtrip + ping/fetch correlation via a fake window
- [ ] build + commit

## Phase 3 — UI wiring (detect + new mode)
- [ ] `index.html` — extension radio (hidden until detected) + install hint (shown when absent);
      cache-bust v5 → v6
- [ ] `src/app.js` — detect on init; show/hide radio + "detected" badge; allow `extension` in saved
      settings; fall back to direct if mode=extension but not installed
- [ ] build + commit

## Phase 4 — Docs + cleanup
- [ ] README.md — document the bridge extension (what it unlocks, how to install)
- [ ] remove diagnostic test-cors.html; stop dev server
- [ ] final build + commit
