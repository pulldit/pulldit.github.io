// UI controller. Wires the DOM to the pure modules. All rendering uses createElement +
// textContent (never innerHTML with data), matching the strict CSP. No inline handlers.

import { APP, LIMITS, DEFAULT_PUBLIC_ID } from './config.js';
import { parseInput, buildJsonUrl, normalizeListing, singleMediaItem, aggregatePages } from './reddit.js';
import { fetchJson, canZip, resolveProxy, getPublicProxy, ProxyMode } from './proxy.js';
import { detectExtension } from './bridge-client.js';
import { downloadSingle, downloadZip } from './download.js';
import { applyFilters, normalizeFilters } from './filters.js';
import {
  formatBytes, formatDuration, formatSpeed, formatPercent, classifyError, aggregateDownload,
  accumulateFetchStats,
} from './stats.js';
import { capList, describeEntry, HISTORY_KEY, MAX_HISTORY, MAX_HISTORY_HARD } from './history.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'rd.settings.v1';
const FILTERS_KEY = 'rd.filters.v1';
const OPTIONS_KEY = 'rd.options.v1';
const STATS_KEY = 'rd.stats.v1';
const UI_KEY = 'rd.ui.v1';
const LINKS_KEY = 'rd.links.v1';
const MAX_LINKS = 50;
const ADVANCED_KEY = 'rd.advanced.v1';
const DOWNLOADED_KEY = 'rd.downloaded.v1';
const MAX_DOWNLOADED = 20000; // cap on remembered download keys (FIFO trim)
const COLLAPSIBLE_IDS = ['links-panel', 'proxy-panel', 'advanced-panel', 'fetch-stats-panel', 'download-stats-panel', 'history-panel'];
const STORAGE_KEYS = {
  history: HISTORY_KEY,
  links: LINKS_KEY,
  stats: STATS_KEY,
  settings: SETTINGS_KEY,
  filters: FILTERS_KEY,
  options: OPTIONS_KEY,
  advanced: ADVANCED_KEY,
  downloaded: DOWNLOADED_KEY,
};
const perf = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : 0);

/** @type {Array<object>} full normalized set from the last fetch */
let allItems = [];
/** @type {Array<object>} the items currently rendered (kept view or discarded view) */
let currentItems = [];
const selected = new Set();
const discarded = new Set();
let showDiscarded = false;
let busy = false;
let dlStart = 0;
/** Descriptor of the last successful fetch — used to name ZIP files meaningfully. */
let lastFetch = null;
/** When on, already-downloaded ("✓ saved") items are hidden from the kept view. */
let hideSaved = false;

/* ----------------------------- settings ----------------------------- */

function loadSettings() {
  const fallback = { mode: ProxyMode.DIRECT, workerUrl: '', publicId: DEFAULT_PUBLIC_ID };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    // Migrate any stale/removed proxy id (e.g. corsproxy/thingproxy) to a valid one.
    const publicId = getPublicProxy(parsed.publicId) ? parsed.publicId : DEFAULT_PUBLIC_ID;
    const validModes = [ProxyMode.DIRECT, ProxyMode.WORKER, ProxyMode.PUBLIC, ProxyMode.EXTENSION];
    return {
      mode: validModes.includes(parsed.mode) ? parsed.mode : ProxyMode.DIRECT,
      workerUrl: typeof parsed.workerUrl === 'string' ? parsed.workerUrl : '',
      publicId,
    };
  } catch {
    return fallback;
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage may be unavailable (private mode) — non-fatal */
  }
}

let settings = loadSettings();

function syncProxyUi() {
  for (const r of document.querySelectorAll('input[name="proxy-mode"]')) {
    r.checked = r.value === settings.mode;
  }
  $('worker-url').value = settings.workerUrl;
  $('public-proxy').value = settings.publicId;

  const resolved = resolveProxy(settings);
  const labels = { direct: 'Direct', worker: 'Worker', public: 'Public proxy', extension: 'Extension' };
  $('proxy-badge').textContent = resolved.ok ? labels[settings.mode] : 'Invalid config';

  $('download-zip').title = canZip(settings)
    ? 'Download all kept items as one ZIP'
    : 'ZIP needs a proxy mode (Direct mode cannot read media bytes)';
  updateToolbar();
}

function readProxyControls() {
  const mode = document.querySelector('input[name="proxy-mode"]:checked')?.value || ProxyMode.DIRECT;
  settings = { mode, workerUrl: $('worker-url').value.trim(), publicId: $('public-proxy').value };
  saveSettings(settings);
  syncProxyUi();
}

/* ----------------------------- filters ----------------------------- */

function loadFilters() {
  try {
    return normalizeFilters(JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}'));
  } catch {
    return normalizeFilters();
  }
}

function saveFilters() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* non-fatal */
  }
}

let filters = loadFilters();

/* ----------------------------- fetch options ----------------------------- */

