// Reddit input parsing + listing normalization. Pure, dependency-light, fully tested.
//
//  parseInput()      user text/URL  -> a typed source descriptor
//  buildJsonUrl()    descriptor     -> the canonical https .json URL to fetch
//  normalizeListing()Reddit JSON    -> a flat, validated MediaItem[]

import { REDDIT_API_ORIGIN, REDDIT_HOSTS, LIMITS } from './config.js';
import { hostMatchesAllowlist, parseHttpUrl, validateMediaUrl, extFromUrl } from './url-guard.js';
import { summarizeItems } from './stats.js';

export const SORTS = Object.freeze(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
const SUBREDDIT_RE = /^[A-Za-z0-9_]{1,21}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{1,20}$/;
const POSTID_RE = /^[a-z0-9]{1,10}$/i;

/**
 * Decode the handful of HTML entities Reddit may still emit in media URLs.
 * @param {string} s
 */
export function unescapeHtml(s) {
  if (typeof s !== 'string') return '';
  // Decode `&amp;` LAST so we never re-process an ampersand we just produced
  // (e.g. "&amp;lt;" must become "&lt;", not "<"). Avoids double-unescaping.
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:0*39|x0*27);/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Turn arbitrary user input (full URL or shorthand) into a typed source descriptor.
 * @param {string} raw
 * @returns {{ ok: true, kind: 'post'|'subreddit'|'user', subreddit?: string,
 *            username?: string, postId?: string, sort?: string, time?: string,
 *            label: string } | { ok: false, reason: string }}
 */
export function parseInput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'no input' };
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'no input' };

  let pathname;
  let search = '';
  const url = parseHttpUrl(s);
  if (url) {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'redd.it') {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      if (POSTID_RE.test(id)) return { ok: true, kind: 'post', postId: id, label: `post ${id}` };
      return { ok: false, reason: 'invalid short link' };
    }
    if (!hostMatchesAllowlist(host, REDDIT_HOSTS)) {
      return { ok: false, reason: 'not a reddit.com URL' };
    }
    pathname = url.pathname;
    search = url.search;
  } else {
    // Shorthand like "r/aww", "aww", "u/spez", "user/spez".
    pathname = '/' + s.replace(/^\/+/, '');
  }

  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] === 'u') seg[0] = 'user';
  const params = new URLSearchParams(search);
  const time = params.get('t') || undefined;

  // /media?url=<encoded media URL> — Reddit's share wrapper for a single hosted file.
  if (seg[0] === 'media') {
    const inner = params.get('url');
    const v = inner ? validateMediaUrl(inner) : { ok: false };
    if (v.ok) return { ok: true, kind: 'media', url: v.url, label: 'media file' };
    return { ok: false, reason: 'unsupported media link' };
  }

  // /comments/{id} or /r/{sub}/comments/{id}/...
  const ci = seg.indexOf('comments');
  if (ci !== -1 && POSTID_RE.test(seg[ci + 1] || '')) {
    return { ok: true, kind: 'post', postId: seg[ci + 1], label: `post ${seg[ci + 1]}` };
  }

  // /user/{name}[/submitted]
  if (seg[0] === 'user') {
    const name = seg[1];
    if (name && USERNAME_RE.test(name)) {
      return { ok: true, kind: 'user', username: name, label: `u/${name}` };
    }
    return { ok: false, reason: 'invalid username' };
  }

  // /r/{sub}[/{sort}]  or bare "{sub}"
  let sub;
  let sort;
  if (seg[0] === 'r') {
    sub = seg[1];
    if (seg[2] && SORTS.includes(seg[2].toLowerCase())) sort = seg[2].toLowerCase();
  } else if (seg.length === 1) {
    sub = seg[0];
  }
  if (sub && SUBREDDIT_RE.test(sub)) {
    return { ok: true, kind: 'subreddit', subreddit: sub, sort, time, label: `r/${sub}` };
  }

  return { ok: false, reason: 'could not recognize a post, subreddit or user' };
}

/**
 * Build a single normalized MediaItem from a direct media URL (e.g. a `reddit.com/media?url=…`
 * share link or a pasted i.redd.it/imgur URL). Returns null if the URL is not allowlisted media.
 * @param {string} rawUrl
 */
export function singleMediaItem(rawUrl) {
  const v = validateMediaUrl(rawUrl);
  if (!v.ok) return null;
  const isVideo = /\.(mp4|webm|mov)$/i.test(v.url);
  const isGif = /\.gif$/i.test(v.url);
  const name = (parseHttpUrl(v.url)?.pathname || '').split('/').filter(Boolean).pop() || 'media';
  return {
    id: `media-${name}`,
    type: isVideo ? 'video' : isGif ? 'gif' : 'image',
    url: v.url,
    host: v.host,
    ext: extFromUrl(v.url, isVideo ? 'mp4' : 'jpg'),
    title: name,
    nsfw: false,
    thumbnail: isVideo ? undefined : v.url,
  };
}

