// Proxy strategy + network layer.
//
// Three modes:
//   direct  — no proxy. Reddit JSON is fetched cross-origin (Reddit sends CORS headers).
//             Media BYTES cannot be read (i.redd.it sends no CORS) -> ZIP disabled.
//   worker  — the user's own Cloudflare Worker ({base}?url=<target>). Locked to *.redd.it.
//   public  — a third-party CORS proxy from the curated PUBLIC_PROXIES list.
//
// Only `direct` mode talks to a third party never (besides Reddit itself). The other two
// route both the listing JSON and the media bytes through the chosen proxy.

import { LIMITS, PUBLIC_PROXIES } from './config.js';
import { parseHttpUrl, isUnsafeHost } from './url-guard.js';

export const ProxyMode = Object.freeze({ DIRECT: 'direct', WORKER: 'worker', PUBLIC: 'public' });

/**
 * Validate + normalize a user-supplied Cloudflare Worker base URL.
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeWorkerUrl(raw) {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  if (isUnsafeHost(u.hostname)) return null; // no localhost / private targets
  u.protocol = 'https:';
  u.hash = '';
  return u.toString();
}

/** @param {string} id */
export function getPublicProxy(id) {
  return PUBLIC_PROXIES.find((p) => p.id === id) || null;
}

/**
 * Resolve raw settings into a concrete, validated strategy.
 * @param {{ mode?: string, workerUrl?: string, publicId?: string }} settings
 * @returns {{ ok: true, mode: string, zip: boolean, base?: string, proxy?: object }
 *          | { ok: false, reason: string }}
 */
export function resolveProxy(settings) {
  const mode = settings?.mode || ProxyMode.DIRECT;
  if (mode === ProxyMode.DIRECT) return { ok: true, mode, zip: false };
  if (mode === ProxyMode.WORKER) {
    const base = normalizeWorkerUrl(settings?.workerUrl || '');
    if (!base) return { ok: false, reason: 'invalid worker URL' };
    return { ok: true, mode, zip: true, base };
  }
  if (mode === ProxyMode.PUBLIC) {
    const proxy = getPublicProxy(settings?.publicId);
    if (!proxy) return { ok: false, reason: 'unknown public proxy' };
    return { ok: true, mode, zip: true, proxy };
  }
  return { ok: false, reason: 'unknown proxy mode' };
}

/** True when the current settings allow reading bytes (and therefore zipping). */
export function canZip(settings) {
  const r = resolveProxy(settings);
  return r.ok && r.zip === true;
}

/**
 * Wrap a target URL according to the proxy strategy. Returns null on invalid settings.
 * The caller is responsible for having validated `targetUrl` (media allowlist / Reddit).
 * @param {string} targetUrl
 * @param {object} settings
 * @returns {string | null}
 */
export function buildProxiedUrl(targetUrl, settings) {
  const r = resolveProxy(settings);
  if (!r.ok) return null;
  if (r.mode === ProxyMode.DIRECT) return targetUrl;
  if (r.mode === ProxyMode.WORKER) {
    const sep = r.base.includes('?') ? '&' : '?';
    return `${r.base}${sep}url=${encodeURIComponent(targetUrl)}`;
  }
  return r.proxy.build(targetUrl);
}