function loadOptions() {
  try {
    return JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveOptions() {
  try {
    localStorage.setItem(
      OPTIONS_KEY,
      JSON.stringify({ sort: $('sort').value, time: $('time').value, limit: $('limit').value }),
    );
  } catch {
    /* non-fatal */
  }
}

function applySavedOptions() {
  const o = loadOptions();
  const sorts = ['hot', 'new', 'top', 'rising', 'controversial', 'best'];
  if (sorts.includes(o.sort)) $('sort').value = o.sort;
  if (['', 'hour', 'day', 'week', 'month', 'year', 'all'].includes(o.time)) $('time').value = o.time;
  const lim = Number(o.limit);
  if (Number.isFinite(lim) && lim >= 1 && lim <= 2000) $('limit').value = String(Math.round(lim));
}

/* ----------------------------- persisted statistics ----------------------------- */

function loadSavedStats() {
  try {
    return JSON.parse(localStorage.getItem(STATS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveStatsPatch(patch) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify({ ...loadSavedStats(), ...patch }));
  } catch {
    /* non-fatal */
  }
}

/* ----------------------------- advanced settings (rate limiter + downloader) ----------------------------- */

const ADV_DEFAULTS = Object.freeze({
  delayMs: 0, timeoutSec: 25, maxFileMb: 200, maxZipFiles: 250,
  skipDownloaded: true, countDiscardedAsDownloaded: false,
  autoSaveLinks: true,
  historyLimit: MAX_HISTORY, historyAutoOverwrite: true,
  validateMagic: true, validateDecode: true,
  autoPaginate: true, maxItems: 500, pageDelayMs: 400,
});

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function loadAdvanced() {
  let raw = {};
  try {
    raw = JSON.parse(localStorage.getItem(ADVANCED_KEY) || '{}') || {};
  } catch {
    raw = {};
  }
  return {
    delayMs: clampInt(raw.delayMs, 0, 10000, ADV_DEFAULTS.delayMs),
    timeoutSec: clampInt(raw.timeoutSec, 5, 120, ADV_DEFAULTS.timeoutSec),
    maxFileMb: clampInt(raw.maxFileMb, 1, 500, ADV_DEFAULTS.maxFileMb),
    maxZipFiles: clampInt(raw.maxZipFiles, 1, 1000, ADV_DEFAULTS.maxZipFiles),
    skipDownloaded: typeof raw.skipDownloaded === 'boolean' ? raw.skipDownloaded : ADV_DEFAULTS.skipDownloaded,
    countDiscardedAsDownloaded:
      typeof raw.countDiscardedAsDownloaded === 'boolean' ? raw.countDiscardedAsDownloaded : ADV_DEFAULTS.countDiscardedAsDownloaded,
    autoSaveLinks: typeof raw.autoSaveLinks === 'boolean' ? raw.autoSaveLinks : ADV_DEFAULTS.autoSaveLinks,
    historyLimit: clampInt(raw.historyLimit, 10, 1000, ADV_DEFAULTS.historyLimit),
    historyAutoOverwrite: typeof raw.historyAutoOverwrite === 'boolean' ? raw.historyAutoOverwrite : ADV_DEFAULTS.historyAutoOverwrite,
    validateMagic: typeof raw.validateMagic === 'boolean' ? raw.validateMagic : ADV_DEFAULTS.validateMagic,
    validateDecode: typeof raw.validateDecode === 'boolean' ? raw.validateDecode : ADV_DEFAULTS.validateDecode,
    autoPaginate: typeof raw.autoPaginate === 'boolean' ? raw.autoPaginate : ADV_DEFAULTS.autoPaginate,
    maxItems: clampInt(raw.maxItems, 100, 2000, ADV_DEFAULTS.maxItems),
    pageDelayMs: clampInt(raw.pageDelayMs, 0, 10000, ADV_DEFAULTS.pageDelayMs),
  };
}

let advanced = loadAdvanced();

function saveAdvanced() {
  try {
    localStorage.setItem(ADVANCED_KEY, JSON.stringify(advanced));
  } catch {
    /* non-fatal */
  }
}

function applyAdvancedToUi() {
  $('adv-delay').value = String(advanced.delayMs);
  $('adv-timeout').value = String(advanced.timeoutSec);
  $('adv-maxfile').value = String(advanced.maxFileMb);
  $('adv-maxzip').value = String(advanced.maxZipFiles);
  $('adv-skip').checked = advanced.skipDownloaded;
  $('adv-count-discarded').checked = advanced.countDiscardedAsDownloaded;
  $('adv-autosave-links').checked = advanced.autoSaveLinks;
  $('adv-history-limit').value = String(advanced.historyLimit);
  $('adv-history-overwrite').checked = advanced.historyAutoOverwrite;
  $('adv-validate-magic').checked = advanced.validateMagic;
  $('adv-validate-decode').checked = advanced.validateDecode;
  $('adv-auto-paginate').checked = advanced.autoPaginate;
  $('adv-max-items').value = String(advanced.maxItems);
  $('adv-page-delay').value = String(advanced.pageDelayMs);
  syncLinkAddButton();
  syncValidateUi();
  syncLimitField();
}

/** Check 2 (decode) is only meaningful while Check 1 (magic) is on — disable it otherwise. */
function syncValidateUi() {
  const decodeEl = $('adv-validate-decode');
  if (!decodeEl) return;
  decodeEl.disabled = !advanced.validateMagic;
  const row = decodeEl.closest('.check-row');
  if (row) row.classList.toggle('is-disabled', !advanced.validateMagic);
}

/** Reflect the pagination state onto the Limit field (its max) and the ">100" hint line. */
function syncLimitField() {
  const limitEl = $('limit');
  if (!limitEl) return;
  limitEl.max = String(advanced.autoPaginate ? advanced.maxItems : 100);
  const hint = $('pagination-hint');
  if (!hint) return;
  const val = Number(limitEl.value) || 0;
  if (val <= 100) {
    hint.hidden = true;
    return;
  }
  if (advanced.autoPaginate) {
    const target = Math.min(val, advanced.maxItems);
    const reqs = Math.ceil(target / 100);
    hint.textContent =
      `Auto-pagination is on — fetching up to ${target} items across ~${reqs} request${reqs === 1 ? '' : 's'} ` +
      '(Reddit returns max 100 per request). Cap & delay are in Advanced settings.';
    hint.className = 'hint pagination-hint';
  } else {
    hint.textContent =
      'Auto-pagination is off — Reddit caps a single request at 100, so only the first 100 will be fetched. ' +
      'Enable it in Advanced settings to fetch more.';
    hint.className = 'hint pagination-hint warn';
  }
  hint.hidden = false;
}

/** The manual "+ Add current link" button is redundant while auto-save is on, so disable it. */
function syncLinkAddButton() {
  const btn = $('link-add-btn');
  if (!btn) return;
  btn.disabled = advanced.autoSaveLinks;
  btn.title = advanced.autoSaveLinks
    ? 'Auto-save is on — fetched links are saved automatically. Turn it off in Advanced settings to add links manually.'
    : 'Save the current link to your Link history';
}

function readAdvancedFromUi() {
  advanced = {
    delayMs: clampInt($('adv-delay').value, 0, 10000, ADV_DEFAULTS.delayMs),
    timeoutSec: clampInt($('adv-timeout').value, 5, 120, ADV_DEFAULTS.timeoutSec),
    maxFileMb: clampInt($('adv-maxfile').value, 1, 500, ADV_DEFAULTS.maxFileMb),
    maxZipFiles: clampInt($('adv-maxzip').value, 1, 1000, ADV_DEFAULTS.maxZipFiles),
    skipDownloaded: $('adv-skip').checked,
    countDiscardedAsDownloaded: $('adv-count-discarded').checked,
    autoSaveLinks: $('adv-autosave-links').checked,
    historyLimit: clampInt($('adv-history-limit').value, 10, 1000, ADV_DEFAULTS.historyLimit),
    historyAutoOverwrite: $('adv-history-overwrite').checked,
    validateMagic: $('adv-validate-magic').checked,
    validateDecode: $('adv-validate-decode').checked,
    autoPaginate: $('adv-auto-paginate').checked,
    maxItems: clampInt($('adv-max-items').value, 100, 2000, ADV_DEFAULTS.maxItems),
    pageDelayMs: clampInt($('adv-page-delay').value, 0, 10000, ADV_DEFAULTS.pageDelayMs),
  };
  saveAdvanced();
  applyAdvancedToUi(); // reflect any clamped values back (also re-syncs dependent UI)
  reconcileHistory(); // apply new cap / display window immediately
}

/** Per-download limits derived from the advanced settings (passed into download.js). */
function dlLimits() {
  return {
    maxBytes: advanced.maxFileMb * 1024 * 1024,
    timeoutMs: advanced.timeoutSec * 1000,
    delayMs: advanced.delayMs,
    maxZipFiles: advanced.maxZipFiles,
  };
}

/**
 * Content-validation options for download.js, or null when Check 1 is off (skip entirely).
 * Check 2 (decode) only applies on top of Check 1.
 */
function validateOpts() {
  if (!advanced.validateMagic) return null;
  return { magic: true, decode: advanced.validateDecode };
}

/** Lowercase, filename-safe slug (letters/digits → words joined by single hyphens). */
function fnSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Meaningful ZIP base name from the last fetch, e.g. "pulldit-earthporn-top-week". */
function zipBaseName() {
  const f = lastFetch;
  let slug = 'media';
  if (f) {
    if (f.kind === 'subreddit' && f.subreddit) slug = f.subreddit;
    else if (f.kind === 'user' && f.username) slug = 'u-' + f.username;
    else if (f.kind === 'post' && f.postId) slug = 'post-' + f.postId;
    else if (f.label) slug = f.label;
  }
  const parts = ['pulldit', fnSlug(slug)];
  if (f && f.sort) parts.push(fnSlug(f.sort));
  if (f && f.time) parts.push(fnSlug(f.time));
  return parts.filter(Boolean).join('-');
}

/* ----------------------------- downloaded registry (skip already-downloaded) ----------------------------- */

/** Stable identity for a media item across fetches (reddit ids), with a URL fallback. */
function downloadedKey(item) {
  return String(item.id || item.url || '');
}

function loadDownloaded() {
  try {
    const a = JSON.parse(localStorage.getItem(DOWNLOADED_KEY) || '[]');
    return new Set(Array.isArray(a) ? a.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

let downloaded = loadDownloaded();

function saveDownloaded() {
  try {
    let arr = [...downloaded];
    if (arr.length > MAX_DOWNLOADED) arr = arr.slice(arr.length - MAX_DOWNLOADED); // FIFO trim
    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify(arr));
  } catch {
    /* non-fatal */
  }
}

function isDownloaded(item) {
  return downloaded.has(downloadedKey(item));
}

/** Mark one or more items as downloaded (remembered + skipped next time). */
function markDownloaded(itemsOrItem) {
  const list = Array.isArray(itemsOrItem) ? itemsOrItem : [itemsOrItem];
  let changed = false;
  for (const it of list) {
    const k = downloadedKey(it);
    if (k && !downloaded.has(k)) {
      downloaded.add(k);
      changed = true;
    }
  }
  if (changed) saveDownloaded();
  return changed;
}

/* ----------------------------- collapsible panel state ----------------------------- */

function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveUiState() {
  const state = {};
  for (const id of COLLAPSIBLE_IDS) {
    const el = $(id);
    if (el) state[id] = el.open;
  }
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(state));
  } catch {
    /* non-fatal */
  }
}

function applyUiState() {
  const state = loadUiState();
  for (const id of COLLAPSIBLE_IDS) {
    const el = $(id);
    if (el && typeof state[id] === 'boolean') el.open = state[id];
  }
}

/* ----------------------------- history ----------------------------- */

function loadActivity() {
  try {
    const a = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function saveActivity() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(activity));
  } catch {
    /* non-fatal */
  }
}

let activity = loadActivity();
/** How many (newest) history entries are currently shown; grown by "Show more". */
let historyShown = advanced.historyLimit;

/** Storage cap: trim to the display limit when auto-overwrite is on, else keep up to the hard ceiling. */
function historyCap() {
  return advanced.historyAutoOverwrite ? advanced.historyLimit : MAX_HISTORY_HARD;
}

function addHistory(entry) {
  activity = capList([...activity, { ...entry, t: Date.now() }], historyCap());
  saveActivity();
  renderHistory();
}

/** Re-apply the storage cap and reset the display window after a settings change. */
function reconcileHistory() {
  if (advanced.historyAutoOverwrite) {
    const capped = capList(activity, advanced.historyLimit);
    if (capped.length !== activity.length) {
      activity = capped;
      saveActivity();
    }
  }
  historyShown = advanced.historyLimit;
  renderHistory();
}

function formatTime(t) {
  try {
    return new Date(t).toLocaleString();
  } catch {
    return '';
  }
}

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  const total = activity.length;
  $('history-count').textContent = String(total);
  if (total === 0) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No activity yet.';
    list.appendChild(empty);
    return;
  }
  const window = Math.max(1, Number(historyShown) || advanced.historyLimit);
  const shown = Math.min(window, total);
  for (let i = total - 1; i >= total - shown; i -= 1) {
    list.appendChild(renderHistoryItem(activity[i], i));
  }
  if (total > shown) {
    const li = document.createElement('li');
    li.className = 'history-more';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost history-more-btn';
    btn.textContent = `Show more (${total - shown} older)`;
    btn.addEventListener('click', () => {
      historyShown = shown + advanced.historyLimit;
      renderHistory();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

/** Build one history <li> with time, icon, primary text, optional detail line and a delete button. */
function renderHistoryItem(e, index) {
  const d = describeEntry(e);
  const li = document.createElement('li');
  li.className = 'history-item' + (d.kind === 'good' || d.kind === 'bad' || d.kind === 'warn' ? ' ' + d.kind : '');
  const time = document.createElement('span');
  time.className = 'history-time';
  time.textContent = formatTime(e.t);
  const icon = document.createElement('span');
  icon.className = 'history-icon';
  icon.textContent = d.icon;
  const main = document.createElement('div');
  main.className = 'history-main';
  const text = document.createElement('span');
  text.className = 'history-text';
  text.textContent = d.text;
  main.appendChild(text);
  if (d.detail) {
    const detail = document.createElement('span');
    detail.className = 'history-detail';
    detail.textContent = d.detail;
    main.appendChild(detail);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'history-del';
  del.textContent = '✕';
  del.title = 'Remove this entry';
  del.setAttribute('aria-label', 'Remove history entry: ' + d.text);
  del.addEventListener('click', () => removeHistoryAt(index));
  li.appendChild(time);
  li.appendChild(icon);
  li.appendChild(main);
  li.appendChild(del);
  return li;
}

/** Remove a single activity-history entry by its index in `activity`. */
function removeHistoryAt(index) {
  if (!Number.isInteger(index) || index < 0 || index >= activity.length) return;
  activity.splice(index, 1);
  saveActivity();
  renderHistory();
}

function itemTitle(id) {
  const it = allItems.find((i) => i.id === id);
  return it ? it.title || it.id : id;
}

/* ----------------------------- link history ----------------------------- */

function loadLinks() {
  try {
    const a = JSON.parse(localStorage.getItem(LINKS_KEY) || '[]');
    return Array.isArray(a) ? a.filter((l) => l && typeof l.input === 'string') : [];
  } catch {
    return [];
  }
}

let links = loadLinks();

function saveLinks() {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(links));
  } catch {
    /* non-fatal */
  }
}

/** Add (or move to front) a fetched/saved link. Newest first; de-duplicated by input. */
function addLink(input, label) {
  const value = String(input || '').trim();
  if (!value) return;
  links = links.filter((l) => l.input !== value);
  links.unshift({ input: value, label: label || value, t: Date.now() });
  if (links.length > MAX_LINKS) links = links.slice(0, MAX_LINKS);
  saveLinks();
  renderLinks();
}

function removeLink(input) {
  links = links.filter((l) => l.input !== input);
  saveLinks();
  renderLinks();
}

/** Load a saved link into the query box and fetch it. */
function useLink(input) {
  $('query').value = input;
  $('search-form').requestSubmit();
}

function renderLinks() {
  const list = $('links-list');
  list.replaceChildren();
  $('links-count').textContent = String(links.length);
  if (links.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No saved links yet — fetch something or use “+ Add current link”.';
    list.appendChild(empty);
    return;
  }
  links.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'link-item' + (i === 0 ? ' latest' : '');
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'link-use';
    use.title = 'Fetch ' + l.input;
    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'link-latest';
      tag.textContent = 'latest';
      use.appendChild(tag);
    }
    const text = document.createElement('span');
    text.className = 'link-text';
    text.textContent = l.label || l.input;
    use.appendChild(text);
    use.addEventListener('click', () => useLink(l.input));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link-del';
    del.textContent = '✕';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove ' + (l.label || l.input));
    del.addEventListener('click', () => removeLink(l.input));

    li.appendChild(use);
    li.appendChild(del);
    list.appendChild(li);
  });
}

