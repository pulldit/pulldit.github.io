// Statistics helpers: human formatting, error classification, and aggregation of fetch
// and download results. Pure + fully unit-tested.

import { mediaSource } from './filters.js';

/** Human-readable byte size. @param {number} n */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Human-readable duration. @param {number} ms */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

/** Human-readable transfer speed. @param {number} bytesPerSec */
export function formatSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Percentage string. @param {number} part @param {number} total */
export function formatPercent(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

/**
 * Map an error message to a coarse failure category for stats grouping.
 * @param {string} message
 * @returns {'timeout'|'too-large'|'blocked'|'network'|'error'}
 */
export function classifyError(message) {
  const m = String(message || '').toLowerCase();
  if (/abort|timed?\s?out|timeout/.test(m)) return 'timeout';
  if (/too large|exceeds|size limit|413/.test(m)) return 'too-large';
  if (/403|forbidden|blocked|not allow|cors/.test(m)) return 'blocked';
  if (/http|network|failed|fetch|50\d|429|404|dns/.test(m)) return 'network';
  return 'error';
}

export const FAILURE_REASONS = Object.freeze(['timeout', 'too-large', 'blocked', 'network', 'error']);

/**
 * Aggregate per-file download results into summary statistics.
 * @param {Array<{ ok: boolean, bytes?: number, ms?: number, error?: string }>} results
 * @param {number} [wallMs] measured wall-clock elapsed; used for avg speed when provided
 */
export function aggregateDownload(results, wallMs) {
  const list = Array.isArray(results) ? results : [];
  const out = {
    total: list.length,
    success: 0,
    failed: 0,
    totalBytes: 0,
    totalMs: 0,
    largest: 0,
    byReason: { timeout: 0, 'too-large': 0, blocked: 0, network: 0, error: 0 },
  };
  for (const r of list) {
    out.totalMs += Number(r.ms) || 0;
    if (r.ok) {
      out.success += 1;
      const b = Number(r.bytes) || 0;
      out.totalBytes += b;
      if (b > out.largest) out.largest = b;
    } else {
      out.failed += 1;
      out.byReason[classifyError(r.error)] += 1;
    }
  }
  const speedMs = Number.isFinite(wallMs) && wallMs > 0 ? wallMs : out.totalMs;
  out.avgSpeed = speedMs > 0 ? out.totalBytes / (speedMs / 1000) : 0;
  out.successRate = out.total > 0 ? out.success / out.total : 0;
  return out;
}

/**
 * Summarize a set of media items by type and source.
 * @param {Array<object>} items
 */
export function summarizeItems(items) {
  const list = Array.isArray(items) ? items : [];
  const s = { total: list.length, image: 0, gif: 0, video: 0, reddit: 0, imgur: 0, other: 0, nsfw: 0 };
  for (const it of list) {
    if (it.type === 'image' || it.type === 'gif' || it.type === 'video') s[it.type] += 1;
    s[mediaSource(it)] += 1;
    if (it.nsfw) s.nsfw += 1;
  }
  return s;
}