/**
 * Read a Response body into a Uint8Array, aborting if it exceeds `maxBytes`.
 * @param {Response} res
 * @param {number} maxBytes
 */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`file exceeds ${maxBytes} byte limit`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error(`file exceeds ${maxBytes} byte limit`);
    return new Uint8Array(ab);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`file exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Fetch with an enforced timeout. Honors an optional external abort signal.
 * @param {string} url
 * @param {{ timeoutMs?: number, signal?: AbortSignal, accept?: string }} [opts]
 */
async function timedFetch(url, opts = {}) {
  const { timeoutMs = LIMITS.fetchTimeoutMs, signal, accept } = opts;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      headers: accept ? { accept } : undefined,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Classify a non-JSON response body (Reddit's HTML block/limit page) into a precise error.
 * Reddit serves an HTML interstitial — never JSON — when it blocks or throttles a request.
 * @param {string} text
 */
export function classifyBlockText(text) {
  const s = String(text || '').slice(0, 4000).toLowerCase();
  if (/too many requests|rate.?limit|\b429\b/.test(s)) {
    return 'Reddit rate-limited the request (HTTP 429) — try again shortly';
  }
  if (/blocked|forbidden|whoa there|access denied|not allowed|<!doctype|<html/.test(s)) {
    return 'Reddit blocked the request (it is likely blocking this proxy server)';
  }
  return 'Reddit did not return JSON (it may be blocking this request)';
}

/**
 * Single listing attempt against one fully-built (already proxied) URL.
 * @param {string} targetUrl
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ json: any, bytes: number }>}
 */
async function attemptListing(targetUrl, opts) {
  const res = await timedFetch(targetUrl, { ...opts, accept: 'application/json' });
  if (!res.ok) throw new Error(`Reddit request failed (HTTP ${res.status})`);
  const bytes = await readCapped(res, 16 * 1024 * 1024); // 16 MB cap for a listing
  const text = new TextDecoder('utf-8').decode(bytes);
  try {
    return { json: JSON.parse(text), bytes: bytes.byteLength };
  } catch {
    throw new Error(classifyBlockText(text));
  }
}

/**
 * Fetch + parse a Reddit listing JSON.
 *  - direct : hits Reddit directly (works from non-blocked, e.g. residential, IPs).
 *  - worker : routes through the user's own Cloudflare Worker.
 *  - public : tries the SELECTED proxy first, then automatically falls back to the others.
 *             Each public proxy is best-effort (Reddit may be blocking its server IP), so
 *             trying them in turn maximizes the chance one currently works.
 * @param {string} jsonUrl
 * @param {object} settings
 * @param {{ timeoutMs?: number, signal?: AbortSignal, stats?: object }} [opts]
 */
export async function fetchJson(jsonUrl, settings, opts = {}) {
  const r = resolveProxy(settings);
  if (!r.ok) throw new Error('invalid proxy configuration');

  if (r.mode === ProxyMode.PUBLIC) {
    // Selected proxy first, then the remaining ones as automatic fallback.
    const ordered = [r.proxy, ...PUBLIC_PROXIES.filter((p) => p.id !== r.proxy.id)];
    const errors = [];
    for (const proxy of ordered) {
      try {
        const { json, bytes } = await attemptListing(proxy.build(jsonUrl), opts);
        if (opts.stats && typeof opts.stats === 'object') {
          opts.stats.bytes = bytes;
          opts.stats.proxyId = proxy.id;
        }
        return json;
      } catch (err) {
        errors.push(`${proxy.label}: ${err && err.message ? err.message : err}`);
      }
    }
    throw new Error(`All public proxies failed — ${errors.join(' · ')}`);
  }

  const target = buildProxiedUrl(jsonUrl, settings);
  if (!target) throw new Error('invalid proxy configuration');
  const { json, bytes } = await attemptListing(target, opts);
  if (opts.stats && typeof opts.stats === 'object') opts.stats.bytes = bytes;
  return json;
}

/**
 * Fetch media bytes through the configured proxy. Requires a non-direct mode.
 * @param {string} mediaUrl  already validated against the media allowlist
 * @param {object} settings
 * @param {{ timeoutMs?: number, maxBytes?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ bytes: Uint8Array, contentType: string }>}
 */
export async function fetchBytes(mediaUrl, settings, opts = {}) {
  const r = resolveProxy(settings);
  if (!r.ok) throw new Error(r.reason);
  if (r.mode === ProxyMode.DIRECT) {
    throw new Error('reading media bytes requires a proxy (direct mode can only open files)');
  }
  const target = buildProxiedUrl(mediaUrl, settings);
  if (!target) throw new Error('invalid proxy configuration');
  const maxBytes = opts.maxBytes ?? LIMITS.maxFileBytes;
  const res = await timedFetch(target, opts);
  if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
  const bytes = await readCapped(res, maxBytes);
  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  return { bytes, contentType };
}
