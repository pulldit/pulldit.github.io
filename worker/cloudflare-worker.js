/**
 * Pulldit — secure media proxy (Cloudflare Worker).
 *
 * Purpose: let the static site read media BYTES (which Reddit's CDNs serve without CORS)
 * so it can build ZIPs — WITHOUT trusting a random third-party proxy. You own this.
 *
 * Security properties:
 *   - Only GET (+ CORS preflight). Everything else -> 405.
 *   - Only proxies an explicit allowlist of Reddit / Reddit-media / imgur hosts.
 *     It is NOT an open proxy: it cannot be abused to reach arbitrary origins.
 *   - Rejects IP-literal / private / loopback targets (defense in depth).
 *   - Enforces an upstream timeout and a hard streamed size cap.
 *   - Strips cookies; never forwards credentials.
 *
 * Deploy: see worker/README.md. Self-contained — no imports, copy-paste ready.
 */

const MEDIA_HOST_ALLOWLIST = [
  'i.redd.it', 'v.redd.it', 'preview.redd.it', 'external-preview.redd.it',
  'redditmedia.com', 'imgur.com',
];
const REDDIT_HOSTS = [
  'reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com',
];
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB
const TIMEOUT_MS = 25_000;

/** Suffix/exact host match (case-insensitive). */
function hostMatches(host, list) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((e) => h === e || h.endsWith('.' + e));
}

/** Block loopback names and private/reserved IPv4 + obvious IPv6 internals. */
function isUnsafeHost(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h.includes(':')) return true; // refuse raw IPv6 literals outright
  return false;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Range, Content-Type',
  'access-control-max-age': '86400',
};

function deny(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

/** TransformStream that errors out if more than maxBytes flow through it. */
function cappedStream(maxBytes) {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error('upstream exceeds size limit'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export default {
  /**
   * @param {Request} request
   */
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return deny(405, 'method not allowed');

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return deny(400, 'missing url parameter');

    let dest;
    try {
      dest = new URL(target);
    } catch {
      return deny(400, 'invalid url');
    }
    if (dest.protocol !== 'https:' && dest.protocol !== 'http:') return deny(400, 'unsupported scheme');
    if (isUnsafeHost(dest.hostname)) return deny(403, 'host not allowed');
    if (!hostMatches(dest.hostname, MEDIA_HOST_ALLOWLIST) && !hostMatches(dest.hostname, REDDIT_HOSTS)) {
      return deny(403, 'host not on allowlist');
    }
    dest.protocol = 'https:'; // upgrade

    let upstream;
    try {
      upstream = await fetch(dest.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          // A descriptive UA improves Reddit's tolerance; forward Range for video seeking.
          'user-agent': 'Pulldit/1.0 (+https://pulldit.github.io)',
          accept: request.headers.get('accept') || '*/*',
          ...(request.headers.get('range') ? { range: request.headers.get('range') } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return deny(502, 'upstream fetch failed: ' + (err && err.message ? err.message : 'error'));
    }

    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return deny(413, 'file too large');

    const headers = new Headers(CORS);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('cache-control', 'public, max-age=3600');
    headers.set('x-content-type-options', 'nosniff');

    const body = upstream.body ? upstream.body.pipeThrough(cappedStream(MAX_BYTES)) : null;
    return new Response(body, { status: upstream.status, headers });
  },
};