/**
 * Build the canonical https `.json` URL for a descriptor.
 * @param {ReturnType<typeof parseInput> & { ok: true }} desc
 * @param {{ limit?: number, after?: string|null, sort?: string, time?: string }} [opts]
 */
export function buildJsonUrl(desc, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? LIMITS.defaultListingLimit), 100);
  let path;
  if (desc.kind === 'post') {
    path = `/comments/${desc.postId}`;
  } else if (desc.kind === 'user') {
    path = `/user/${desc.username}/submitted`;
  } else {
    const sort = (opts.sort || desc.sort || 'hot').toLowerCase();
    path = `/r/${desc.subreddit}/${SORTS.includes(sort) ? sort : 'hot'}`;
  }
  const u = new URL(REDDIT_API_ORIGIN + path + '.json');
  u.searchParams.set('raw_json', '1');
  if (desc.kind !== 'post') u.searchParams.set('limit', String(limit));
  if (opts.after) u.searchParams.set('after', opts.after);
  const time = opts.time || desc.time;
  if (time) u.searchParams.set('t', time);
  return u.toString();
}

/** @param {string} raw */
function isDirectImage(raw) {
  return /\.(jpe?g|png|gif|webp|bmp)$/i.test((parseHttpUrl(raw)?.pathname) || '');
}
/** @param {string} raw */
function isDirectVideo(raw) {
  return /\.(mp4|webm|mov|gifv)$/i.test((parseHttpUrl(raw)?.pathname) || '');
}

/**
 * From a Reddit "resolutions" array (ascending by width), pick the SMALLEST preview whose width
 * is >= target — a cheap thumbnail, never the multi-megapixel source. Falls back to the largest
 * available preview if all are smaller. Pure + tested.
 * @param {Array<{u?: string, url?: string, x?: number, width?: number}>} resolutions
 * @param {number} [target] desired min width in px (default 320 — crisp on a ~180px card)
 * @returns {string|undefined}
 */
export function pickPreviewUrl(resolutions, target = 320) {
  if (!Array.isArray(resolutions) || resolutions.length === 0) return undefined;
  let chosen;
  for (const r of resolutions) {
    const u = r && (r.u || r.url);
    if (!u) continue;
    chosen = r;
    const w = Number(r.x ?? r.width);
    if (Number.isFinite(w) && w >= target) break; // first one big enough — stop
  }
  const url = chosen && (chosen.u || chosen.url);
  return url ? unescapeHtml(url) : undefined;
}

/**
 * Pick a small preview URL for on-screen display (CORS not required for <img>). Prefers a small
 * downscaled preview so a grid of 100s of cards stays light; the SOURCE is only a last resort.
 * @param {any} d
 * @returns {string|undefined}
 */
function pickThumbnail(d) {
  const small = pickPreviewUrl(d?.preview?.images?.[0]?.resolutions);
  if (small) return small;
  const src = d?.preview?.images?.[0]?.source?.url;
  if (src) return unescapeHtml(src);
  if (typeof d?.thumbnail === 'string' && /^https?:/.test(d.thumbnail)) return d.thumbnail;
  return undefined;
}

/**
 * Extract zero or more MediaItems from a single t3 (link) post `data` object.
 * @param {any} d
 * @returns {Array<object>}
 */
function extractFromPost(d) {
  if (!d || typeof d !== 'object') return [];
  const base = {
    postId: d.id,
    title: typeof d.title === 'string' ? d.title : '',
    author: d.author,
    subreddit: d.subreddit,
    permalink: d.permalink ? REDDIT_API_ORIGIN + d.permalink : undefined,
    nsfw: Boolean(d.over_18),
    thumbnail: pickThumbnail(d),
  };
  const out = [];

  // 1) Native gallery: ordered items -> i.redd.it/{mediaId}.{ext}
  if (d.is_gallery && d.media_metadata && d.gallery_data?.items) {
    for (const it of d.gallery_data.items) {
      const m = d.media_metadata[it.media_id];
      if (!m || m.status !== 'valid') continue;
      const ext = m.m === 'image/png' ? 'png' : m.m === 'image/gif' ? 'gif' : 'jpg';
      out.push({
        ...base,
        id: `${d.id}-${it.media_id}`,
        type: ext === 'gif' ? 'gif' : 'image',
        url: `https://i.redd.it/${it.media_id}.${ext}`,
        // Small downscaled preview for the grid — NOT m.s (the full-res source) which lags hard.
        thumbnail: pickPreviewUrl(m.p) || unescapeHtml(m.s?.u || base.thumbnail || ''),
      });
    }
    if (out.length) return finalize(out);
  }

  // 2) Reddit-hosted video (video-only mp4 fallback; audio is a separate DASH track).
  const rv = d.media?.reddit_video || d.secure_media?.reddit_video || d.preview?.reddit_video_preview;
  if (d.is_video || rv?.fallback_url) {
    const fu = rv?.fallback_url;
    if (fu) {
      out.push({
        ...base, id: d.id, type: 'video',
        url: unescapeHtml(fu).split('?')[0],
        audioHint: !rv?.is_gif, // gifs have no audio; real videos may need DASH audio
      });
      return finalize(out);
    }
  }

  // 3) Direct media link (i.redd.it image, imgur, etc.)
  const link = typeof d.url_overridden_by_dest === 'string' ? d.url_overridden_by_dest : d.url;
  if (typeof link === 'string') {
    if (isDirectVideo(link)) {
      out.push({ ...base, id: d.id, type: 'video', url: link.replace(/\.gifv$/i, '.mp4') });
      return finalize(out);
    }
    if (isDirectImage(link) || d.post_hint === 'image') {
      out.push({ ...base, id: d.id, type: isDirectImage(link) && /\.gif$/i.test(link) ? 'gif' : 'image', url: link });
      return finalize(out);
    }
  }

  // 4) Crosspost: dig into the original.
  if (Array.isArray(d.crosspost_parent_list) && d.crosspost_parent_list[0]) {
    return extractFromPost(d.crosspost_parent_list[0]);
  }

  return [];
}

