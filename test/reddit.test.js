import { describe, it, expect } from 'vitest';
import { parseInput, buildJsonUrl, normalizeListing, unescapeHtml, singleMediaItem, pickPreviewUrl, aggregatePages } from '../src/reddit.js';

describe('unescapeHtml', () => {
  it('decodes the entities reddit emits', () => {
    expect(unescapeHtml('a&amp;b=1&amp;c=2')).toBe('a&b=1&c=2');
    expect(unescapeHtml('x&lt;y&gt;z&quot;q&#39;p')).toBe('x<y>z"q\'p');
  });
  it('does not double-unescape (&amp;lt; -> &lt;, not <)', () => {
    expect(unescapeHtml('a&amp;lt;b')).toBe('a&lt;b');
    expect(unescapeHtml('q=1&amp;amp;r=2')).toBe('q=1&amp;r=2');
  });
});

describe('pickPreviewUrl', () => {
  const res = [
    { u: 'https://x/108.jpg', x: 108 },
    { u: 'https://x/320.jpg', x: 320 },
    { u: 'https://x/640.jpg', x: 640 },
    { u: 'https://x/1080.jpg', x: 1080 },
  ];
  it('picks the smallest preview at or above the target width (never the source)', () => {
    expect(pickPreviewUrl(res, 320)).toBe('https://x/320.jpg');
    expect(pickPreviewUrl(res, 200)).toBe('https://x/320.jpg');
    expect(pickPreviewUrl(res, 100)).toBe('https://x/108.jpg');
  });
  it('falls back to the largest available when all are smaller than target', () => {
    expect(pickPreviewUrl(res, 5000)).toBe('https://x/1080.jpg');
  });
  it('decodes HTML entities and handles empty input', () => {
    expect(pickPreviewUrl([{ u: 'https://x/a.jpg?w=1&amp;s=2', x: 400 }], 320)).toBe('https://x/a.jpg?w=1&s=2');
    expect(pickPreviewUrl([], 320)).toBeUndefined();
    expect(pickPreviewUrl(undefined)).toBeUndefined();
  });
});

describe('parseInput — media share link', () => {
  it('parses reddit.com/media?url=<i.redd.it> into a media descriptor', () => {
    const u = 'https://www.reddit.com/media?url=' + encodeURIComponent('https://i.redd.it/abc123.jpeg');
    expect(parseInput(u)).toMatchObject({ ok: true, kind: 'media', url: 'https://i.redd.it/abc123.jpeg' });
  });
  it('rejects a media wrapper pointing at a non-allowlisted host', () => {
    const u = 'https://www.reddit.com/media?url=' + encodeURIComponent('https://evil.example/x.jpg');
    expect(parseInput(u).ok).toBe(false);
  });
});

describe('singleMediaItem', () => {
  it('builds a normalized image item from an i.redd.it URL', () => {
    const it = singleMediaItem('https://i.redd.it/abc123.jpeg');
    expect(it).toMatchObject({ type: 'image', url: 'https://i.redd.it/abc123.jpeg', host: 'i.redd.it', ext: 'jpeg' });
    expect(it.thumbnail).toBe('https://i.redd.it/abc123.jpeg');
  });
  it('classifies video and gif, and drops video thumbnails', () => {
    expect(singleMediaItem('https://i.redd.it/v.mp4')).toMatchObject({ type: 'video', thumbnail: undefined });
    expect(singleMediaItem('https://i.redd.it/g.gif')).toMatchObject({ type: 'gif' });
  });
  it('returns null for a non-allowlisted host', () => {
    expect(singleMediaItem('https://evil.example/x.jpg')).toBeNull();
  });
});

describe('parseInput', () => {
  it('parses full post URLs', () => {
    const r = parseInput('https://www.reddit.com/r/aww/comments/abc123/some_title/');
    expect(r).toMatchObject({ ok: true, kind: 'post', postId: 'abc123' });
  });
  it('parses redd.it short links', () => {
    expect(parseInput('https://redd.it/xy12z')).toMatchObject({ ok: true, kind: 'post', postId: 'xy12z' });
  });
  it('parses subreddit URLs with sort + time', () => {
    const r = parseInput('https://www.reddit.com/r/pics/top/?t=week');
    expect(r).toMatchObject({ ok: true, kind: 'subreddit', subreddit: 'pics', sort: 'top', time: 'week' });
  });
  it('parses shorthand r/sub, bare sub, u/name', () => {
    expect(parseInput('r/EarthPorn')).toMatchObject({ ok: true, kind: 'subreddit', subreddit: 'EarthPorn' });
    expect(parseInput('aww')).toMatchObject({ ok: true, kind: 'subreddit', subreddit: 'aww' });
    expect(parseInput('u/spez')).toMatchObject({ ok: true, kind: 'user', username: 'spez' });
    expect(parseInput('https://www.reddit.com/user/spez/')).toMatchObject({ ok: true, kind: 'user', username: 'spez' });
  });
  it('rejects non-reddit URLs and garbage', () => {
    expect(parseInput('https://example.com/r/aww').ok).toBe(false);
    expect(parseInput('   ').ok).toBe(false);
    expect(parseInput('r/has invalid spaces!').ok).toBe(false);
    expect(parseInput('https://i.redd.it.evil.com/r/aww').ok).toBe(false);
  });
});

