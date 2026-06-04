import { describe, it, expect } from 'vitest';
import { capList, describeEntry, MAX_HISTORY } from '../src/history.js';

describe('capList', () => {
  it('keeps the newest entries up to the cap', () => {
    const list = Array.from({ length: MAX_HISTORY + 20 }, (_, i) => ({ n: i }));
    const out = capList(list);
    expect(out).toHaveLength(MAX_HISTORY);
    expect(out[0].n).toBe(20); // oldest 20 dropped
    expect(out[out.length - 1].n).toBe(MAX_HISTORY + 19);
  });
  it('passes short lists through and tolerates non-arrays', () => {
    expect(capList([{ n: 1 }])).toHaveLength(1);
    expect(capList(null)).toEqual([]);
    expect(capList([1, 2, 3], 2)).toEqual([2, 3]);
  });
});

describe('describeEntry', () => {
  it('describes a successful fetch', () => {
    const d = describeEntry({ type: 'fetch', label: 'r/aww', status: 'success', found: 12 });
    expect(d.kind).toBe('good');
    expect(d.text).toBe('Fetched r/aww — 12 items');
  });
  it('describes a failed fetch', () => {
    const d = describeEntry({ type: 'fetch', label: 'r/x', status: 'timeout' });
    expect(d).toMatchObject({ kind: 'bad', text: 'Fetched r/x — timeout' });
  });
  it('describes a download and a zip', () => {
    expect(describeEntry({ type: 'download', label: 'cat.jpg' }).text).toBe('Downloaded cat.jpg');
    expect(describeEntry({ type: 'zip', added: 5, failed: 1, size: '12.0 MB' }).text)
      .toBe('ZIP: 5 files (1 failed) · 12.0 MB');
    expect(describeEntry({ type: 'zip', added: 1, failed: 0 }).kind).toBe('good');
  });
  it('describes discard/restore and unknown', () => {
    expect(describeEntry({ type: 'discard', label: 'x' }).icon).toBe('🗑');
    expect(describeEntry({ type: 'restore', label: 'x' }).icon).toBe('↺');
    expect(describeEntry({ type: 'whatever', label: 'z' }).text).toBe('z');
  });
});