/**
 * Validate each candidate's media URL against the host allowlist; drop anything unsafe.
 * @param {Array<object>} items
 */
function finalize(items) {
  const out = [];
  for (const it of items) {
    const v = validateMediaUrl(it.url);
    if (!v.ok) continue;
    out.push({ ...it, url: v.url, host: v.host, ext: extFromUrl(v.url, it.type === 'video' ? 'mp4' : 'jpg') });
  }
  return out;
}

/**
 * Combine running counters with per-item breakdowns into the final stats object.
 * @param {Array<object>} items
 * @param {{ postsScanned: number, postsWithMedia: number, dropped: number, galleries: number, capped: boolean }} base
 */
function finalizeStats(items, base) {
  const s = summarizeItems(items);
  return {
    ...base,
    found: items.length,
    byType: { image: s.image, gif: s.gif, video: s.video },
    bySource: { reddit: s.reddit, imgur: s.imgur, other: s.other },
    nsfw: s.nsfw,
  };
}

/**
 * Normalize a Reddit listing OR a comments-page array into a flat MediaItem[] plus stats.
 * @param {any} json
 * @returns {{ items: Array<object>, after: string|null, stats: object }}
 */
export function normalizeListing(json) {
  let children = [];
  let after = null;
  if (Array.isArray(json)) {
    // Comments page: [ postListing, commentsListing ]
    children = json[0]?.data?.children ?? [];
  } else if (json?.data?.children) {
    children = json.data.children;
    after = json.data.after ?? null;
  }

  const items = [];
  const base = { postsScanned: 0, postsWithMedia: 0, dropped: 0, galleries: 0, capped: false };
  for (const child of children) {
    if (child?.kind !== 't3') continue;
    base.postsScanned += 1;
    if (child.data?.is_gallery) base.galleries += 1;
    const extracted = extractFromPost(child.data);
    if (extracted.length === 0) {
      base.dropped += 1;
      continue;
    }
    base.postsWithMedia += 1;
    for (const item of extracted) {
      items.push(item);
      if (items.length >= LIMITS.maxItems) {
        base.capped = true;
        return { items, after, stats: finalizeStats(items, base) };
      }
    }
  }
  return { items, after, stats: finalizeStats(items, base) };
}

/**
 * Merge several already-normalized listing pages into one result: concatenate items in order
 * while de-duplicating by `id` (Reddit pagination can repeat a post across page boundaries),
 * sum the per-page post counters, and recompute the media breakdown over the merged set so the
 * stats reflect the real (deduped, capped) items — not a naive page sum. Pure + tested.
 * @param {Array<{ items: Array<object>, stats: object }>} pages
 * @param {number} [cap] hard ceiling on total merged items (truncation marks stats.capped)
 * @returns {{ items: Array<object>, stats: object }}
 */
export function aggregatePages(pages, cap = LIMITS.maxItems) {
  const list = Array.isArray(pages) ? pages : [];
  const seen = new Set();
  let items = [];
  const base = { postsScanned: 0, postsWithMedia: 0, dropped: 0, galleries: 0, capped: false };
  for (const page of list) {
    const st = (page && page.stats) || {};
    base.postsScanned += Number(st.postsScanned) || 0;
    base.postsWithMedia += Number(st.postsWithMedia) || 0;
    base.dropped += Number(st.dropped) || 0;
    base.galleries += Number(st.galleries) || 0;
    if (st.capped) base.capped = true;
    for (const it of (page && page.items) || []) {
      const key = it && it.id != null ? it.id : it;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }
  const limit = Number.isFinite(cap) && cap > 0 ? cap : LIMITS.maxItems;
  if (items.length > limit) {
    items = items.slice(0, limit);
    base.capped = true;
  }
  return { items, stats: finalizeStats(items, base) };
}