// Filter groups: each must keep at least one option enabled, otherwise the group hides every
// item (e.g. both sources off → nothing shows, even with media found).
const TYPE_FILTERS = ['image', 'gif', 'video'];
const SOURCE_FILTERS = ['reddit', 'imgur'];

function onFilterChange(event) {
  const next = {};
  for (const cb of document.querySelectorAll('#filters input[data-filter]')) {
    next[cb.dataset.filter] = cb.checked;
  }
  const target = event && event.target;
  const key = target && target.dataset ? target.dataset.filter : null;
  for (const group of [TYPE_FILTERS, SOURCE_FILTERS]) {
    // If the user just unchecked the LAST active option in a group, revert that one toggle.
    if (key && group.includes(key) && group.every((k) => next[k] === false)) {
      next[key] = true;
      if (target) target.checked = true;
      const label = group === SOURCE_FILTERS ? 'source (Reddit or imgur)' : 'media type';
      setStatus(`At least one ${label} must stay enabled.`, '');
    }
  }
  filters = normalizeFilters(next);
  saveFilters();
  refreshView();
}

/** Repair a persisted filter state that has an entire group disabled (re-enable that group). */
function repairFilterGroups() {
  let changed = false;
  for (const group of [TYPE_FILTERS, SOURCE_FILTERS]) {
    if (group.every((k) => filters[k] === false)) {
      for (const k of group) filters[k] = true;
      changed = true;
    }
  }
  if (changed) {
    filters = normalizeFilters(filters);
    saveFilters();
    for (const cb of document.querySelectorAll('#filters input[data-filter]')) {
      cb.checked = filters[cb.dataset.filter] !== false;
    }
  }
}