describe('buildJsonUrl', () => {
  it('builds subreddit listing with raw_json + limit + sort', () => {
    const u = buildJsonUrl({ ok: true, kind: 'subreddit', subreddit: 'aww' }, { sort: 'top', time: 'day', limit: 50 });
    expect(u).toContain('https://www.reddit.com/r/aww/top.json');
    expect(u).toContain('raw_json=1');
    expect(u).toContain('limit=50');
    expect(u).toContain('t=day');
  });
  it('builds post URL without a limit', () => {
    const u = buildJsonUrl({ ok: true, kind: 'post', postId: 'abc123' });
    expect(u).toBe('https://www.reddit.com/comments/abc123.json?raw_json=1');
  });
  it('builds user submitted URL', () => {
    const u = buildJsonUrl({ ok: true, kind: 'user', username: 'spez' });
    expect(u).toContain('/user/spez/submitted.json');
  });
  it('clamps limit into 1..100 and defaults bad sort to hot', () => {
    expect(buildJsonUrl({ ok: true, kind: 'subreddit', subreddit: 'x' }, { limit: 9999 })).toContain('limit=100');
    expect(buildJsonUrl({ ok: true, kind: 'subreddit', subreddit: 'x' }, { sort: 'bogus' })).toContain('/x/hot.json');
  });
});

const listing = (children, after = null) => ({ kind: 'Listing', data: { after, children } });
const t3 = (data) => ({ kind: 't3', data });

