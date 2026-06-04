# Your own secure ZIP proxy (Cloudflare Worker)

This optional ~5-minute setup gives RedditDownloader a media proxy **you control**, so the
bulk-ZIP feature works without trusting any third-party CORS proxy.

The worker is **not an open proxy**: it only forwards requests to an allowlist of Reddit /
Reddit-media / imgur hosts, refuses private/loopback targets, caps response size, and
enforces a timeout. See [`cloudflare-worker.js`](./cloudflare-worker.js).

## Option A — Cloudflare dashboard (no tooling)

1. Sign in at <https://dash.cloudflare.com> (the free plan is enough).
2. **Workers & Pages → Create → Create Worker**. Give it a name, e.g. `reddit-proxy`.
3. Click **Edit code**, delete the template, paste the full contents of
   [`cloudflare-worker.js`](./cloudflare-worker.js), then **Deploy**.
4. Copy the worker URL, e.g. `https://reddit-proxy.<your-subdomain>.workers.dev`.
5. In the app, open **Proxy & download mode → Your own Cloudflare Worker** and paste that URL.

## Option B — Wrangler CLI

```bash
npm install -g wrangler
wrangler login
# from this repo:
wrangler deploy worker/cloudflare-worker.js --name reddit-proxy --compatibility-date 2024-11-01
```

Wrangler prints the deployed `*.workers.dev` URL — paste it into the app as above.

## How the app calls it

The app requests `GET {your-worker-url}?url=<encoded target>`. The worker validates the
target host, fetches it, and streams the bytes back with permissive CORS so the browser can
read them and JSZip can package them.

## Content-Security-Policy note

`index.html` ships a strict CSP. The curated public proxies are already allowlisted, but a
**custom worker origin is not** (it is unique to you). Add your worker origin to the
`connect-src` directive in `index.html`:

```
connect-src 'self' https://www.reddit.com ... https://reddit-proxy.<your-subdomain>.workers.dev;
```

Without this, the browser blocks requests to your worker and ZIP will fail silently with a
CSP error in the console. (If you host your own fork, this is a one-line edit.)

## Cost & limits

The Cloudflare free plan allows 100,000 requests/day, which is far beyond personal use.
The worker adds no storage and keeps no logs of what you download.