/* ----------------------------- view derivation ----------------------------- */

function viewItems() {
  return applyFilters(allItems, filters);
}
function keptItems() {
  return viewItems().filter((i) => !discarded.has(i.id));
}
function discardedItems() {
  return viewItems().filter((i) => discarded.has(i.id));
}

function refreshView() {
  currentItems = showDiscarded ? discardedItems() : keptItems();
  renderGrid();
  updateToolbar();
}

/* ----------------------------- status ----------------------------- */

function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/**
 * Build the post-fetch status message. If items were found but the active type/source filters
 * hide all of them, say so explicitly (otherwise an empty grid looks like a failure).
 * @param {number} found total normalized items (pre-filter)
 */
function reportFound(found) {
  if (found === 0) return 'No downloadable media found in this listing.';
  const shown = keptItems().length;
  if (shown === 0) {
    return `Found ${found} item${found === 1 ? '' : 's'}, but your filters hide ${found === 1 ? 'it' : 'them all'} — ` +
      'enable the “Show types” / “Sources” chips above.';
  }
  return `Found ${found} media item${found === 1 ? '' : 's'}.`;
}

/* ----------------------------- fetching ----------------------------- */

/** Simple delay used to space out paginated listing requests (dodges Reddit rate limits). */
function delay(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Fetch a subreddit/user listing, auto-paginating past Reddit's hard 100-per-request cap when
 * the Limit exceeds 100 and auto-pagination is enabled. Returns the merged, de-duplicated items
 * plus aggregated stats. `meta` is an out-param that receives { bytes, pages, partial }.
 *
 * - Not paginating (post page, auto-pagination off, or target ≤ 100): a single request, returned
 *   verbatim — identical to the original behavior.
 * - Paginating: 100 posts per page, following the `after` cursor, stopping when the requested
 *   item count is reached, the listing ends, a page adds nothing new, or a safety page bound is
 *   hit. A failing FIRST page is a real error; a failing LATER page yields a partial result.
 * @param {object} parsed   parseInput result (kind subreddit|user|post)
 * @param {{ sort?: string, time?: string }} baseOpts
 * @param {{ bytes?: number, pages?: number, partial?: boolean }} meta
 * @returns {Promise<{ items: Array<object>, stats: object }>}
 */
async function fetchListing(parsed, baseOpts, meta) {
  const wanted = Number($('limit').value) || LIMITS.defaultListingLimit;
  const target = Math.max(1, Math.min(wanted, advanced.maxItems));
  const paginate =
    advanced.autoPaginate && target > 100 && (parsed.kind === 'subreddit' || parsed.kind === 'user');

  if (!paginate) {
    const url = buildJsonUrl(parsed, { ...baseOpts, limit: Math.min(100, target) });
    const json = await fetchJson(url, settings, { stats: meta });
    meta.pages = 1;
    const { items, stats } = normalizeListing(json);
    return { items, stats };
  }

  const pages = [];
  const seen = new Set();
  let dedupCount = 0;
  let after = null;
  let pageCount = 0;
  let totalBytes = 0;
  const maxPages = Math.min(40, Math.ceil(target / 100) + 5); // safety bound for sparse listings

  for (;;) {
    const url = buildJsonUrl(parsed, { ...baseOpts, limit: 100, after });
    const pmeta = {};
    let json;
    try {
      json = await fetchJson(url, settings, { stats: pmeta });
    } catch (err) {
      if (pages.length === 0) throw err; // first page failed → surface the real error
      meta.partial = true; // a later page failed → keep what we already collected
      break;
    }
    pageCount += 1;
    if (Number.isFinite(pmeta.bytes)) totalBytes += pmeta.bytes;
    const norm = normalizeListing(json);
    pages.push(norm);
    after = norm.after;
    let fresh = 0;
    for (const it of norm.items) {
      const key = it && it.id != null ? it.id : it;
      if (!seen.has(key)) {
        seen.add(key);
        fresh += 1;
      }
    }
    dedupCount += fresh;
    setStatus(`Fetching ${parsed.label}… page ${pageCount}, ${dedupCount} item${dedupCount === 1 ? '' : 's'}`);

    if (dedupCount >= target) break; // reached the requested amount
    if (!after) break; // listing ended
    if (fresh === 0) break; // no new media this page — stop (avoid spinning)
    if (pageCount >= maxPages) break; // hard safety bound
    await delay(advanced.pageDelayMs); // space out requests
  }

  meta.bytes = totalBytes;
  meta.pages = pageCount;
  return aggregatePages(pages, target);
}

async function onSearch(event) {
  event.preventDefault();
  if (busy) return;

  const rawInput = $('query').value.trim();
  const parsed = parseInput(rawInput);
  if (!parsed.ok) {
    setStatus('Could not understand that input: ' + parsed.reason, 'error');
    return;
  }

  // A direct media link (reddit.com/media?url=… or a pasted i.redd.it/imgur URL): no listing
  // fetch — build the single item and render it straight away.
  if (parsed.kind === 'media') {
    const item = singleMediaItem(parsed.url);
    if (!item) {
      setStatus('That media link is not a supported Reddit/imgur file.', 'error');
      return;
    }
    allItems = [item];
    selected.clear();
    discarded.clear();
    showDiscarded = false;
    lastFetch = { kind: 'media', label: parsed.label };
    refreshView();
    addHistory({ type: 'fetch', label: parsed.label, status: 'success', found: 1, mode: settings.mode });
    if (advanced.autoSaveLinks) addLink(rawInput, parsed.label);
    setStatus(reportFound(1), keptItems().length ? 'ok' : 'error');
    return;
  }

  const opts = {
    sort: $('sort').value,
    time: $('time').value || undefined,
  };

  setBusy(true);
  setStatus(`Fetching ${parsed.label}…`);
  const meta = {};
  const t0 = perf();
  try {
    const { items, stats } = await fetchListing(parsed, opts, meta);
    const elapsedMs = perf() - t0;
    allItems = items;
    selected.clear();
    discarded.clear();
    showDiscarded = false;
    lastFetch = { kind: parsed.kind, subreddit: parsed.subreddit, username: parsed.username, postId: parsed.postId, sort: opts.sort, time: opts.time, label: parsed.label };
    recordFetchStats({ status: 'success', elapsedMs, bytes: meta.bytes, pages: meta.pages, ...stats });
    refreshView();
    addHistory({ type: 'fetch', label: parsed.label, status: 'success', found: items.length, sort: opts.sort, time: opts.time, mode: settings.mode, pages: meta.pages });
    if (advanced.autoSaveLinks) addLink(rawInput, parsed.label);
    const note = meta.partial
      ? ' — a later page failed, showing partial results'
      : (meta.pages > 1 ? ` · ${meta.pages} pages` : '');
    setStatus(reportFound(items.length) + (items.length === 0 ? '' : note), items.length === 0 ? '' : (keptItems().length ? 'ok' : 'error'));
  } catch (err) {
    const elapsedMs = perf() - t0;
    const reason = classifyError(err?.message || err);
    recordFetchStats({
      status: reason === 'timeout' ? 'timeout' : 'failed',
      elapsedMs,
      bytes: meta.bytes,
      error: err?.message ? String(err.message) : String(err),
    });
    addHistory({ type: 'fetch', label: parsed.label, status: reason, sort: opts.sort, time: opts.time, mode: settings.mode });
    handleFetchError(err);
  } finally {
    setBusy(false);
  }
}

function handleFetchError(err) {
  const msg = err?.message ? String(err.message) : String(err);
  if (settings.mode === ProxyMode.DIRECT) {
    setStatus(
      'Reddit refused the direct request (it blocks some IPs and cross-origin browser requests). ' +
        'Open “Proxy & download mode” and pick a public proxy, or set up your own Cloudflare Worker.',
      'error',
    );
  } else if (settings.mode === ProxyMode.PUBLIC) {
    setStatus(
      'All public proxies failed — Reddit is currently blocking their servers. ' +
        'Try again shortly, switch proxy, or run your own Cloudflare Worker for reliable access. ' +
        '(' + msg + ')',
      'error',
    );
  } else if (settings.mode === ProxyMode.EXTENSION) {
    setStatus(
      'Reddit refused the request even via the extension (' + msg + '). ' +
        'Make sure you are signed in to reddit.com in this browser (open reddit.com in a tab once) — ' +
        'Reddit blocks anonymous .json access for some IPs. A public proxy or your own Worker may also work.',
      'error',
    );
  } else {
    setStatus('Fetch failed: ' + msg, 'error');
  }
}

/* ----------------------------- statistics rendering ----------------------------- */

function makeStatGrid(entries) {
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  for (const e of entries) {
    const cell = document.createElement('div');
    cell.className = 'stat' + (e.kind ? ' ' + e.kind : '') + (e.wide ? ' wide' : '');
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = e.label;
    const value = document.createElement('span');
    value.className = 'stat-value';
    value.textContent = e.value;
    cell.appendChild(label);
    cell.appendChild(value);
    grid.appendChild(cell);
  }
  return grid;
}

/** Render a single flat grid of stat cells (download stats). */
function buildStatCells(container, entries) {
  container.replaceChildren(makeStatGrid(entries));
}

/** Render one or more titled groups, each its own grid (fetch stats: last + cumulative). */
function buildStatGroups(container, groups) {
  container.replaceChildren();
  for (const g of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'stat-group';
    if (g.title) {
      const h = document.createElement('div');
      h.className = 'stat-group-title';
      h.textContent = g.title;
      wrap.appendChild(h);
    }
    wrap.appendChild(makeStatGrid(g.entries));
    container.appendChild(wrap);
  }
}

function setBadge(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'badge' + (kind ? ' ' + kind : '');
}

function renderFetchStatsIdle() {
  setBadge('fetch-stats-badge', 'Idle', '');
  buildStatCells($('fetch-stats'), [
    { label: 'Status', value: 'Idle' },
    { label: 'Tip', value: 'Run a fetch — statistics will appear here.', wide: true },
  ]);
}

/**
 * Render the fetch-statistics panel. Shows the LAST fetch plus, when available, CUMULATIVE
 * totals summed across every fetch (persisted, never overwritten).
 * @param {object} s     the last fetch result
 * @param {object} [cum] cumulative totals (from accumulateFetchStats)
 */
function renderFetchStats(s, cum) {
  const last = [];
  if (s.status === 'success') last.push({ label: 'Status', value: 'Success', kind: 'good' });
  else if (s.status === 'timeout') last.push({ label: 'Status', value: 'Timeout', kind: 'bad' });
  else last.push({ label: 'Status', value: 'Failed', kind: 'bad' });

  last.push({ label: 'Time', value: formatDuration(s.elapsedMs) });
  if (Number.isFinite(s.bytes)) last.push({ label: 'Listing size', value: formatBytes(s.bytes) });
  if (Number.isFinite(s.pages) && s.pages > 1) last.push({ label: 'Pages', value: String(s.pages), kind: 'accent' });

  if (s.status === 'success') {
    last.push({ label: 'Posts scanned', value: String(s.postsScanned ?? 0) });
    last.push({ label: 'With media', value: String(s.postsWithMedia ?? 0) });
    last.push({ label: 'No media', value: String(s.dropped ?? 0) });
    last.push({ label: 'Galleries', value: String(s.galleries ?? 0) });
    last.push({ label: 'Media found', value: String(s.found ?? 0), kind: 'accent' });
    last.push({ label: 'Images', value: String(s.byType?.image ?? 0) });
    last.push({ label: 'GIFs', value: String(s.byType?.gif ?? 0) });
    last.push({ label: 'Videos', value: String(s.byType?.video ?? 0) });
    last.push({ label: 'Reddit', value: String(s.bySource?.reddit ?? 0) });
    last.push({ label: 'imgur', value: String(s.bySource?.imgur ?? 0) });
    if (s.nsfw) last.push({ label: 'NSFW', value: String(s.nsfw), kind: 'warn' });
    if (s.capped) last.push({ label: 'Capped at', value: String(LIMITS.maxItems), kind: 'warn' });
  } else if (s.error) {
    last.push({ label: 'Error', value: s.error, wide: true });
  }

  const groups = [{ title: 'Last fetch', entries: last }];

  if (cum && cum.fetches > 0) {
    const c = [];
    c.push({ label: 'Fetches', value: String(cum.fetches) });
    c.push({ label: 'Successful', value: String(cum.successes), kind: 'good' });
    const failed = cum.failures + cum.timeouts;
    if (failed) c.push({ label: 'Failed', value: String(failed), kind: 'bad' });
    c.push({ label: 'Posts scanned', value: String(cum.postsScanned) });
    c.push({ label: 'With media', value: String(cum.postsWithMedia) });
    c.push({ label: 'No media', value: String(cum.dropped) });
    c.push({ label: 'Galleries', value: String(cum.galleries) });
    c.push({ label: 'Media found', value: String(cum.found), kind: 'accent' });
    c.push({ label: 'Images', value: String(cum.images) });
    c.push({ label: 'GIFs', value: String(cum.gifs) });
    c.push({ label: 'Videos', value: String(cum.videos) });
    c.push({ label: 'Reddit', value: String(cum.reddit) });
    c.push({ label: 'imgur', value: String(cum.imgur) });
    if (cum.nsfw) c.push({ label: 'NSFW', value: String(cum.nsfw), kind: 'warn' });
    c.push({ label: 'Total data', value: formatBytes(cum.bytes) });
    c.push({ label: 'Total time', value: formatDuration(cum.totalMs) });
    groups.push({ title: `All time · ${cum.fetches} fetch${cum.fetches === 1 ? '' : 'es'}`, entries: c });
  }

  if (s.status === 'success') setBadge('fetch-stats-badge', `${s.found ?? 0} found`, 'good');
  else if (s.status === 'timeout') setBadge('fetch-stats-badge', 'Timeout', 'bad');
  else setBadge('fetch-stats-badge', 'Failed', 'bad');
  buildStatGroups($('fetch-stats'), groups);
}

/** Record a fetch result into persisted cumulative totals and render the panel. */
function recordFetchStats(sample) {
  const cum = accumulateFetchStats(loadSavedStats().fetchCum, sample);
  saveStatsPatch({ fetch: sample, fetchCum: cum });
  renderFetchStats(sample, cum);
}

function renderDownloadStats(a, opts = {}) {
  $('download-stats-panel').hidden = false;
  const box = $('download-stats');
  const entries = [];
  if (opts.live) {
    setBadge('download-stats-badge', `${a.processed}/${a.total}`, '');
    entries.push({ label: 'Progress', value: `${a.processed} / ${a.total}` });
    entries.push({ label: 'Succeeded', value: String(a.success), kind: 'good' });
    if (a.failed) entries.push({ label: 'Failed', value: String(a.failed), kind: 'bad' });
    entries.push({ label: 'Downloaded', value: formatBytes(a.totalBytes), kind: 'accent' });
    entries.push({ label: 'Speed', value: formatSpeed(a.avgSpeed) });
    buildStatCells(box, entries);
    return;
  }
  entries.push({ label: 'Total', value: String(a.total) });
  entries.push({ label: 'Succeeded', value: String(a.success), kind: 'good' });
  entries.push({ label: 'Failed', value: String(a.failed), kind: a.failed ? 'bad' : '' });
  if (Number.isFinite(opts.skipped) && opts.skipped > 0) {
    entries.push({ label: 'Skipped', value: String(opts.skipped), kind: 'warn' });
  }
  entries.push({ label: 'Success rate', value: formatPercent(a.success, a.total) });
  entries.push({ label: 'Downloaded', value: formatBytes(a.totalBytes), kind: 'accent' });
  entries.push({ label: 'Largest file', value: formatBytes(a.largest) });
  if (Number.isFinite(opts.elapsedMs)) entries.push({ label: 'Elapsed', value: formatDuration(opts.elapsedMs) });
  entries.push({ label: 'Avg speed', value: formatSpeed(a.avgSpeed) });
  for (const reason of Object.keys(a.byReason)) {
    if (a.byReason[reason] > 0) entries.push({ label: reason, value: String(a.byReason[reason]), kind: 'bad' });
  }
  setBadge('download-stats-badge', `${a.success}/${a.total}`, a.failed ? 'warn' : 'good');
  buildStatCells(box, entries);
  saveStatsPatch({ download: { a, elapsedMs: opts.elapsedMs, skipped: opts.skipped } });
}

/* ----------------------------- rendering ----------------------------- */

const TYPE_ICON = { image: 'IMG', gif: 'GIF', video: 'VID' };

function renderGrid() {
  const grid = $('grid');
  grid.replaceChildren();
  $('results-section').hidden = allItems.length === 0;
  for (const item of currentItems) grid.appendChild(renderCard(item, showDiscarded));
}

function renderCard(item, isDiscardedView) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = item.id;

  const media = document.createElement('div');
  media.className = 'card-media';

  if (isDiscardedView) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'card-restore';
    restore.textContent = '↺';
    restore.title = 'Restore';
    restore.setAttribute('aria-label', 'Restore ' + (item.title || item.id));
    restore.addEventListener('click', () => restoreItem(item.id));
    media.appendChild(restore);
  } else {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'card-check';
    check.checked = selected.has(item.id);
    check.setAttribute('aria-label', 'Select ' + (item.title || item.id));
    check.addEventListener('change', () => toggleSelect(item.id, check.checked, li));
    media.appendChild(check);

    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'card-discard';
    discard.textContent = '✕';
    discard.title = 'Discard';
    discard.setAttribute('aria-label', 'Discard ' + (item.title || item.id));
    discard.addEventListener('click', () => discardItem(item.id));
    media.appendChild(discard);
  }

  // Prefer the small downscaled thumbnail. Only fall back to the full-res file for non-video
  // items that genuinely have no preview (rare) — keeps a large grid light.
  const thumbUrl = item.thumbnail || (item.type !== 'video' ? item.url : '');
  if (thumbUrl) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = item.title || '';
    // Layout hints so the grid doesn't reflow as thumbnails stream in.
    img.width = 320;
    img.height = 320;
    img.src = thumbUrl;
    img.addEventListener('error', () => {
      img.remove();
      media.appendChild(makePlaceholder(item.type));
    });
    media.appendChild(img);
  } else {
    media.appendChild(makePlaceholder(item.type));
  }

  const type = document.createElement('span');
  type.className = 'type-badge';
  type.textContent = TYPE_ICON[item.type] || item.type;
  media.appendChild(type);

  if (item.nsfw) {
    const nsfw = document.createElement('span');
    nsfw.className = 'nsfw-badge';
    nsfw.textContent = 'NSFW';
    media.appendChild(nsfw);
  }

  if (isDownloaded(item)) {
    li.classList.add('downloaded');
    const got = document.createElement('span');
    got.className = 'got-badge';
    got.textContent = '✓ saved';
    got.title = 'Already downloaded';
    media.appendChild(got);
  }

  const body = document.createElement('div');
  body.className = 'card-body';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = item.title || item.id;
  body.appendChild(title);

  if (!isDiscardedView) {
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn';
    dl.textContent = 'Download';
    dl.addEventListener('click', () => onDownloadOne(item, dl));
    actions.appendChild(dl);
    if (item.permalink) {
      const open = document.createElement('a');
      open.className = 'btn ghost';
      open.textContent = 'Post';
      open.href = item.permalink;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      actions.appendChild(open);
    }
    body.appendChild(actions);
  }

  li.appendChild(media);
  li.appendChild(body);
  return li;
}

