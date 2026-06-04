// Central configuration: app metadata, host allowlists, limits, proxy presets.
// Everything that defines "what is allowed" lives here so the security surface is
// auditable in one place. Pure data + a frozen export — no side effects.

export const APP = Object.freeze({
  name: 'Pulldit',
  version: '1.0.0',
  tagline: 'Download Reddit images, GIFs & videos — right in your browser.',
  repo: 'https://github.com/pulldit/pulldit.github.io',
  site: 'https://pulldit.github.io/',
});

// Hosts we are willing to fetch the Reddit *listing JSON* from. The user's input is
// normalized to one of these before any network call.
export const REDDIT_HOSTS = Object.freeze([
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
]);

// The single canonical host we actually issue JSON requests to.
export const REDDIT_API_ORIGIN = 'https://www.reddit.com';

// Hosts whose *media bytes* we are willing to touch (display, proxy, zip). Matched by
// exact host or sub-domain suffix. IP literals never match — they are rejected outright.
// This is the client-side analogue of an SSRF allowlist: a malicious post cannot make
// the app pull bytes from an arbitrary origin through the user's proxy.
export const MEDIA_HOST_ALLOWLIST = Object.freeze([
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
  'external-preview.redd.it',
  'redditmedia.com', // covers *.thumbs.redditmedia.com, g.redditmedia.com
  'imgur.com', // covers i.imgur.com
]);

// File extensions we recognize as downloadable media.
export const MEDIA_EXTENSIONS = Object.freeze([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'mp4', 'webm', 'mov',
]);

export const LIMITS = Object.freeze({
  maxItems: 500, // cap on media items surfaced from one listing
  maxZipFiles: 250, // cap on files placed into a single ZIP
  maxFileBytes: 200 * 1024 * 1024, // 200 MB hard ceiling per file
  fetchTimeoutMs: 25_000, // per network request
  defaultListingLimit: 100, // Reddit `limit=` for listings
});

// Public CORS proxies the user may opt into (mode 3). These are third parties that can
// observe traffic — surfaced with an explicit warning in the UI. `build(rawUrl)` returns
// the proxied URL. Origins are listed so the page CSP can allowlist exactly these.
//
// IMPORTANT (verified 2026-06): Reddit IP-blocks datacenter ranges (HTTP 403/429) regardless
// of User-Agent, so EVERY public proxy is best-effort — it works only while Reddit is not
// blocking that proxy's server IP. The app therefore tries them in turn (automatic fallback)
// and falls back to clear guidance. Both proxies below are RAW pass-throughs: the response
// body is the upstream bytes verbatim, so they work for BOTH the listing JSON and media bytes
// (ZIP). corsproxy.io (now a paid plan → 403) and thingproxy.freeboard.io (offline) were
// removed because they no longer function for anonymous use.
export const PUBLIC_PROXIES = Object.freeze([
  Object.freeze({
    id: 'allorigins',
    label: 'allorigins.win',
    origin: 'https://api.allorigins.win',
    build: (raw) => `https://api.allorigins.win/raw?url=${encodeURIComponent(raw)}`,
  }),
  Object.freeze({
    id: 'codetabs',
    label: 'codetabs.com',
    origin: 'https://api.codetabs.com',
    build: (raw) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(raw)}`,
  }),
]);

// The proxy selected by default (and the migration target for any unknown saved id).
export const DEFAULT_PUBLIC_ID = PUBLIC_PROXIES[0].id;