describe('normalizeListing', () => {
  it('extracts a direct i.redd.it image with full permalink', () => {
    const json = listing([
      t3({ id: 'p1', title: 'Cat', author: 'a', subreddit: 'aww', permalink: '/r/aww/comments/p1/cat/', over_18: false, url: 'https://i.redd.it/abc.jpg', post_hint: 'image' }),
    ], 't3_next');
    const { items, after } = normalizeListing(json);
    expect(after).toBe('t3_next');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'image', url: 'https://i.redd.it/abc.jpg', ext: 'jpg', permalink: 'https://www.reddit.com/r/aww/comments/p1/cat/' });
  });

  it('expands a native gallery into ordered items', () => {
    const json = listing([
      t3({
        id: 'g1', title: 'Gallery', subreddit: 'pics', permalink: '/r/pics/comments/g1/',
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'aaa' }, { media_id: 'bbb' }] },
        media_metadata: {
          aaa: { status: 'valid', m: 'image/jpg', s: { u: 'https://preview.redd.it/aaa.jpg?width=1&amp;s=z' } },
          bbb: { status: 'valid', m: 'image/png', s: { u: 'https://preview.redd.it/bbb.png?width=1&amp;s=z' } },
        },
      }),
    ]);
    const { items } = normalizeListing(json);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://i.redd.it/aaa.jpg');
    expect(items[1].url).toBe('https://i.redd.it/bbb.png');
    expect(items[0].thumbnail).toBe('https://preview.redd.it/aaa.jpg?width=1&s=z');
  });

  it('extracts reddit-hosted video and strips the query', () => {
    const json = listing([
      t3({ id: 'v1', title: 'Vid', subreddit: 'x', permalink: '/r/x/comments/v1/', is_video: true, media: { reddit_video: { fallback_url: 'https://v.redd.it/v1abc/DASH_720.mp4?source=fallback', is_gif: false } } }),
    ]);
    const { items } = normalizeListing(json);
    expect(items[0]).toMatchObject({ type: 'video', url: 'https://v.redd.it/v1abc/DASH_720.mp4', ext: 'mp4' });
  });

  it('maps imgur .gifv to .mp4 video', () => {
    const json = listing([t3({ id: 'i1', title: 'g', subreddit: 's', permalink: '/r/s/comments/i1/', url: 'https://i.imgur.com/abc.gifv' })]);
    const { items } = normalizeListing(json);
    expect(items[0]).toMatchObject({ type: 'video', url: 'https://i.imgur.com/abc.mp4' });
  });

  it('follows crossposts to the original media', () => {
    const json = listing([
      t3({ id: 'c1', title: 'X', subreddit: 's', permalink: '/r/s/comments/c1/', crosspost_parent_list: [
        { id: 'orig', title: 'O', subreddit: 'o', permalink: '/r/o/comments/orig/', url: 'https://i.redd.it/z.png', post_hint: 'image' },
      ] }),
    ]);
    const { items } = normalizeListing(json);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ postId: 'orig', url: 'https://i.redd.it/z.png' });
  });

  it('drops non-allowlisted and non-media posts', () => {
    const json = listing([
      t3({ id: 's1', title: 'self', subreddit: 'x', permalink: '/r/x/comments/s1/', is_self: true, url: 'https://www.reddit.com/r/x/comments/s1/' }),
      t3({ id: 'e1', title: 'ext', subreddit: 'x', permalink: '/r/x/comments/e1/', url: 'https://example.com/a.jpg', post_hint: 'image' }),
      t3({ id: 'a1', title: 'article', subreddit: 'x', permalink: '/r/x/comments/a1/', url: 'https://news.example.com/story' }),
    ]);
    expect(normalizeListing(json).items).toHaveLength(0);
  });

  it('reports fetch statistics', () => {
    const json = listing([
      t3({
        id: 'g1', title: 'Gallery', subreddit: 'pics', permalink: '/r/pics/comments/g1/',
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'aaa' }, { media_id: 'bbb' }] },
        media_metadata: {
          aaa: { status: 'valid', m: 'image/jpg', s: { u: 'https://preview.redd.it/aaa.jpg' } },
          bbb: { status: 'valid', m: 'image/png', s: { u: 'https://preview.redd.it/bbb.png' } },
        },
      }),
      t3({ id: 'v1', title: 'v', subreddit: 'x', permalink: '/r/x/comments/v1/', is_video: true, media: { reddit_video: { fallback_url: 'https://v.redd.it/v1/DASH_720.mp4?x=1' } } }),
      t3({ id: 's1', title: 'self', subreddit: 'x', permalink: '/r/x/comments/s1/', is_self: true, url: 'https://www.reddit.com/r/x/comments/s1/' }),
      t3({ id: 'i1', title: 'img', subreddit: 'x', permalink: '/r/x/comments/i1/', url: 'https://i.imgur.com/z.jpg', post_hint: 'image' }),
    ]);
    const { items, stats } = normalizeListing(json);
    expect(items).toHaveLength(4);
    expect(stats).toMatchObject({
      postsScanned: 4,
      postsWithMedia: 3,
      dropped: 1,
      galleries: 1,
      found: 4,
      nsfw: 0,
      capped: false,
    });
    expect(stats.byType).toEqual({ image: 3, gif: 0, video: 1 });
    expect(stats.bySource).toEqual({ reddit: 3, imgur: 1, other: 0 });
  });

  it('handles the comments-page array shape', () => {
    const arr = [
      listing([t3({ id: 'p1', title: 't', subreddit: 'a', permalink: '/r/a/comments/p1/', url: 'https://i.redd.it/x.jpg', post_hint: 'image' })]),
      listing([]),
    ];
    expect(normalizeListing(arr).items).toHaveLength(1);
  });
});

describe('aggregatePages', () => {
  const page = (items, counters = {}) => ({
    items,
    stats: { postsScanned: 0, postsWithMedia: 0, dropped: 0, galleries: 0, capped: false, ...counters },
  });
  const img = (id) => ({ id, type: 'image', host: 'i.redd.it' });

  it('merges pages, de-dupes by id, and sums post counters', () => {
    const p1 = page([img('a'), img('b')], { postsScanned: 2, postsWithMedia: 2, galleries: 1 });
    const p2 = page([img('b'), img('c')], { postsScanned: 2, postsWithMedia: 1, dropped: 1 });
    const { items, stats } = aggregatePages([p1, p2], 100);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']); // 'b' merged once
    expect(stats).toMatchObject({ postsScanned: 4, postsWithMedia: 3, dropped: 1, galleries: 1, found: 3, capped: false });
    expect(stats.byType).toEqual({ image: 3, gif: 0, video: 0 });
  });

  it('caps merged items and marks capped', () => {
    const { items, stats } = aggregatePages([page([img('a'), img('b'), img('c')])], 2);
    expect(items).toHaveLength(2);
    expect(stats.capped).toBe(true);
    expect(stats.found).toBe(2);
  });

  it('ORs the per-page capped flag', () => {
    expect(aggregatePages([page([img('a')], { capped: true })], 100).stats.capped).toBe(true);
  });

  it('tolerates empty / malformed input', () => {
    expect(aggregatePages([]).items).toEqual([]);
    expect(aggregatePages(null).items).toEqual([]);
    expect(aggregatePages([{}]).items).toEqual([]);
  });
});
