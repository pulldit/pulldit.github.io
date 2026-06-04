# Pulldit Bridge (browser extension)

An **optional** MV3 extension that supercharges [pulldit.github.io](https://pulldit.github.io/).
The website works fine without it (Direct / Public proxy / your own Worker). With the extension
installed, the page gains a new **“Pulldit Extension”** mode that is the most reliable of all.

## Why it exists

A static web page is bound by two browser limits that a desktop tool (like RipMe) is not:

1. **CORS** — the browser refuses to let the page read a cross-origin response unless the server
   sends `Access-Control-Allow-Origin`. Reddit’s media host `i.redd.it` deliberately withholds that
   header from third-party origins (`Vary: Origin`, no ACAO) → the page **cannot read media bytes**,
   so bulk ZIP needs a relay.
2. **Reddit’s datacenter-IP block** — Reddit returns `403 Blocked` to datacenter IPs, which is where
   every public CORS proxy and even a Cloudflare Worker live. Only residential IPs are spared.

A browser extension sidesteps **both**: its background service worker is exempt from CORS (via
`host_permissions`) and runs from **your own residential IP**. So it can fetch the listing JSON
(no 403) *and* read `i.redd.it` bytes (no CORS) — exactly what a static page can’t.

## How it works (the bridge)

```
 pulldit.github.io (the page, UI unchanged)
      │  window.postMessage({ fetch: "https://i.redd.it/..." })
      ▼
 bridge.js (content script, injected only into the Pulldit page)
      │  chrome.runtime.sendMessage
      ▼
 background.js (service worker) ──fetch──► Reddit / i.redd.it / imgur   (no CORS, your IP)
      │  bytes (base64) back
      ▲
 ◄────┘  → the page builds the ZIP
```

The page auto-detects the extension and only then offers “Pulldit Extension” mode.

## Security

- **Not an open proxy.** The background worker only fetches from an explicit allowlist:
  `*.reddit.com` (listing JSON only) and `i.redd.it / v.redd.it / preview.redd.it /
  external-preview.redd.it / *.redditmedia.com / imgur.com` (media bytes only). IP-literal,
  loopback and private targets are rejected.
- **Locked to the Pulldit page.** Requests are only served when the sender origin is
  `https://pulldit.github.io` (or `localhost:8080` for local dev).
- **Minimal permissions.** Only `host_permissions` for the hosts above — no tabs, no storage, no
  `<all_urls>`. Hard size caps apply (16 MB listing, 200 MB per file).
- **Your own session.** Requests are sent with your Reddit cookies (`credentials: 'include'`) so
  Reddit treats them exactly like your own browser tab (it blocks anonymous `.json` for many IPs).
  Those cookies only ever go to Reddit/its CDNs (first party) — never to Pulldit or anyone else.

## Install (load unpacked)

### Chrome / Edge / Brave
1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open <https://pulldit.github.io/> → the proxy panel now shows **“Pulldit Extension”**.

### Firefox
1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `extension/manifest.json`.
   (Firefox unloads temporary add-ons on restart; for permanence, sign it via AMO.)

## Publishing to the stores

The folder is store-ready. Zip its **contents** (not the parent folder) and upload to the
Chrome Web Store / Firefox Add-ons. Update `version` in `manifest.json` per release.

```bash
cd extension && zip -r ../pulldit-bridge.zip . -x '*.DS_Store'
```
