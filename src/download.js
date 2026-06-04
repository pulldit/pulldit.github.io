// Download orchestration. Browser-only side effects (DOM, JSZip, FileSaver) live inside
// the functions; the module imports cleanly in Node so the pure helpers stay testable.

import { LIMITS } from './config.js';
import { sanitizeFilename, extFromUrl } from './url-guard.js';
import { fetchBytes, resolveProxy, canZip, ProxyMode } from './proxy.js';
import { validateBytes } from './media-validate.js';

/**
 * Run the configured content checks over freshly-fetched bytes, throwing a precise
 * `invalid media: …` error when they fail. A null/absent `validate` skips entirely.
 * @param {Uint8Array} bytes
 * @param {{ magic?: boolean, decode?: boolean } | null | undefined} validate
 */
async function assertValidMedia(bytes, validate) {
  if (!validate) return;
  const v = await validateBytes(bytes, validate);
  if (!v.ok) throw new Error(`invalid media: ${v.reason}`);
}

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

/** High-resolution clock when available; 0 otherwise (keeps stats degradable). */
const now = () =>
  globalThis.performance && typeof globalThis.performance.now === 'function'
    ? globalThis.performance.now()
    : 0;

/** Resolve a numeric override, falling back to a default when not a finite number. */
const orDefault = (v, dflt) => (Number.isFinite(v) ? v : dflt);

/** Abortable delay (rate limiter between downloads). Rejects with 'cancelled' if aborted. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (!ms || ms <= 0) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    }
  });
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
export async function downloadSingle(item, settings, opts = {}) {
  const r = resolveProxy(settings);
  if (r.ok && r.mode !== ProxyMode.DIRECT) {
    const filename = buildItemFilename(item, 0, false);
    const { bytes, contentType } = await fetchBytes(item.url, settings, {
      maxBytes: opts.maxBytes,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    await assertValidMedia(bytes, opts.validate);
    getSaveAs()(new Blob([bytes], { type: contentType }), filename);
    return { ok: true, filename, bytes: bytes.byteLength };
  }
  openInNewTab(item.url);
  return { ok: true, opened: true };
}

/**
 * Build ZIP(s) of many items, tolerant of individual failures. Requires a proxy mode.
 *
 * ALL items are processed: when there are more than `maxZipFiles`, they are split into
 * sequential batches and EACH batch is generated and saved as its own ZIP automatically
 * (named `<base>-<n>.zip`), with a short gap between saves so the browser accepts multiple
 * downloads. The user clicks once and every selected file ends up downloaded.
 *
 * @param {Array<object>} items
 * @param {object} settings
 * @param {{ onProgress?: (e: object) => void, signal?: AbortSignal, zipName?: string,
 *   limits?: object, validate?: object|null }} [opts]
 * @returns {Promise<{ added: number, failed: Array<{ item: object, error: string }>,
 *   files: Array<object>, totalBytes: number, elapsedMs: number, zips: number }>}
 */
export async function downloadZip(items, settings, opts = {}) {
  if (!canZip(settings)) throw new Error('ZIP requires a proxy mode (direct mode cannot read bytes)');
  const { onProgress, signal, zipName = 'reddit-media', limits = {}, validate = null, pause = null } = opts;
  const maxZipFiles = orDefault(limits.maxZipFiles, LIMITS.maxZipFiles);
  const delayMs = orDefault(limits.delayMs, 0);
  const all = Array.isArray(items) ? items : [];
  const total = all.length;
  const batches = Math.max(1, Math.ceil(total / maxZipFiles));
  const base = String(zipName).replace(/\.zip$/i, '') || 'reddit-media';
  const saveAs = getSaveAs();

  /** @type {Array<{ id: string, title: string, name?: string, ok: boolean, bytes: number, ms: number, error?: string }>} */
  const files = [];
  let okCount = 0;
  let totalBytes = 0;
  let processed = 0;
  let producedZips = 0;
  const usedNames = new Set();
  const startedAt = now();

  for (let b = 0; b < batches; b++) {
    if (signal?.aborted) throw new Error('cancelled');
    const slice = all.slice(b * maxZipFiles, (b + 1) * maxZipFiles);
    const zip = new (getJSZip())();
    let batchOk = 0;

    for (let j = 0; j < slice.length; j++) {
      if (signal?.aborted) throw new Error('cancelled');
      if (pause) await pause(); // block here while the user has paused (rejects if aborted)
      if (signal?.aborted) throw new Error('cancelled');
      const item = slice[j];
      if (delayMs > 0 && processed > 0) await sleep(delayMs, signal); // rate limiter between downloads
      onProgress?.({ phase: 'fetch', index: processed, total, batch: b + 1, batches, item, okCount, totalBytes });
      const t0 = now();
      try {
        const { bytes } = await fetchBytes(item.url, settings, {
          signal,
          maxBytes: limits.maxBytes,
          timeoutMs: limits.timeoutMs,
        });
        await assertValidMedia(bytes, validate); // reject HTML/error pages & mislabeled payloads
        const ms = now() - t0;
        let name = buildItemFilename(item, processed); // global index keeps the sequence ordered across ZIPs
        while (usedNames.has(name)) name = `dup_${usedNames.size}_${name}`;
        usedNames.add(name);
        zip.file(name, bytes);
        okCount += 1;
        batchOk += 1;
        totalBytes += bytes.byteLength;
        files.push({ id: item.id, title: item.title, name, ok: true, bytes: bytes.byteLength, ms });
        onProgress?.({ phase: 'fetched', index: processed, total, batch: b + 1, batches, ok: true, bytes: bytes.byteLength, ms, okCount, totalBytes });
      } catch (err) {
        const ms = now() - t0;
        const error = err?.message ? String(err.message) : String(err);
        files.push({ id: item.id, title: item.title, ok: false, bytes: 0, ms, error });
        onProgress?.({ phase: 'fetched', index: processed, total, batch: b + 1, batches, ok: false, error, okCount, totalBytes });
      }
      processed += 1;
    }

    if (batchOk === 0) continue; // every file in this batch failed — don't save an empty ZIP
    onProgress?.({ phase: 'zip', batch: b + 1, batches });
    // STORE (no recompression): Reddit media is already compressed; this is fast and lossless.
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      (meta) => onProgress?.({ phase: 'compress', percent: meta.percent, batch: b + 1, batches }),
    );
    producedZips += 1;
    const name = batches === 1 ? `${base}.zip` : `${base}-${producedZips}.zip`;
    saveAs(blob, name);
    if (b < batches - 1) await sleep(700, signal); // gap so the browser allows the next download
  }

  if (okCount === 0) {
    throw new Error(`no files could be downloaded (${files.length} failed)`);
  }
  const elapsedMs = now() - startedAt;
  const failed = files
    .filter((f) => !f.ok)
    .map((f) => ({ item: { id: f.id, title: f.title }, error: f.error }));
  return { added: okCount, failed, files, totalBytes, elapsedMs, zips: producedZips };
}
