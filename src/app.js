// UI controller. Wires the DOM to the pure modules. All rendering uses createElement +
// textContent (never innerHTML with data), matching the strict CSP. No inline handlers.

import { APP, LIMITS } from './config.js';
import { parseInput, buildJsonUrl, normalizeListing } from './reddit.js';
import { fetchJson } from './proxy.js';
import { canZip, resolveProxy, ProxyMode } from './proxy.js';
import { downloadSingle, downloadZip } from './download.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'rd.settings.v1';

/** @type {Array<object>} */
let currentItems = [];
/** @type {Set<string>} */
const selected = new Set();
let busy = false;

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

/** Reflect current settings into the proxy controls + ZIP availability. */
function syncProxyUi() {
  for (const r of document.querySelectorAll('input[name="proxy-mode"]')) {
    r.checked = r.value === settings.mode;
  }
  $('worker-url').value = settings.workerUrl;
  $('public-proxy').value = settings.publicId;

  const resolved = resolveProxy(settings);
  const badge = $('proxy-badge');
  const labels = { direct: 'Direct', worker: 'Worker', public: 'Public proxy' };
  badge.textContent = resolved.ok ? labels[settings.mode] : 'Invalid config';
  badge.classList.toggle('tag', false);

  const zipOk = canZip(settings) && currentItems.length > 0;
  const zipBtn = $('download-zip');
  zipBtn.disabled = !zipOk || busy;
  zipBtn.title = canZip(settings)
    ? 'Download all selected as one ZIP'
    : 'ZIP needs a proxy mode (Direct mode cannot read media bytes)';
}

function readProxyControls() {
  const mode = document.querySelector('input[name="proxy-mode"]:checked')?.value || ProxyMode.DIRECT;
  settings = {
    mode,
    workerUrl: $('worker-url').value.trim(),
    publicId: $('public-proxy').value,
  };
  saveSettings(settings);
  syncProxyUi();
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
  try {
    const json = await fetchJson(jsonUrl, settings);
    const { items } = normalizeListing(json);
    currentItems = items;
    selected.clear();
    renderGrid();
    if (items.length === 0) {
      setStatus('No downloadable media found in this listing.', '');
    } else {
      setStatus(`Found ${items.length} media item${items.length === 1 ? '' : 's'}.`, 'ok');
    }
  } catch (err) {
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

/* ----------------------------- rendering ----------------------------- */

const TYPE_ICON = { image: '🖼', gif: 'GIF', video: '▶' };

function renderGrid() {
  const grid = $('grid');
  grid.replaceChildren();
  const section = $('results-section');
  section.hidden = currentItems.length === 0;

  for (const item of currentItems) {
    grid.appendChild(renderCard(item));
  }
  updateCount();
  syncProxyUi();
}

function renderCard(item) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = item.id;

  const media = document.createElement('div');
  media.className = 'card-media';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'card-check';
  check.checked = selected.has(item.id);
  check.setAttribute('aria-label', 'Select ' + (item.title || item.id));
  check.addEventListener('change', () => toggleSelect(item.id, check.checked, li));
  media.appendChild(check);

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
  updateCount();
}

function updateCount() {
  const n = currentItems.length;
  const sel = selected.size;
  $('count').textContent = `${n} item${n === 1 ? '' : 's'}${sel ? ` · ${sel} selected` : ''}`;
}

function selectedItems() {
  const set = selected.size ? selected : null;
  return set ? currentItems.filter((i) => set.has(i.id)) : currentItems;
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
      ok++;
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
    setStatus('Nothing selected to zip.', 'error');
    return;
  }
  setBusy(true);
  showProgress(true);
  try {
    const result = await downloadZip(items, settings, {
      zipName: `reddit-media-${items.length}.zip`,
      onProgress: onZipProgress,
    });
    const failedNote = result.failed.length ? ` (${result.failed.length} failed)` : '';
    setStatus(`ZIP ready: ${result.added} file(s) added${failedNote}.`, 'ok');
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
    const pct = Math.round(((e.index + 1) / e.total) * 90);
    bar.style.width = pct + '%';
    label.textContent = `Downloading ${e.index + 1} / ${e.total}…`;
  } else if (e.phase === 'compress') {
    bar.style.width = (90 + Math.round((e.percent || 0) * 0.1)) + '%';
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
  syncProxyUi();
}

function init() {
  document.title = `${APP.name} — ${APP.tagline}`;
  $('search-form').addEventListener('submit', onSearch);
  $('select-all').addEventListener('click', () => {
    currentItems.forEach((i) => selected.add(i.id));
    renderGrid();
  });
  $('select-none').addEventListener('click', () => {
    selected.clear();
    renderGrid();
  });
  $('download-selected').addEventListener('click', onDownloadSelected);
  $('download-zip').addEventListener('click', onDownloadZip);
  for (const r of document.querySelectorAll('input[name="proxy-mode"]')) {
    r.addEventListener('change', readProxyControls);
  }
  $('worker-url').addEventListener('input', readProxyControls);
  $('public-proxy').addEventListener('change', readProxyControls);
  syncProxyUi();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
