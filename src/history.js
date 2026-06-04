// Activity history: a capped, localStorage-backed log of fetches, downloads and discards.
// Pure helpers (capList, describeEntry) are unit-tested; storage/Date access lives in app.js.

export const HISTORY_KEY = 'rd.history.v1';
export const MAX_HISTORY = 100;

/**
 * Keep at most `max` newest entries (entries are appended, so trim from the front).
 * @param {Array<object>} list
 * @param {number} [max]
 */
export function capList(list, max = MAX_HISTORY) {
  const arr = Array.isArray(list) ? list : [];
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

/**
 * Render an entry into a display icon + text (pure; no time formatting).
 * @param {object} e
 * @returns {{ icon: string, text: string, kind: string }}
 */
export function describeEntry(e) {
  const type = e && e.type;
  if (type === 'fetch') {
    const ok = e.status === 'success';
    const detail = ok ? `${e.found} item${e.found === 1 ? '' : 's'}` : String(e.status || 'failed');
    return { icon: ok ? '✓' : '✕', text: `Fetched ${e.label} — ${detail}`, kind: ok ? 'good' : 'bad' };
  }
  if (type === 'download') {
    return { icon: '⬇', text: `Downloaded ${e.label}`, kind: 'good' };
  }
  if (type === 'zip') {
    const fail = e.failed ? ` (${e.failed} failed)` : '';
    const size = e.size ? ` · ${e.size}` : '';
    return { icon: '🗜', text: `ZIP: ${e.added} file${e.added === 1 ? '' : 's'}${fail}${size}`, kind: e.failed ? 'warn' : 'good' };
  }
  if (type === 'discard') {
    return { icon: '🗑', text: `Discarded ${e.label}`, kind: 'dim' };
  }
  if (type === 'restore') {
    return { icon: '↺', text: `Restored ${e.label}`, kind: 'dim' };
  }
  return { icon: '•', text: (e && e.label) || 'event', kind: 'dim' };
}
