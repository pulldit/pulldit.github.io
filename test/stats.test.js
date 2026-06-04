import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  formatPercent,
  classifyError,
  aggregateDownload,
  summarizeItems,
  accumulateFetchStats,
  emptyFetchTotals,
} from '../src/stats.js';

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(10 * 1048576)).toBe('10 MB');
    expect(formatBytes(3 * 1024 * 1048576)).toBe('3.0 GB');
  });
  it('guards invalid input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats ms, seconds, minutes', () => {
    expect(formatDuration(350)).toBe('350 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(65000)).toBe('1m 5s');
  });
  it('guards invalid input', () => {
    expect(formatDuration(-5)).toBe('—');
  });
});

describe('formatSpeed', () => {
  it('formats bytes/sec', () => {
    expect(formatSpeed(1048576)).toBe('1.0 MB/s');
  });
  it('guards zero/invalid', () => {
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('rounds a ratio', () => {
    expect(formatPercent(1, 2)).toBe('50%');
    expect(formatPercent(3, 3)).toBe('100%');
  });
  it('guards zero total', () => {
    expect(formatPercent(0, 0)).toBe('—');
  });
});

describe('classifyError', () => {
  it('classifies categories', () => {
    expect(classifyError('The operation was aborted due to timeout')).toBe('timeout');
    expect(classifyError('file exceeds 200 byte limit')).toBe('too-large');
    expect(classifyError('download failed (HTTP 403)')).toBe('blocked');
    expect(classifyError('download failed (HTTP 502)')).toBe('network');
    expect(classifyError('something weird')).toBe('error');
  });
});

describe('aggregateDownload', () => {
  const results = [
    { ok: true, bytes: 1000, ms: 100 },
    { ok: true, bytes: 3000, ms: 200 },
    { ok: false, ms: 50, error: 'download failed (HTTP 403)' },
    { ok: false, ms: 25, error: 'file exceeds limit' },
  ];
  it('aggregates totals and reasons', () => {
    const a = aggregateDownload(results);
    expect(a.total).toBe(4);
    expect(a.success).toBe(2);
    expect(a.failed).toBe(2);
    expect(a.totalBytes).toBe(4000);
    expect(a.largest).toBe(3000);
    expect(a.byReason.blocked).toBe(1);
    expect(a.byReason['too-large']).toBe(1);
    expect(a.successRate).toBe(0.5);
  });
  it('computes avg speed from wall time when provided', () => {
    const a = aggregateDownload([{ ok: true, bytes: 2000, ms: 999 }], 1000);
    expect(a.avgSpeed).toBe(2000); // 2000 bytes / 1.0s
  });
  it('handles empty input', () => {
    const a = aggregateDownload([]);
    expect(a).toMatchObject({ total: 0, success: 0, failed: 0, totalBytes: 0, avgSpeed: 0 });
  });
});

describe('accumulateFetchStats', () => {
  const s1 = {
    status: 'success', elapsedMs: 100, bytes: 1000,
    postsScanned: 10, postsWithMedia: 6, dropped: 4, galleries: 1, found: 8,
    byType: { image: 5, gif: 2, video: 1 }, bySource: { reddit: 6, imgur: 2 }, nsfw: 1,
  };
  const s2 = {
    status: 'success', elapsedMs: 50, bytes: 500,
    postsScanned: 5, postsWithMedia: 3, dropped: 2, galleries: 0, found: 4,
    byType: { image: 1, gif: 1, video: 2 }, bySource: { reddit: 3, imgur: 1 }, nsfw: 0,
  };

  it('starts from a zeroed total', () => {
    expect(emptyFetchTotals()).toMatchObject({ fetches: 0, found: 0, bytes: 0, totalMs: 0 });
  });

  it('SUMS successive fetches instead of overwriting', () => {
    const a = accumulateFetchStats(undefined, s1);
    expect(a).toMatchObject({ fetches: 1, successes: 1, found: 8, images: 5, bytes: 1000, totalMs: 100, postsScanned: 10 });
    const b = accumulateFetchStats(a, s2);
    expect(b).toMatchObject({
      fetches: 2, successes: 2, failures: 0,
      found: 12, images: 6, gifs: 3, videos: 3, reddit: 9, imgur: 3, nsfw: 1,
      postsScanned: 15, postsWithMedia: 9, dropped: 6, galleries: 1,
      bytes: 1500, totalMs: 150,
    });
    // prev must not be mutated
    expect(a.fetches).toBe(1);
  });

  it('counts failures and timeouts without adding media counters', () => {
    let t = accumulateFetchStats(undefined, { status: 'failed', elapsedMs: 20, error: 'boom' });
    t = accumulateFetchStats(t, { status: 'timeout', elapsedMs: 25000 });
    expect(t).toMatchObject({ fetches: 2, successes: 0, failures: 1, timeouts: 1, found: 0, totalMs: 25020 });
  });

  it('coerces a malformed persisted total back to numbers', () => {
    const t = accumulateFetchStats({ fetches: 'x', found: undefined, bytes: null }, s1);
    expect(t).toMatchObject({ fetches: 1, found: 8, bytes: 1000 });
  });
});

describe('summarizeItems', () => {
  it('counts by type and source and nsfw', () => {
    const s = summarizeItems([
      { type: 'image', host: 'i.redd.it' },
      { type: 'video', host: 'v.redd.it', nsfw: true },
      { type: 'gif', host: 'i.imgur.com' },
      { type: 'image', host: 'i.imgur.com' },
    ]);
    expect(s).toMatchObject({ total: 4, image: 2, gif: 1, video: 1, reddit: 2, imgur: 2, nsfw: 1 });
  });
});
