// Download orchestration. Browser-only side effects (DOM, JSZip, FileSaver) live inside
// the functions; the module imports cleanly in Node so the pure helpers stay testable.

import { LIMITS } from './config.js';
import { sanitizeFilename, extFromUrl } from './url-guard.js';
import { fetchBytes, resolveProxy, canZip, ProxyMode } from './proxy.js';

/**
 * Build a safe, ordered, collision-resistant filename for a media item.
 * @param {object} item   normalized MediaItem
 * @param {number} [index]
 * @param {boolean} [withSeq] prefix with a zero-padded sequence number (for ZIP ordering)
 */
export function buildItemFilename(item, index = 0, withSeq = true) {
  const ext = item.ext || extFromUrl(item.url, item.type === 'video' ? 'mp4' : 'jpg');
  const titleBase = sanitizeFilename(item.title || item.postId || 'reddit-media');
  const id = String(item.id || item.postId || index + 1).replace(/[^A-Za-z0-9_-]/g, '');
  let stem = id && !titleBase.endsWith(id) ? `${titleBase}_${id}` : titleBase;
  if (stem.length > 140) stem = stem.slice(0, 140).replace(/_+$/, '');
  const seq = String(index + 1).padStart(3, '0');
  return withSeq ? `${seq}_${stem}.${ext}` : `${stem}.${ext}`;
}

/** Resolve the JSZip constructor (loaded as a classic <script>), or throw a clear error. */
function getJSZip() {
  const Z = globalThis.JSZip;
  if (typeof Z !== 'function') throw new Error('JSZip is not loaded');
  return Z;
}
/** Resolve FileSaver's saveAs, or throw a clear error. */
function getSaveAs() {
  const s = globalThis.saveAs;
  if (typeof s !== 'function') throw new Error('FileSaver is not loaded');
  return s;
}

/**
 * Open a URL in a new, isolated tab (used in direct mode where bytes can't be read).
 * @param {string} url
 */
function openInNewTab(url) {
  const a = globalThis.document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  globalThis.document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Download a single media item. With a proxy: fetch bytes and save with a proper name.
 * In direct mode: open the file in a new tab (browsers ignore `download` cross-origin).
 * @param {object} item
 * @param {object} settings
 * @returns {Promise<{ ok: true, filename?: string, opened?: boolean }>}
 */
export async function downloadSingle(item, settings) {
  const r = resolveProxy(settings);
  if (r.ok && r.mode !== ProxyMode.DIRECT) {
    const filename = buildItemFilename(item, 0, false);
    const { bytes, contentType } = await fetchBytes(item.url, settings);
    getSaveAs()(new Blob([bytes], { type: contentType }), filename);
    return { ok: true, filename };
  }
  openInNewTab(item.url);
  return { ok: true, opened: true };
}

/**
 * Build a ZIP of many items, tolerant of individual failures. Requires a proxy mode.
 * @param {Array<object>} items
 * @param {object} settings
 * @param {{ onProgress?: (e: object) => void, signal?: AbortSignal, zipName?: string }} [opts]
 * @returns {Promise<{ added: number, failed: Array<{ item: object, error: string }> }>}
 */
export async function downloadZip(items, settings, opts = {}) {
  if (!canZip(settings)) throw new Error('ZIP requires a proxy mode (direct mode cannot read bytes)');
  const { onProgress, signal, zipName = 'reddit-media.zip' } = opts;
  const subset = items.slice(0, LIMITS.maxZipFiles);
  const zip = new (getJSZip())();
  const saveAs = getSaveAs();
  const result = { added: 0, failed: [] };

  const usedNames = new Set();
  for (let i = 0; i < subset.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    const item = subset[i];
    onProgress?.({ phase: 'fetch', index: i, total: subset.length, item });
    try {
      const { bytes } = await fetchBytes(item.url, settings, { signal });
      let name = buildItemFilename(item, i);
      while (usedNames.has(name)) name = `dup_${Math.floor(usedNames.size)}_${name}`;
      usedNames.add(name);
      zip.file(name, bytes);
      result.added++;
    } catch (err) {
      result.failed.push({ item, error: err?.message ? String(err.message) : String(err) });
    }
  }

  if (result.added === 0) {
    throw new Error(`no files could be downloaded (${result.failed.length} failed)`);
  }
  onProgress?.({ phase: 'zip', total: subset.length });
  // STORE (no recompression): Reddit media is already compressed; this is fast and lossless.
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' },
    (meta) => onProgress?.({ phase: 'compress', percent: meta.percent }),
  );
  saveAs(blob, zipName);
  return result;
}