function makePlaceholder(type) {
  const ph = document.createElement('span');
  ph.className = 'placeholder';
  ph.textContent = type === 'video' ? '▶' : '🖼';
  return ph;
}

function toggleSelect(id, on, li) {
  if (on) selected.add(id);
  else selected.delete(id);
  li.classList.toggle('selected', on);
  updateToolbar();
}

/* ----------------------------- discard ----------------------------- */

function discardItem(id) {
  discarded.add(id);
  selected.delete(id);
  // Optionally treat discarded items as "seen" so they're skipped in future downloads.
  if (advanced.countDiscardedAsDownloaded) {
    const it = allItems.find((i) => i.id === id);
    if (it) markDownloaded(it);
  }
  addHistory({ type: 'discard', label: itemTitle(id) });
  refreshView();
}
function restoreItem(id) {
  discarded.delete(id);
  addHistory({ type: 'restore', label: itemTitle(id) });
  refreshView();
}
function restoreAll() {
  if (discarded.size) addHistory({ type: 'restore', label: `all (${discarded.size})` });
  discarded.clear();
  refreshView();
}
function toggleDiscardedView() {
  showDiscarded = !showDiscarded;
  refreshView();
}

function updateToolbar() {
  const kept = keptItems().length;
  const disc = discardedItems().length;
  const sel = selected.size;

  $('count').textContent = showDiscarded
    ? `${disc} discarded`
    : `${kept} item${kept === 1 ? '' : 's'}${sel ? ` · ${sel} selected` : ''}${disc ? ` · ${disc} discarded` : ''}`;

  const toggle = $('toggle-discarded');
  toggle.hidden = disc === 0 && !showDiscarded;
  toggle.textContent = showDiscarded ? 'Back to kept' : `Show discarded (${disc})`;

  $('restore-all').hidden = !(showDiscarded && disc > 0);
  $('select-all').hidden = showDiscarded;
  $('select-none').hidden = showDiscarded;
  $('download-selected').hidden = showDiscarded;

  const zipBtn = $('download-zip');
  zipBtn.hidden = showDiscarded;
  zipBtn.disabled = !(canZip(settings) && kept > 0) || busy;
}

