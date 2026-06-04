// UI controller. Wires the DOM to the pure modules. All rendering uses createElement +
// textContent (never innerHTML with data), matching the strict CSP. No inline handlers.

import { APP, LIMITS } from './config.js';
import { parseInput, buildJsonUrl, normalizeListing } from './reddit.js';
import { fetchJson, canZip, resolveProxy, ProxyMode } from './proxy.js';
import { downloadSingle, downloadZip } from './download.js';
import { applyFilters, normalizeFilters } from './filters.js';
import {
  formatBytes, formatDuration, formatSpeed, formatPercent, classifyError, aggregateDownload,
} from './stats.js';
import { capList, describeEntry, HISTORY_KEY } from './history.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'rd.settings.v1';
const FILTERS_KEY = 'rd.filters.v1';
const OPTIONS_KEY = 'rd.options.v1';
const STATS_KEY = 'rd.stats.v1';
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

/* ----------------------------- settings ----------------------------- */

function loadSettings() {
  const fallback = { mode: ProxyMode.DIRECT, workerUrl: '', publicId: 'corsproxy' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      mode: [ProxyMode.DIRECT, ProxyMode.WORKER, ProxyMode.PUBLIC].includes(parsed.mode) ? parsed.mode : ProxyMode.DIRECT,
      workerUrl: typeof parsed.workerUrl === 'string' ? parsed.workerUrl : '',
      publicId: typeof parsed.publicId === 'string' ? parsed.publicId : 'corsproxy',
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
  const labels = { direct: 'Direct', worker: 'Worker', public: 'Public proxy' };
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
  if (Number.isFinite(lim) && lim >= 1 && lim <= 100) $('limit').value = String(lim);
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

function addHistory(entry) {
  activity = capList([...activity, { ...entry, t: Date.now() }]);
  saveActivity();
  renderHistory();
}

function clearHistory() {
  activity = [];
  saveActivity();
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
  $('history-count').textContent = String(activity.length);
  if (activity.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'history-empty';
    empty.textContent = 'No activity yet.';
    list.appendChild(empty);
    return;
  }
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const e = activity[i];
    const d = describeEntry(e);
    const li = document.createElement('li');
    li.className = 'history-item' + (d.kind === 'good' || d.kind === 'bad' || d.kind === 'warn' ? ' ' + d.kind : '');
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatTime(e.t);
    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.textContent = d.icon;
    const text = document.createElement('span');
    text.className = 'history-text';
    text.textContent = d.text;
    li.appendChild(time);
    li.appendChild(icon);
    li.appendChild(text);
    list.appendChild(li);
  }
}

function itemTitle(id) {
  const it = allItems.find((i) => i.id === id);
  return it ? it.title || it.id : id;
}

function onFilterChange() {
  const next = {};
  for (const cb of document.querySelectorAll('#filters input[data-filter]')) {
    next[cb.dataset.filter] = cb.checked;
  }
  filters = normalizeFilters(next);
  saveFilters();
  refreshView();
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

/* ----------------------------- fetching ----------------------------- */

async function onSearch(event) {
  event.preventDefault();
  if (busy) return;

  const parsed = parseInput($('query').value);
  if (!parsed.ok) {
    setStatus('Could not understand that input: ' + parsed.reason, 'error');
    return;
  }

  const opts = {
    limit: Number($('limit').value) || LIMITS.defaultListingLimit,
    sort: $('sort').value,
    time: $('time').value || undefined,
  };
  const jsonUrl = buildJsonUrl(parsed, opts);

  setBusy(true);
  setStatus(`Fetching ${parsed.label}…`);
  const meta = {};
  const t0 = perf();
  try {
    const json = await fetchJson(jsonUrl, settings, { stats: meta });
    const elapsedMs = perf() - t0;
    const { items, stats } = normalizeListing(json);
    allItems = items;
    selected.clear();
    discarded.clear();
    showDiscarded = false;
    renderFetchStats({ status: 'success', elapsedMs, bytes: meta.bytes, ...stats });
    refreshView();
    addHistory({ type: 'fetch', label: parsed.label, status: 'success', found: items.length });
    if (items.length === 0) {
      setStatus('No downloadable media found in this listing.', '');
    } else {
      setStatus(`Found ${items.length} media item${items.length === 1 ? '' : 's'}.`, 'ok');
    }
  } catch (err) {
    const elapsedMs = perf() - t0;
    const reason = classifyError(err?.message || err);
    renderFetchStats({
      status: reason === 'timeout' ? 'timeout' : 'failed',
      elapsedMs,
      bytes: meta.bytes,
      error: err?.message ? String(err.message) : String(err),
    });
    addHistory({ type: 'fetch', label: parsed.label, status: reason });
    handleFetchError(err);
  } finally {
    setBusy(false);
  }
}

function handleFetchError(err) {
  const msg = err?.message ? String(err.message) : String(err);
  if (settings.mode === ProxyMode.DIRECT && /JSON|HTTP|Failed|fetch|network/i.test(msg)) {
    setStatus(
      'Reddit refused the direct request (it sometimes blocks anonymous browser requests). ' +
        'Open “Proxy & download mode” and try a proxy.',
      'error',
    );
  } else {
    setStatus('Fetch failed: ' + msg, 'error');
  }
}

/* ----------------------------- statistics rendering ----------------------------- */

function buildStatGrid(container, title, entries) {
  container.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'statsbox-title';
  heading.textContent = title;
  container.appendChild(heading);

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
  container.appendChild(grid);
}

function renderFetchStatsIdle() {
  buildStatGrid($('fetch-stats'), 'Fetch statistics', [
    { label: 'Status', value: 'Idle' },
    { label: 'Tip', value: 'Run a fetch — statistics will appear here.', wide: true },
  ]);
}

function renderFetchStats(s) {
  const box = $('fetch-stats');
  box.hidden = false;
  const entries = [];
  if (s.status === 'success') entries.push({ label: 'Status', value: 'Success', kind: 'good' });
  else if (s.status === 'timeout') entries.push({ label: 'Status', value: 'Timeout', kind: 'bad' });
  else entries.push({ label: 'Status', value: 'Failed', kind: 'bad' });

  entries.push({ label: 'Time', value: formatDuration(s.elapsedMs) });
  if (Number.isFinite(s.bytes)) entries.push({ label: 'Listing size', value: formatBytes(s.bytes) });

  if (s.status === 'success') {
    entries.push({ label: 'Posts scanned', value: String(s.postsScanned ?? 0) });
    entries.push({ label: 'With media', value: String(s.postsWithMedia ?? 0) });
    entries.push({ label: 'No media', value: String(s.dropped ?? 0) });
    entries.push({ label: 'Galleries', value: String(s.galleries ?? 0) });
    entries.push({ label: 'Media found', value: String(s.found ?? 0), kind: 'accent' });
    entries.push({ label: 'Images', value: String(s.byType?.image ?? 0) });
    entries.push({ label: 'GIFs', value: String(s.byType?.gif ?? 0) });
    entries.push({ label: 'Videos', value: String(s.byType?.video ?? 0) });
    entries.push({ label: 'Reddit', value: String(s.bySource?.reddit ?? 0) });
    entries.push({ label: 'imgur', value: String(s.bySource?.imgur ?? 0) });
    if (s.nsfw) entries.push({ label: 'NSFW', value: String(s.nsfw), kind: 'warn' });
    if (s.capped) entries.push({ label: 'Capped at', value: String(LIMITS.maxItems), kind: 'warn' });
  } else if (s.error) {
    entries.push({ label: 'Error', value: s.error, wide: true });
  }
  buildStatGrid(box, 'Fetch statistics', entries);
  saveStatsPatch({ fetch: s });
}

function renderDownloadStats(a, opts = {}) {
  const box = $('download-stats');
  box.hidden = false;
  const entries = [];
  if (opts.live) {
    entries.push({ label: 'Progress', value: `${a.processed} / ${a.total}` });
    entries.push({ label: 'Succeeded', value: String(a.success), kind: 'good' });
    if (a.failed) entries.push({ label: 'Failed', value: String(a.failed), kind: 'bad' });
    entries.push({ label: 'Downloaded', value: formatBytes(a.totalBytes), kind: 'accent' });
    entries.push({ label: 'Speed', value: formatSpeed(a.avgSpeed) });
    buildStatGrid(box, 'Downloading…', entries);
    return;
  }
  entries.push({ label: 'Total', value: String(a.total) });
  entries.push({ label: 'Succeeded', value: String(a.success), kind: 'good' });
  entries.push({ label: 'Failed', value: String(a.failed), kind: a.failed ? 'bad' : '' });
  entries.push({ label: 'Success rate', value: formatPercent(a.success, a.total) });
  entries.push({ label: 'Downloaded', value: formatBytes(a.totalBytes), kind: 'accent' });
  entries.push({ label: 'Largest file', value: formatBytes(a.largest) });
  if (Number.isFinite(opts.elapsedMs)) entries.push({ label: 'Elapsed', value: formatDuration(opts.elapsedMs) });
  entries.push({ label: 'Avg speed', value: formatSpeed(a.avgSpeed) });
  for (const reason of Object.keys(a.byReason)) {
    if (a.byReason[reason] > 0) entries.push({ label: reason, value: String(a.byReason[reason]), kind: 'bad' });
  }
  buildStatGrid(box, 'Download statistics', entries);
  saveStatsPatch({ download: { a, elapsedMs: opts.elapsedMs } });
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

  const thumbUrl = item.thumbnail || (item.type !== 'video' ? item.url : '');
  if (thumbUrl) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = item.title || '';
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

async function onDownloadOne(item, btn) {
  if (busy) return;
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const r = await downloadSingle(item, settings);
    btn.textContent = r.opened ? 'Opened' : 'Saved ✓';
    addHistory({ type: 'download', label: item.title || item.id });
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

async function onDownloadSelected() {
  if (busy) return;
  const items = selectedItems();
  if (!items.length) return;
  if (resolveProxy(settings).mode === ProxyMode.DIRECT) {
    setStatus(`Opening ${items.length} file(s) in new tabs (Direct mode). Allow pop-ups, or use a proxy + ZIP.`, '');
  }
  setBusy(true);
  let ok = 0;
  for (const item of items) {
    try {
      await downloadSingle(item, settings);
      ok += 1;
    } catch {
      /* keep going */
    }
  }
  setBusy(false);
  setStatus(`Processed ${ok}/${items.length} download(s).`, ok ? 'ok' : 'error');
}

async function onDownloadZip() {
  if (busy || !canZip(settings)) return;
  const items = selectedItems();
  if (!items.length) {
    setStatus('Nothing to zip.', 'error');
    return;
  }
  setBusy(true);
  showProgress(true);
  dlStart = perf();
  try {
    const result = await downloadZip(items, settings, {
      zipName: `pulldit-${items.length}.zip`,
      onProgress: onZipProgress,
    });
    renderDownloadStats(aggregateDownload(result.files, result.elapsedMs), { elapsedMs: result.elapsedMs });
    addHistory({ type: 'zip', added: result.added, failed: result.failed.length, size: formatBytes(result.totalBytes) });
    const failedNote = result.failed.length ? ` (${result.failed.length} failed)` : '';
    setStatus(`ZIP ready: ${result.added} file(s)${failedNote}.`, 'ok');
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
  if (e.phase === 'fetch') {
    bar.style.width = Math.round((e.index / e.total) * 90) + '%';
    label.textContent = `Downloading ${e.index + 1} / ${e.total}…`;
  } else if (e.phase === 'fetched') {
    const done = e.index + 1;
    bar.style.width = Math.round((done / e.total) * 90) + '%';
    const elapsed = perf() - dlStart;
    const speed = elapsed > 0 ? e.totalBytes / (elapsed / 1000) : 0;
    renderDownloadStats(
      { processed: done, total: e.total, success: e.okCount, failed: done - e.okCount, totalBytes: e.totalBytes, avgSpeed: speed },
      { live: true },
    );
  } else if (e.phase === 'compress') {
    bar.style.width = 90 + Math.round((e.percent || 0) * 0.1) + '%';
    label.textContent = 'Packing ZIP…';
  } else if (e.phase === 'zip') {
    label.textContent = 'Packing ZIP…';
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

function init() {
  document.title = `${APP.name} — ${APP.tagline}`;
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
  applySavedOptions();
  for (const id of ['sort', 'time', 'limit']) {
    $(id).addEventListener('change', saveOptions);
  }
  const savedStats = loadSavedStats();
  if (savedStats.fetch) renderFetchStats(savedStats.fetch);
  else renderFetchStatsIdle();
  if (savedStats.download && savedStats.download.a) {
    renderDownloadStats(savedStats.download.a, { elapsedMs: savedStats.download.elapsedMs });
  }
  renderHistory();
  $('clear-history').addEventListener('click', clearHistory);
  syncProxyUi();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
