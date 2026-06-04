import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProxyMode,
  normalizeWorkerUrl,
  getPublicProxy,
  resolveProxy,
  canZip,
  buildProxiedUrl,
  fetchJson,
  fetchBytes,
  classifyBlockText,
} from '../src/proxy.js';

afterEach(() => vi.unstubAllGlobals());

describe('normalizeWorkerUrl', () => {
  it('accepts a public https worker and upgrades scheme', () => {
    expect(normalizeWorkerUrl('http://rd.example.workers.dev/')).toBe('https://rd.example.workers.dev/');
  });
  it('rejects localhost / private / non-http', () => {
    expect(normalizeWorkerUrl('http://localhost:8787')).toBeNull();
    expect(normalizeWorkerUrl('https://192.168.0.1/')).toBeNull();
    expect(normalizeWorkerUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeWorkerUrl('')).toBeNull();
  });
});

describe('resolveProxy / canZip', () => {
  it('direct mode disables zip', () => {
    expect(resolveProxy({ mode: 'direct' })).toMatchObject({ ok: true, zip: false });
    expect(canZip({ mode: 'direct' })).toBe(false);
  });
  it('worker mode enables zip when url is valid', () => {
    expect(canZip({ mode: 'worker', workerUrl: 'https://w.example.workers.dev' })).toBe(true);
    expect(resolveProxy({ mode: 'worker', workerUrl: 'nope' }).ok).toBe(false);
  });
  it('public mode enables zip for known proxies only', () => {
    expect(canZip({ mode: 'public', publicId: 'allorigins' })).toBe(true);
    expect(canZip({ mode: 'public', publicId: 'codetabs' })).toBe(true);
    expect(resolveProxy({ mode: 'public', publicId: 'corsproxy' }).ok).toBe(false); // removed
    expect(resolveProxy({ mode: 'public', publicId: 'does-not-exist' }).ok).toBe(false);
  });
  it('defaults to direct', () => {
    expect(resolveProxy({}).mode).toBe(ProxyMode.DIRECT);
  });
});

describe('buildProxiedUrl', () => {
  const target = 'https://i.redd.it/abc.jpg';
  it('passes through unchanged in direct mode', () => {
    expect(buildProxiedUrl(target, { mode: 'direct' })).toBe(target);
  });
  it('wraps with the worker url= convention', () => {
    const out = buildProxiedUrl(target, { mode: 'worker', workerUrl: 'https://w.example.workers.dev/' });
    expect(out).toBe('https://w.example.workers.dev/?url=' + encodeURIComponent(target));
  });
  it('appends with & when worker base already has a query', () => {
    const out = buildProxiedUrl(target, { mode: 'worker', workerUrl: 'https://w.example.workers.dev/?k=1' });
    expect(out).toContain('?k=1&url=');
  });
  it('uses the public proxy builder', () => {
    expect(buildProxiedUrl(target, { mode: 'public', publicId: 'allorigins' }))
      .toBe('https://api.allorigins.win/raw?url=' + encodeURIComponent(target));
    expect(getPublicProxy('codetabs').build(target))
      .toBe('https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(target));
  });
  it('returns null for invalid settings', () => {
    expect(buildProxiedUrl(target, { mode: 'worker', workerUrl: 'localhost' })).toBeNull();
  });
});

describe('fetchJson', () => {
  it('routes through the selected proxy and parses JSON', async () => {
    const payload = { data: { children: [], after: null } };
    const spy = vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', spy);
    const out = await fetchJson('https://www.reddit.com/r/aww/hot.json?raw_json=1', { mode: 'public', publicId: 'allorigins' });
    expect(out).toEqual(payload);
    expect(spy.mock.calls[0][0]).toContain('https://api.allorigins.win/raw?url=');
  });
  it('reports the cap-stats bytes and winning proxy id', async () => {
    const payload = { data: { children: [], after: null } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })));
    const stats = {};
    await fetchJson('https://www.reddit.com/r/aww/hot.json', { mode: 'public', publicId: 'allorigins' }, { stats });
    expect(stats.proxyId).toBe('allorigins');
    expect(stats.bytes).toBeGreaterThan(0);
  });
  it('automatically falls back to the next proxy when the first is blocked', async () => {
    const payload = { data: { children: [], after: null } };
    const spy = vi.fn(async (url) => {
      if (String(url).includes('allorigins')) return new Response('<html>whoa there</html>', { headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', spy);
    const stats = {};
    const out = await fetchJson('https://www.reddit.com/r/aww/hot.json', { mode: 'public', publicId: 'allorigins' }, { stats });
    expect(out).toEqual(payload);
    expect(stats.proxyId).toBe('codetabs'); // the fallback won
    expect(spy.mock.calls.length).toBe(2);
  });
  it('throws an aggregated error when every public proxy fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Blocked</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(fetchJson('https://www.reddit.com/r/aww/hot.json', { mode: 'public', publicId: 'allorigins' }))
      .rejects.toThrow(/All public proxies failed/);
  });
  it('classifies a blocked non-JSON body (direct mode)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Blocked</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(fetchJson('https://www.reddit.com/r/aww/hot.json', { mode: 'direct' })).rejects.toThrow(/block/i);
  });
  it('throws on HTTP error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    await expect(fetchJson('https://www.reddit.com/r/aww.json', { mode: 'direct' })).rejects.toThrow(/429/);
  });
});

describe('classifyBlockText', () => {
  it('detects rate limiting', () => {
    expect(classifyBlockText('<html><title>Too Many Requests</title></html>')).toMatch(/429|rate/i);
  });
  it('detects an HTML block page', () => {
    expect(classifyBlockText('<!doctype html><body>whoa there</body>')).toMatch(/block/i);
    expect(classifyBlockText('Forbidden')).toMatch(/block/i);
  });
  it('falls back to a generic not-JSON message', () => {
    expect(classifyBlockText('garbage')).toMatch(/did not return JSON/i);
  });
});

describe('fetchBytes', () => {
  it('refuses in direct mode', async () => {
    await expect(fetchBytes('https://i.redd.it/a.jpg', { mode: 'direct' })).rejects.toThrow(/requires a proxy/);
  });
  it('returns bytes + content-type via proxy', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'image/jpeg' } })));
    const out = await fetchBytes('https://i.redd.it/a.jpg', { mode: 'public', publicId: 'codetabs' });
    expect(Array.from(out.bytes)).toEqual([1, 2, 3, 4]);
    expect(out.contentType).toBe('image/jpeg');
  });
  it('enforces the size cap via content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0]), { headers: { 'content-length': '999999999' } })));
    await expect(fetchBytes('https://i.redd.it/a.jpg', { mode: 'public', publicId: 'codetabs' }, { maxBytes: 10 }))
      .rejects.toThrow(/limit/);
  });
  it('enforces the size cap while streaming when no content-length', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(100), { headers: { 'content-type': 'image/png' } })));
    await expect(fetchBytes('https://i.redd.it/a.jpg', { mode: 'public', publicId: 'codetabs' }, { maxBytes: 10 }))
      .rejects.toThrow(/limit/);
  });
});
