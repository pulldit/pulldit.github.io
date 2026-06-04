// Page-side client for the optional Pulldit Bridge extension.
//
// Talks to the extension's content script (extension/bridge.js) over window.postMessage and
// returns Promises. All `window` access is INSIDE functions so this module imports cleanly in
// Node (unit tests) — calling a function without a window simply rejects/returns "unavailable".
//
// See extension/README.md for the full protocol and security model.

const TAG = '__pulldit';

let seq = 0;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pending = new Map();
let listening = false;
let extReady = false;

function hasWindow() {
  return typeof window !== 'undefined' && window && typeof window.postMessage === 'function';
}

function pageOrigin() {
  return (hasWindow() && window.location && window.location.origin) || '/';
}

function onMessage(event) {
  // Same-window messages only; addressed to us by the bridge.
  if (event && event.source !== undefined && event.source !== window) return;
  const d = event && event.data;
  if (!d || d[TAG] !== 'ext') return;
  if (d.op === 'ready') {
    extReady = true;
    return;
  }
  const entry = pending.get(d.id);
  if (!entry) return;
  pending.delete(d.id);
  if (d.ok === false) {
    entry.reject(new Error(d.error || (d.status ? `HTTP ${d.status}` : 'extension error')));
  } else {
    entry.resolve(d);
  }
}

function ensureListener() {
  if (listening || !hasWindow() || typeof window.addEventListener !== 'function') return;
  window.addEventListener('message', onMessage);
  listening = true;
}

function send(op, extra, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!hasWindow()) {
      reject(new Error('extension bridge unavailable (no window)'));
      return;
    }
    ensureListener();
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('extension request timed out'));
      }
    }, timeoutMs || 30_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    window.postMessage({ [TAG]: 'page', id, op, ...extra }, pageOrigin());
  });
}

/**
 * Detect whether the Pulldit Bridge extension is installed.
 * Resolves quickly (never rejects). `{ available, version? }`.
 * @param {number} [timeoutMs]
 */
export function detectExtension(timeoutMs = 1500) {
  if (!hasWindow()) return Promise.resolve({ available: false });
  ensureListener();
  if (extReady) return Promise.resolve({ available: true });
  return send('ping', {}, timeoutMs)
    .then((d) => ({ available: true, version: d && d.version }))
    .catch(() => ({ available: false }));
}

/**
 * Fetch a Reddit listing JSON via the extension (raw text + transport metadata).
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ body: string, bytes: number, httpOk: boolean, status: number }>}
 */
export async function extensionFetchJson(url, opts = {}) {
  const d = await send('fetchJson', { url }, opts.timeoutMs);
  return { body: d.body || '', bytes: Number(d.bytes) || 0, httpOk: d.httpOk !== false, status: Number(d.status) || 0 };
}

/**
 * Fetch media bytes via the extension. Decodes the base64 transport back into a Uint8Array.
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ bytes: Uint8Array, contentType: string, httpOk: boolean, status: number }>}
 */
export async function extensionFetchBytes(url, opts = {}) {
  const d = await send('fetchBytes', { url, maxBytes: opts.maxBytes }, opts.timeoutMs);
  return {
    bytes: b64ToBytes(d.b64),
    contentType: d.contentType || 'application/octet-stream',
    httpOk: d.httpOk !== false,
    status: Number(d.status) || 0,
  };
}

/** Decode a base64 string into a Uint8Array. Pure + testable. */
export function b64ToBytes(b64) {
  const bin = atob(b64 || '');
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
