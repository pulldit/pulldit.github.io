/**
 * Pulldit Bridge — background service worker (MV3).
 *
 * The ONLY component allowed to make cross-origin requests. It bypasses CORS (via the
 * extension's host_permissions) and uses the user's own IP, which is why it can fetch the
 * Reddit listing JSON (datacenter proxies get 403) AND read media bytes (i.redd.it withholds
 * CORS from third-party origins) — the two things a plain web page cannot do.
 *
 * Security model (defense in depth — this is privileged code):
 *   - Only messages from the Pulldit page (sender origin checked) are served.
 *   - Targets are restricted to an explicit Reddit / Reddit-media / imgur allowlist. It is NOT
 *     an open proxy: a compromised page cannot make it fetch arbitrary origins.
 *   - JSON is only fetched from Reddit hosts; media bytes only from media hosts.
 *   - IP-literal / private / loopback targets are rejected.
 *   - Hard size caps. Cookies ARE sent (credentials: 'include') so Reddit treats the request
 *     like the user's own tab — but only ever to the first-party target host, never to us.
 */

// Single source of truth: the version comes from manifest.json (bump it with `npm run bump:ext`).
const VERSION = chrome.runtime.getManifest().version;

// Hosts we will fetch the listing JSON from.
const REDDIT_HOSTS = [
  'reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com',
];
// Hosts whose media bytes we will read.
const MEDIA_HOSTS = [
  'i.redd.it', 'v.redd.it', 'preview.redd.it', 'external-preview.redd.it', 'redditmedia.com',
  'imgur.com',
];
// Page origins allowed to drive this extension.
const ALLOWED_SENDER_ORIGINS = [
  'https://pulldit.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080',
];

const MAX_JSON_BYTES = 16 * 1024 * 1024; // 16 MB listing cap
const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per media file
const TIMEOUT_MS = 25_000;

/** Suffix/exact host match (case-insensitive). */
function hostMatches(host, list) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return list.some((e) => h === e || h.endsWith('.' + e));
}

/** Block loopback names and private/reserved IPv4 + raw IPv6 (SSRF defense in depth). */
function isUnsafeHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
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
  if (h.includes(':')) return true;
  return false;
}

/** Validate a target URL for a given op. Returns a normalized https URL string or null. */
function validateTarget(rawUrl, op) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (isUnsafeHost(u.hostname)) return null;
  const list = op === 'fetchJson' ? REDDIT_HOSTS : MEDIA_HOSTS;
  if (!hostMatches(u.hostname, list)) return null;
  return u.toString();
}

/** Check that the message comes from the Pulldit page (not some other site/extension). */
function senderAllowed(sender) {
  const origin = sender && (sender.origin || (sender.url ? new URL(sender.url).origin : ''));
  return ALLOWED_SENDER_ORIGINS.includes(origin);
}

/** Encode an ArrayBuffer as base64 in chunks (avoids call-stack limits on large files). */
function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchCapped(url, accept, maxBytes) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      // Send the user's own Reddit cookies (same IP + same session as their browser tab).
      // Reddit 403s anonymous/cookieless `.json` access for many IPs; this makes the request
      // behave exactly like the user opening the `.json` URL in a tab. First-party only —
      // cookies go solely to the target host (Reddit / its CDNs), never to us.
      credentials: 'include',
      cache: 'no-store',
      headers: accept ? { accept } : undefined,
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: 'file exceeds size limit' };
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) {
    return { ok: false, status: 413, error: 'file exceeds size limit' };
  }
  return {
    ok: true,
    httpOk: res.ok,
    httpStatus: res.status,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    buf,
  };
}

async function handle(msg, sender) {
  if (!senderAllowed(sender)) return { ok: false, error: 'sender not allowed' };
  const op = msg && msg.op;
  if (op !== 'fetchJson' && op !== 'fetchBytes') return { ok: false, error: 'unknown op' };

  const target = validateTarget(msg.url, op);
  if (!target) return { ok: false, error: 'target not on allowlist' };

  try {
    if (op === 'fetchJson') {
      let r = await fetchCapped(target, 'application/json', MAX_JSON_BYTES);
      // If Reddit blocks www.reddit.com (403/429), try old.reddit.com once — it is frequently
      // more lenient for the public `.json` endpoints.
      if (r.ok && !r.httpOk && target.startsWith('https://www.reddit.com/')) {
        const alt = target.replace('https://www.reddit.com/', 'https://old.reddit.com/');
        const r2 = await fetchCapped(alt, 'application/json', MAX_JSON_BYTES);
        if (r2.ok && r2.httpOk) r = r2;
      }
      if (!r.ok) return r;
      const body = new TextDecoder('utf-8').decode(r.buf);
      return { ok: true, httpOk: r.httpOk, status: r.httpStatus, body, bytes: r.buf.byteLength };
    }
    // fetchBytes
    const maxBytes = Math.min(Number(msg.maxBytes) || MAX_FILE_BYTES, MAX_FILE_BYTES);
    const r = await fetchCapped(target, undefined, maxBytes);
    if (!r.ok) return r;
    return {
      ok: true,
      httpOk: r.httpOk,
      status: r.httpStatus,
      b64: bytesToBase64(r.buf),
      contentType: r.contentType,
      bytes: r.buf.byteLength,
    };
  } catch (err) {
    const message = err && err.name === 'AbortError' ? 'request timed out' : (err && err.message) || 'fetch failed';
    return { ok: false, error: message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.op === 'version') {
    sendResponse({ ok: true, version: VERSION });
    return false;
  }
  handle(msg, sender).then(sendResponse);
  return true; // keep the channel open for the async response
});