function selectedItems() {
  const pool = keptItems();
  return selected.size ? pool.filter((i) => selected.has(i.id)) : pool;
}

/* ----------------------------- downloads ----------------------------- */

/** Add the "✓ saved" badge to a card in place (without a full grid re-render). */
function markCardDownloaded(card) {
  if (!card || card.classList.contains('downloaded')) return;
  card.classList.add('downloaded');
  const media = card.querySelector('.card-media');
  if (media && !media.querySelector('.got-badge')) {
    const got = document.createElement('span');
    got.className = 'got-badge';
    got.textContent = '✓ saved';
    got.title = 'Already downloaded';
    media.appendChild(got);
  }
}

async function onDownloadOne(item, btn) {
  if (busy) return;
  const prev = btn.textContent;
  const lim = dlLimits();
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await downloadSingle(item, settings, { maxBytes: lim.maxBytes, timeoutMs: lim.timeoutMs, validate: validateOpts() });
    btn.textContent = r.opened ? 'Opened' : 'Saved ✓';
    if (!r.opened) {
      markDownloaded(item); // a real save — remember it (direct-mode "opened" is unverified)
      if (typeof btn.closest === 'function') markCardDownloaded(btn.closest('.card'));
    }
    addHistory({
      type: 'download', label: item.title || item.id,
      filename: r.filename || '',
      size: Number.isFinite(r.bytes) ? formatBytes(r.bytes) : (r.opened ? 'opened in new tab' : ''),
    });
  } catch (err) {
    btn.textContent = 'Failed';
    setStatus('Download failed: ' + (err?.message || err), 'error');
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = prev;
    }, 1500);
  }
}

