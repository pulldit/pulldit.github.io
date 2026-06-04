// Activity history: a capped, localStorage-backed log of fetches, downloads and discards.
// Pure helpers (capList, describeEntry) are unit-tested; storage/Date access lives in app.js.

export const HISTORY_KEY = 'rd.history.v1';
export const MAX_HISTORY = 100; // default display/overwrite cap
export const MAX_HISTORY_HARD = 5000; // absolute storage ceiling in "keep everything" mode

/**
 * Keep at most `max` newest entries (entries are appended, so trim from the front).
 * @param {Array<object>} list
 * @param {number} [max]
 */
export function capList(list, max = MAX_HISTORY) {
  const arr = Array.isArray(list) ? list : [];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/** Friendly label for a proxy/download mode stored on a fetch entry. */
const MODE_LABELS = Object.freeze({
  direct: 'Direct', worker: 'Worker', public: 'Public proxy', extension: 'Extension',
});

/** Friendly window label for a Reddit `time` parameter. */
function timeLabel(t) {
  return t === 'all' ? 'all time' : String(t);
}

/** Join the present, non-empty parts of a secondary detail line. */
function joinParts(parts) {
  return parts.filter((p) => p != null && p !== '').join(' · ');
}

/**
 * Render an entry into a display icon + primary text + an optional secondary detail line
 * (pure; no time formatting). `text` is kept byte-stable for every entry shape the unit
 * tests assert; richer context is surfaced through `detail`.
 * @param {object} e
 * @returns {{ icon: string, text: string, detail: string, kind: string }}
 */
export function describeEntry(e) {
  const type = e && e.type;
  if (type === 'fetch') {
    const ok = e.status === 'success';
    const head = ok ? `${e.found} item${e.found === 1 ? '' : 's'}` : String(e.status || 'failed');
    const detail = joinParts([
      e.sort, e.time ? timeLabel(e.time) : '', e.mode ? MODE_LABELS[e.mode] || e.mode : '',
      Number(e.pages) > 1 ? `${e.pages} pages` : '',
    ]);
    return { icon: ok ? '✓' : '✕', text: `Fetched ${e.label} — ${head}`, detail, kind: ok ? 'good' : 'bad' };
  }
  if (type === 'download') {
    const detail = joinParts([e.filename, e.size]);
    return { icon: '⬇', text: `Downloaded ${e.label}`, detail, kind: 'good' };
  }
  if (type === 'zip') {
    const fail = e.failed ? ` (${e.failed} failed)` : '';
    const size = e.size ? ` · ${e.size}` : '';
    const detail = joinParts([
      Number(e.zips) > 1 ? `${e.zips} ZIPs` : '',
      Number.isFinite(e.skipped) && e.skipped > 0 ? `${e.skipped} skipped` : '',
      e.elapsed, e.speed,
    ]);
    return { icon: '🗜', text: `ZIP: ${e.added} file${e.added === 1 ? '' : 's'}${fail}${size}`, detail, kind: e.failed ? 'warn' : 'good' };
  }
  if (type === 'discard') {
    return { icon: '🗑', text: `Discarded ${e.label}`, detail: '', kind: 'dim' };
  }
  if (type === 'restore') {
    return { icon: '↺', text: `Restored ${e.label}`, detail: '', kind: 'dim' };
  }
  return { icon: '•', text: (e && e.label) || 'event', detail: '', kind: 'dim' };
}
