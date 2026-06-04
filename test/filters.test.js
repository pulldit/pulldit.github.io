import { describe, it, expect } from 'vitest';
import { mediaSource, normalizeFilters, applyFilters, DEFAULT_FILTERS } from '../src/filters.js';

const item = (type, host) => ({ type, host });

describe('mediaSource', () => {
  it('classifies hosts', () => {
    expect(mediaSource({ host: 'i.redd.it' })).toBe('reddit');
    expect(mediaSource({ host: 'v.redd.it' })).toBe('reddit');
    expect(mediaSource({ host: 'a.thumbs.redditmedia.com' })).toBe('reddit');
    expect(mediaSource({ host: 'i.imgur.com' })).toBe('imgur');
    expect(mediaSource({ host: 'imgur.com' })).toBe('imgur');
    expect(mediaSource({ host: 'example.com' })).toBe('other');
    expect(mediaSource({})).toBe('other');
  });
});

describe('normalizeFilters', () => {
  it('fills defaults and ignores unknown keys', () => {
    expect(normalizeFilters()).toEqual(DEFAULT_FILTERS);
    expect(normalizeFilters({ video: false, bogus: true })).toEqual({ ...DEFAULT_FILTERS, video: false });
  });
  it('ignores non-boolean values', () => {
    expect(normalizeFilters({ image: 'no' })).toEqual(DEFAULT_FILTERS);
  });
});

describe('applyFilters', () => {
  const items = [
    item('image', 'i.redd.it'),
    item('gif', 'i.redd.it'),
    item('video', 'v.redd.it'),
    item('image', 'i.imgur.com'),
    item('video', 'i.imgur.com'),
  ];

  it('passes everything through by default', () => {
    expect(applyFilters(items)).toHaveLength(5);
  });
  it('filters by media type', () => {
    expect(applyFilters(items, { video: false })).toHaveLength(3);
    expect(applyFilters(items, { image: false, gif: false })).toHaveLength(2);
  });
  it('filters by source', () => {
    expect(applyFilters(items, { imgur: false })).toHaveLength(3);
    expect(applyFilters(items, { reddit: false })).toHaveLength(2);
  });
  it('combines type and source filters', () => {
    expect(applyFilters(items, { imgur: false, video: false })).toHaveLength(2);
  });
  it('returns nothing when all types are off', () => {
    expect(applyFilters(items, { image: false, gif: false, video: false })).toHaveLength(0);
  });
});
