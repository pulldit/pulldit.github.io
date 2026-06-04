import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { b64ToBytes, detectExtension, extensionFetchJson, extensionFetchBytes } from '../src/bridge-client.js';

// A minimal fake `window` that round-trips postMessage through a settable responder, simulating
// the extension's content script. One shared instance so the module's listener stays attached.
let responder = () => null;
const listeners = [];
const fakeWin = {
  location: { origin: 'https://pulldit.github.io' },
  addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  removeEventListener: () => {},
  postMessage: (msg) => {
    Promise.resolve().then(() => {
      const reply = responder(msg);
      const arr = reply == null ? [] : (Array.isArray(reply) ? reply : [reply]);
      for (const r of arr) for (const fn of listeners) fn({ source: fakeWin, data: r });
    });
  },
};

beforeAll(() => { globalThis.window = fakeWin; });
afterAll(() => { delete globalThis.window; });
afterEach(() => { responder = () => null; });

const reply = (msg, extra) => ({ __pulldit: 'ext', id: msg.id, ...extra });

describe('b64ToBytes', () => {
  it('round-trips with btoa', () => {
    expect(Array.from(b64ToBytes(btoa('abc')))).toEqual([97, 98, 99]);
  });
  it('handles empty / nullish input', () => {
    expect(b64ToBytes('').length).toBe(0);
    expect(b64ToBytes(undefined).length).toBe(0);
  });
});

describe('detectExtension', () => {
  it('resolves available when the bridge answers ping', async () => {
    responder = (msg) => (msg.op === 'ping' ? reply(msg, { op: 'pong', version: '1.0.0' }) : null);
    await expect(detectExtension(200)).resolves.toEqual({ available: true, version: '1.0.0' });
  });
  it('resolves unavailable on timeout (no bridge)', async () => {
    responder = () => null;
    await expect(detectExtension(30)).resolves.toEqual({ available: false });
  });
});

describe('extensionFetchJson', () => {
  it('returns body + transport metadata', async () => {
    responder = (msg) => (msg.op === 'fetchJson'
      ? reply(msg, { ok: true, body: '{"x":1}', bytes: 7, httpOk: true, status: 200 })
      : null);
    await expect(extensionFetchJson('https://www.reddit.com/r/x.json'))
      .resolves.toEqual({ body: '{"x":1}', bytes: 7, httpOk: true, status: 200 });
  });
  it('rejects when the bridge reports failure', async () => {
    responder = (msg) => reply(msg, { ok: false, error: 'target not on allowlist' });
    await expect(extensionFetchJson('https://evil.example/x')).rejects.toThrow(/allowlist/);
  });
});

describe('extensionFetchBytes', () => {
  it('decodes base64 bytes from the bridge', async () => {
    responder = (msg) => reply(msg, { ok: true, b64: btoa('PNG'), contentType: 'image/png', httpOk: true, status: 200 });
    const out = await extensionFetchBytes('https://i.redd.it/a.png');
    expect(Array.from(out.bytes)).toEqual([80, 78, 71]);
    expect(out.contentType).toBe('image/png');
    expect(out.httpOk).toBe(true);
  });
});