/** Drop already-downloaded items when the skip setting is on. Returns { items, skipped }. */
function applySkip(items) {
  if (!advanced.skipDownloaded) return { items, skipped: 0 };
  const kept = items.filter((it) => !isDownloaded(it));
  return { items: kept, skipped: items.length - kept.length };
}

async function onDownloadSelected() {
  if (busy) return;
  const { items, skipped } = applySkip(selectedItems());
  if (!items.length) {
    setStatus(skipped ? `All ${skipped} selected item(s) were already downloaded.` : 'Nothing selected.', '');
    return;
  }
  if (resolveProxy(settings).mode === ProxyMode.DIRECT) {
    setStatus(`Opening ${items.length} file(s) in new tabs (Direct mode). Allow pop-ups, or use a proxy + ZIP.`, '');
  }
  setBusy(true);
  const lim = dlLimits();
  let ok = 0;
  const saved = [];
  for (let i = 0; i < items.length; i += 1) {
    if (lim.delayMs > 0 && i > 0) await new Promise((r) => setTimeout(r, lim.delayMs));
    try {
      const r = await downloadSingle(items[i], settings, { maxBytes: lim.maxBytes, timeoutMs: lim.timeoutMs, validate: validateOpts() });
      ok += 1;
      if (!r.opened) saved.push(items[i]);
    } catch {
      /* keep going */
    }
  }
  if (saved.length) markDownloaded(saved);
  setBusy(false);
  refreshView();
  const skipNote = skipped ? ` · ${skipped} skipped` : '';
  setStatus(`Processed ${ok}/${items.length} download(s)${skipNote}.`, ok ? 'ok' : 'error');
}

async function onDownloadZip() {
  if (busy || !canZip(settings)) return;
  const { items, skipped } = applySkip(selectedItems());
  if (!items.length) {
    setStatus(skipped ? `All ${skipped} item(s) were already downloaded — nothing new to zip.` : 'Nothing to zip.', skipped ? '' : 'error');
    return;
  }
  setBusy(true);
  showProgress(true);
  dlStart = perf();
  try {
    const result = await downloadZip(items, settings, {
      zipName: zipBaseName(),
      onProgress: onZipProgress,
      limits: dlLimits(),
      validate: validateOpts(),
    });
    const okIds = new Set(result.files.filter((f) => f.ok).map((f) => f.id));
    markDownloaded(items.filter((it) => okIds.has(it.id)));
    renderDownloadStats(aggregateDownload(result.files, result.elapsedMs), { elapsedMs: result.elapsedMs, skipped });
    addHistory({
      type: 'zip', added: result.added, failed: result.failed.length,
      size: formatBytes(result.totalBytes), skipped, zips: result.zips,
      elapsed: formatDuration(result.elapsedMs),
    });
    const failedNote = result.failed.length ? ` (${result.failed.length} failed)` : '';
    const skipNote = skipped ? ` · ${skipped} skipped` : '';
    const zipsNote = result.zips > 1 ? ` in ${result.zips} ZIPs` : '';
    setStatus(`ZIP ready: ${result.added} file(s)${zipsNote}${failedNote}${skipNote}.`, 'ok');
    refreshView();
  } catch (err) {
    setStatus('ZIP failed: ' + (err?.message || err), 'error');
  } finally {
    showProgress(false);
    setBusy(false);
  }
}

function onZipProgress(e) {
  const bar = $('progress-bar');
  const label = $('progress-label');
  const batchTag = e.batches > 1 ? `ZIP ${e.batch}/${e.batches} · ` : '';
  if (e.phase === 'fetch') {
    bar.style.width = Math.round((e.index / e.total) * 100) + '%';
    label.textContent = `${batchTag}Downloading ${e.index + 1} / ${e.total}…`;
  } else if (e.phase === 'fetched') {
    const done = e.index + 1;
    bar.style.width = Math.round((done / e.total) * 100) + '%';
    const elapsed = perf() - dlStart;
    const speed = elapsed > 0 ? e.totalBytes / (elapsed / 1000) : 0;
    renderDownloadStats(
      { processed: done, total: e.total, success: e.okCount, failed: done - e.okCount, totalBytes: e.totalBytes, avgSpeed: speed },
      { live: true },
    );
  } else if (e.phase === 'compress' || e.phase === 'zip') {
    label.textContent = `${batchTag}Packing ZIP…`;
  }
}

function showProgress(on) {
  const p = $('progress');
  p.hidden = !on;
  if (on) {
    $('progress-bar').style.width = '0%';
    $('progress-label').textContent = 'Starting…';
  }
}

/* ----------------------------- misc ----------------------------- */

function setBusy(on) {
  busy = on;
  $('fetch-btn').disabled = on;
  $('fetch-btn').textContent = on ? 'Fetching…' : 'Fetch media';
  updateToolbar();
}

/* ----------------------------- clear-data modal ----------------------------- */

let lastFocused = null;

function openClearModal() {
  lastFocused = document.activeElement;
  $('clear-modal').hidden = false;
  document.addEventListener('keydown', onModalKeydown);
  $('clear-history-opt').focus();
}

function closeClearModal() {
  $('clear-modal').hidden = true;
  document.removeEventListener('keydown', onModalKeydown);
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}

