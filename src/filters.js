// Client-side content filtering: let the user choose which media types and sources to show.
// Pure + tested. Filtering happens after normalization, with no re-fetch.

export const DEFAULT_FILTERS = Object.freeze({
  image: true,
  gif: true,
  video: true,
  reddit: true,
  imgur: true,
});

export const FILTER_KEYS = Object.freeze(['image', 'gif', 'video', 'reddit', 'imgur']);

/**
 * Classify a media item's source from its (already validated) host.
 * @param {{ host?: string }} item
 * @returns {'reddit'|'imgur'|'other'}
 */
export function mediaSource(item) {
  const h = (item && item.host ? item.host : '').toLowerCase();
  if (h === 'imgur.com' || h.endsWith('.imgur.com')) return 'imgur';
  if (h === 'redd.it' || h.endsWith('.redd.it')) return 'reddit';
  if (h === 'redditmedia.com' || h.endsWith('.redditmedia.com')) return 'reddit';
  return 'other';
}

/**
 * Merge partial filter input with defaults (ignoring unknown keys).
 * @param {Record<string, unknown>} [partial]
 */
export function normalizeFilters(partial) {
  const out = { ...DEFAULT_FILTERS };
  if (partial && typeof partial === 'object') {
    for (const k of FILTER_KEYS) {
      if (typeof partial[k] === 'boolean') out[k] = partial[k];
    }
  }
  return out;
}

/**
 * Keep only items whose type AND source are enabled. Unknown sources (neither reddit
 * nor imgur) pass the source check — they are only constrained by type toggles.
 * @param {Array<object>} items
 * @param {Record<string, boolean>} [filters]
 */
export function applyFilters(items, filters) {
  const f = normalizeFilters(filters);
  return (items || []).filter((it) => {
    const typeOk =
      (it.type === 'image' && f.image) ||
      (it.type === 'gif' && f.gif) ||
      (it.type === 'video' && f.video);
    if (!typeOk) return false;
    const src = mediaSource(it);
    if (src === 'imgur') return f.imgur;
    if (src === 'reddit') return f.reddit;
    return true;
  });
}
