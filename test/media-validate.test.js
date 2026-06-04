import { describe, it, expect, afterEach } from 'vitest';
import { sniffBytes, validateBytes, decodeProbe } from '../src/media-validate.js';

/** Build a Uint8Array from a list of byte values, padded with zeros to `len`. */
const bytesOf = (arr, len = arr.length) => {
  const u = new Uint8Array(len);
  u.set(arr.slice(0, len));
  return u;
};
/** Build a Uint8Array from an ASCII/Latin-1 string. */
const strOf = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff));

describe('sniffBytes — known media → ok', () => {
  const cases = [
    ['jpeg', [0xff, 0xd8, 0xff, 0xe0], 'image'],
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image'],
    ['gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'gif'],
    ['bmp', [0x42, 0x4d, 0x00, 0x00], 'image'],
    ['webm', [0x1a, 0x45, 0xdf, 0xa3], 'video'],
  ];
  for (const [format, sig, kind] of cases) {
    it(`accepts ${format}`, () => {
      const r = sniffBytes(bytesOf(sig, 32));
      expect(r.verdict).toBe('ok');
      expect(r.format).toBe(format);
      expect(r.kind).toBe(kind);
    });
  }

  it('accepts WebP via the RIFF container', () => {
    const u = bytesOf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 32); // RIFF....WEBP
    expect(sniffBytes(u)).toMatchObject({ verdict: 'ok', format: 'webp', kind: 'image' });
  });

  it('accepts MP4 (ftyp isom) as video', () => {
    const u = bytesOf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 32); // ....ftypisom
    expect(sniffBytes(u)).toMatchObject({ verdict: 'ok', format: 'mp4', kind: 'video' });
  });

  it('classifies an AVIF ftyp brand as an image', () => {
    const u = bytesOf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 32); // ....ftypavif
    expect(sniffBytes(u)).toMatchObject({ verdict: 'ok', format: 'heif', kind: 'image' });
  });
});

describe('sniffBytes — dangerous / non-media → reject', () => {
  const cases = [
    ['exe', [0x4d, 0x5a, 0x90, 0x00]],
    ['elf', [0x7f, 0x45, 0x4c, 0x46]],
    ['macho', [0xca, 0xfe, 0xba, 0xbe]],
    ['pdf', [0x25, 0x50, 0x44, 0x46]],
    ['zip', [0x50, 0x4b, 0x03, 0x04]],
    ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['gzip', [0x1f, 0x8b, 0x08]],
    ['script', [0x23, 0x21, 0x2f, 0x62]],
  ];
  for (const [format, sig] of cases) {
    it(`rejects ${format}`, () => {
      const r = sniffBytes(bytesOf(sig, 32));
      expect(r.verdict).toBe('reject');
      expect(r.format).toBe(format);
    });
  }

  it('rejects an HTML error/block page', () => {
    expect(sniffBytes(strOf('<!DOCTYPE html><html><head>'))).toMatchObject({ verdict: 'reject', format: 'text' });
    expect(sniffBytes(strOf('  <html lang="en">'))).toMatchObject({ verdict: 'reject', format: 'text' });
  });

  it('rejects a JSON error wrapper', () => {
    expect(sniffBytes(strOf('{"error":"blocked"}'))).toMatchObject({ verdict: 'reject', format: 'text' });
  });

  it('rejects a non-AV RIFF container (e.g. WAV)', () => {
    const u = bytesOf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], 32); // RIFF....WAVE
    expect(sniffBytes(u)).toMatchObject({ verdict: 'reject', format: 'riff' });
  });
});

describe('sniffBytes — unknown → uncertain', () => {
  it('marks unrecognized bytes uncertain', () => {
    expect(sniffBytes(bytesOf([0x12, 0x34, 0x56, 0x78], 32))).toMatchObject({ verdict: 'uncertain', kind: 'unknown' });
  });
  it('treats empty input as uncertain', () => {
    expect(sniffBytes(new Uint8Array(0)).verdict).toBe('uncertain');
    expect(sniffBytes(null).verdict).toBe('uncertain');
  });
});

describe('validateBytes — Check 1 / Check 2 decision logic', () => {
  afterEach(() => {
    delete globalThis.createImageBitmap;
    delete globalThis.Blob;
  });

  it('passes everything when magic (Check 1) is off', async () => {
    const r = await validateBytes(bytesOf([0x4d, 0x5a], 8), { magic: false });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('skipped');
  });

  it('rejects a dangerous payload under Check 1', async () => {
    const r = await validateBytes(bytesOf([0x4d, 0x5a, 0x90], 8), { magic: true });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('reject');
  });

  it('accepts a recognized image under Check 1', async () => {
    const r = await validateBytes(bytesOf([0xff, 0xd8, 0xff, 0xe0], 8), { magic: true });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('ok');
  });

  it('lets uncertain bytes through when Check 2 is off', async () => {
    const r = await validateBytes(bytesOf([0x12, 0x34], 8), { magic: true, decode: false });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('uncertain');
  });

  it('rejects uncertain bytes that fail to decode when Check 2 is on', async () => {
    // No createImageBitmap in Node → decodeProbe returns false.
    const r = await validateBytes(bytesOf([0x12, 0x34], 8), { magic: true, decode: true });
    expect(r.ok).toBe(false);
    expect(r.verdict).toBe('undecodable');
  });

  it('accepts uncertain bytes that decode successfully under Check 2', async () => {
    globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
    globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
    const r = await validateBytes(bytesOf([0x12, 0x34], 8), { magic: true, decode: true });
    expect(r.ok).toBe(true);
    expect(r.verdict).toBe('decoded');
  });
});

describe('decodeProbe', () => {
  afterEach(() => {
    delete globalThis.createImageBitmap;
    delete globalThis.Blob;
  });

  it('returns false without a browser image API', async () => {
    expect(await decodeProbe(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('returns true and closes the bitmap when decoding succeeds', async () => {
    let closed = false;
    globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
    globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() { closed = true; } });
    expect(await decodeProbe(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(closed).toBe(true);
  });

  it('returns false when decoding throws', async () => {
    globalThis.Blob = class {};
    globalThis.createImageBitmap = async () => { throw new Error('decode error'); };
    expect(await decodeProbe(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