function onModalKeydown(e) {
  if (e.key === 'Escape') {
    closeClearModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const f = $('clear-modal').querySelectorAll('button, input');
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function syncClearSelectAll() {
  const all = $('clear-all-opt').checked;
  for (const id of ['clear-history-opt', 'clear-links-opt', 'clear-stats-opt', 'clear-settings-opt', 'clear-filters-opt', 'clear-options-opt', 'clear-advanced-opt', 'clear-downloaded-opt']) {
    $(id).checked = all;
  }
}

function performClear() {
  const sel = {
    history: $('clear-history-opt').checked,
    links: $('clear-links-opt').checked,
    stats: $('clear-stats-opt').checked,
    settings: $('clear-settings-opt').checked,
    filters: $('clear-filters-opt').checked,
    options: $('clear-options-opt').checked,
    advanced: $('clear-advanced-opt').checked,
    downloaded: $('clear-downloaded-opt').checked,
  };
  const cleared = [];
  for (const cat of Object.keys(sel)) {
    if (!sel[cat]) continue;
    try {
      localStorage.removeItem(STORAGE_KEYS[cat]);
    } catch {
      /* non-fatal */
    }
    cleared.push(cat);
  }
  if (sel.history) {
    activity = [];
    renderHistory();
  }
  if (sel.links) {
    links = [];
    renderLinks();
  }
  if (sel.stats) {
    renderFetchStatsIdle();
    $('download-stats-panel').hidden = true;
    setBadge('download-stats-badge', '', '');
  }
  if (sel.settings) {
    settings = { mode: ProxyMode.DIRECT, workerUrl: '', publicId: DEFAULT_PUBLIC_ID };
    syncProxyUi();
  }
  if (sel.filters) {
    filters = normalizeFilters();
    for (const cb of document.querySelectorAll('#filters input[data-filter]')) cb.checked = true;
    refreshView();
  }
  if (sel.options) {
    $('sort').value = 'hot';
    $('time').value = '';
    $('limit').value = '50';
  }
  if (sel.advanced) {
    advanced = loadAdvanced(); // storage cleared above → returns defaults
    applyAdvancedToUi();
    reconcileHistory(); // history cap / display window reset to defaults
  }
  if (sel.downloaded) {
    downloaded = new Set();
    refreshView(); // drop the "✓ saved" badges
  }
  closeClearModal();
  setStatus(
    cleared.length ? `Cleared: ${cleared.join(', ')}.` : 'Nothing selected to clear.',
    cleared.length ? 'ok' : 'error',
  );
}

/* ----------------------------- extension install modal ----------------------------- */

let extLastFocused = null;

function openExtInstallModal() {
  extLastFocused = document.activeElement;
  $('ext-install-modal').hidden = false;
  document.addEventListener('keydown', onExtModalKeydown);
  $('ext-zip-link').focus();
}

function closeExtInstallModal() {
  $('ext-install-modal').hidden = true;
  document.removeEventListener('keydown', onExtModalKeydown);
  if (extLastFocused && typeof extLastFocused.focus === 'function') extLastFocused.focus();
}

function onExtModalKeydown(e) {
  if (e.key === 'Escape') {
    closeExtInstallModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const f = $('ext-install-modal').querySelectorAll('a[href], button');
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function init() {
  document.title = `${APP.name} — ${APP.tagline}`;
  const footerVer = $('footer-version');
  if (footerVer) footerVer.textContent = `v${APP.version}`;
  $('search-form').addEventListener('submit', onSearch);
  $('select-all').addEventListener('click', () => {
    keptItems().forEach((i) => selected.add(i.id));
    refreshView();
  });
  $('select-none').addEventListener('click', () => {
    selected.clear();
    refreshView();
  });
  $('toggle-discarded').addEventListener('click', toggleDiscardedView);
  $('restore-all').addEventListener('click', restoreAll);
  $('download-selected').addEventListener('click', onDownloadSelected);
  $('download-zip').addEventListener('click', onDownloadZip);
  for (const r of document.querySelectorAll('input[name="proxy-mode"]')) {
    r.addEventListener('change', readProxyControls);
  }
  $('worker-url').addEventListener('input', readProxyControls);
  $('public-proxy').addEventListener('change', readProxyControls);
  for (const cb of document.querySelectorAll('#filters input[data-filter]')) {
    cb.checked = filters[cb.dataset.filter] !== false;
    cb.addEventListener('change', onFilterChange);
  }
  repairFilterGroups();
  applySavedOptions();
  for (const id of ['sort', 'time', 'limit']) {
    $(id).addEventListener('change', saveOptions);
  }
  $('limit').addEventListener('input', syncLimitField); // live ">100 auto-pagination" hint
  applyAdvancedToUi();
  for (const id of ['adv-delay', 'adv-timeout', 'adv-maxfile', 'adv-maxzip', 'adv-skip', 'adv-count-discarded', 'adv-autosave-links', 'adv-history-limit', 'adv-history-overwrite', 'adv-validate-magic', 'adv-validate-decode', 'adv-auto-paginate', 'adv-max-items', 'adv-page-delay']) {
    $(id).addEventListener('change', readAdvancedFromUi);
  }
  const savedStats = loadSavedStats();
  if (savedStats.fetch) renderFetchStats(savedStats.fetch, savedStats.fetchCum);
  else renderFetchStatsIdle();
  if (savedStats.download && savedStats.download.a) {
    renderDownloadStats(savedStats.download.a, { elapsedMs: savedStats.download.elapsedMs, skipped: savedStats.download.skipped });
  }
  renderHistory();
  renderLinks();
  $('link-add-btn').addEventListener('click', () => {
    const value = $('query').value.trim();
    if (!value) {
      setStatus('Type a link in the box first, then “Add current link”.', '');
      return;
    }
    const p = parseInput(value);
    addLink(value, p.ok ? p.label : value);
  });
  applyUiState();
  for (const id of COLLAPSIBLE_IDS) {
    const el = $(id);
    if (el) el.addEventListener('toggle', saveUiState);
  }
  $('clear-data-btn').addEventListener('click', openClearModal);
  $('clear-cancel').addEventListener('click', closeClearModal);
  $('clear-confirm').addEventListener('click', performClear);
  $('clear-all-opt').addEventListener('change', syncClearSelectAll);
  for (const el of document.querySelectorAll('#clear-modal [data-close]')) {
    el.addEventListener('click', closeClearModal);
  }
  const extInstallBtn = $('ext-install-btn');
  if (extInstallBtn) extInstallBtn.addEventListener('click', openExtInstallModal);
  for (const el of document.querySelectorAll('#ext-install-modal [data-ext-close]')) {
    el.addEventListener('click', closeExtInstallModal);
  }
  syncProxyUi();
  initExtensionMode();
}

/**
 * Detect the optional Pulldit Bridge extension and reveal the "Extension" mode when present.
 * If a saved setting selected extension mode but it is not installed, fall back to direct.
 */
function initExtensionMode() {
  const option = $('ext-mode-option');
  const hint = $('ext-install-hint');
  detectExtension().then(({ available, version }) => {
    if (available) {
      if (option) option.hidden = false;
      if (hint) hint.hidden = true;
      const verEl = $('ext-version');
      if (verEl) verEl.textContent = version ? `Detected ✓ v${version}` : 'Detected ✓';
      // The Extension radio lives inside the collapsible proxy panel — make it discoverable
      // by opening the panel and pointing the user there (until they actually adopt the mode).
      if (settings.mode !== ProxyMode.EXTENSION) {
        const panel = $('proxy-panel');
        if (panel && !panel.open) panel.open = true;
        setStatus('Pulldit extension detected ✓ — pick “Pulldit Extension” in the proxy panel for proxy-free ZIP from your own IP.', 'ok');
      }
    } else {
      if (option) option.hidden = true;
      if (hint) hint.hidden = false;
      if (settings.mode === ProxyMode.EXTENSION) {
        settings = { ...settings, mode: ProxyMode.DIRECT };
        saveSettings(settings);
        syncProxyUi();
        setStatus('The Pulldit extension is not installed — switched to Direct mode.', '');
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
