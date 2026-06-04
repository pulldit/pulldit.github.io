// Media content validation — the client-side "is this really an image/video?" gate.
//
// This is NOT an antivirus (images/videos are decoded data, not executed code). It is a
// content sniffer that protects the user from the problems that actually occur when bulk-
// downloading from Reddit/imgur/CDNs and packing the bytes into a ZIP:
//   - a CDN returns an HTML error / "removed" / rate-limit page instead of the file,
//   - a link is mislabeled and the bytes are something else entirely (archive, document,
//     script, executable…),
//   - a file is corrupt and won't decode.
//
// Two layers, both opt-in from Advanced settings:
//   Check 1 (magic): pure, ~free signature sniffing. Accepts known image/video formats,
//                    REJECTS known-dangerous / non-media payloads, marks the rest uncertain.
//   Check 2 (decode): only consulted for Check-1-uncertain bytes — actually decodes them as
//                    an image (createImageBitmap) to decide. Browser-only; a no-op in Node.
//
// sniffBytes() and validateBytes()' decision logic are pure and unit-tested; only decodeProbe()
// touches a browser API (guarded so the module imports cleanly in Node).

/** @param {Uint8Array} bytes @param {number[]} sig @param {number} [off] */
function startsWith(bytes, sig, off = 0) {
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[off + i] !== sig[i]) return false;
  }
  return true;
}

/** Read `len` bytes from `off` as a Latin-1 string (used for 4CC container tags). */
function ascii(bytes, off, len) {
  let s = '';
  for (let i = 0; i < len; i += 1) {
    const c = bytes[off + i];
    if (c === undefined) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const ok = (format, kind) => ({ verdict: 'ok', kind, format, reason: '' });
const reject = (format, reason) => ({ verdict: 'reject', kind: 'reject', format, reason });
const uncertain = (reason) => ({ verdict: 'uncertain', kind: 'unknown', format: '', reason });

/**
 * Sniff a media payload's leading bytes (pure).
 * @param {Uint8Array} bytes
 * @returns {{ verdict: 'ok'|'reject'|'uncertain', kind: string, format: string, reason: string }}
 */
export function sniffBytes(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) {
    return uncertain('empty or unreadable bytes');
  }
  const n = bytes.length;

  /* ---------------- Known-dangerous / non-media → REJECT ---------------- */
  if (startsWith(bytes, [0x4d, 0x5a])) return reject('exe', 'Windows executable (MZ) header'); // PE/DLL
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return reject('elf', 'ELF binary');
  if (
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) // Mach-O fat / Java class
  ) {
    return reject('macho', 'Mach-O / Java executable header');
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return reject('pdf', 'PDF document'); // %PDF
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]) // PK… ZIP/JAR/Office (OOXML)
  ) {
    return reject('zip', 'ZIP/Office/JAR archive');
  }
  if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return reject('rar', 'RAR archive');
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return reject('7z', '7-Zip archive');
  if (startsWith(bytes, [0x1f, 0x8b])) return reject('gzip', 'gzip stream');
  if (startsWith(bytes, [0x42, 0x5a, 0x68])) return reject('bzip2', 'bzip2 stream');
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return reject('xz', 'xz stream');
  if (startsWith(bytes, [0x23, 0x21])) return reject('script', 'script (#!) header');
  // Leading text/markup: HTML block/error pages, XML, SVG (can carry script), or JSON wrappers.
  {
    const head = ascii(bytes, 0, Math.min(n, 64)).replace(/^﻿/, '').replace(/^\s+/, '').toLowerCase();
    if (
      head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head') ||
      head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--') ||
      head.startsWith('{') || head.startsWith('[')
    ) {
      return reject('text', 'text/markup payload (HTML, XML, SVG or JSON) — not binary media');
    }
  }

  /* ---------------- Known media signatures → OK ---------------- */
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ok('jpeg', 'image');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return ok('png', 'image');
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return ok('gif', 'gif'); // GIF8
  if (startsWith(bytes, [0x42, 0x4d])) return ok('bmp', 'image'); // BM
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return ok('tiff', 'image');
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) || startsWith(bytes, [0x00, 0x00, 0x02, 0x00])) return ok('ico', 'image'); // ICO/CUR
  if (startsWith(bytes, [0xff, 0x0a]) || startsWith(bytes, [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return ok('jxl', 'image'); // JPEG XL

  // RIFF container: WebP (image), AVI (video); WAV/other → reject.
  if (ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 4);
    if (form === 'WEBP') return ok('webp', 'image');
    if (form === 'AVI ') return ok('avi', 'video');
    return reject('riff', `RIFF '${form.trim() || '????'}' is not image/video`);
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return ok('webm', 'video'); // EBML: Matroska/WebM
  if (startsWith(bytes, [0x46, 0x4c, 0x56, 0x01])) return ok('flv', 'video'); // FLV\x01

  // ISO-BMFF (MP4/MOV/HEIC/AVIF/3GP…): 'ftyp' box at offset 4.
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).trim().toLowerCase();
    const imageBrands = ['avif', 'avis', 'heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1'];
    if (imageBrands.includes(brand)) return ok('heif', 'image');
    return ok('mp4', 'video'); // isom/mp41/mp42/qt/3gp/dash/…
  }
  // QuickTime/MOV files that lead with a top-level atom rather than ftyp.
  if (['moov', 'mdat', 'free', 'skip', 'wide', 'pnot'].includes(ascii(bytes, 4, 4))) return ok('mov', 'video');

  // MPEG transport stream: 0x47 sync byte every 188 bytes.
  if (n >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return ok('mpegts', 'video');
  // MPEG program stream / MPEG-1/2 video start codes.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0xba]) || startsWith(bytes, [0x00, 0x00, 0x01, 0xb3])) return ok('mpeg', 'video');

  return uncertain('no known media signature');
}

/**
 * Decode-probe: try to decode the bytes as an image in the browser. Browser-only — returns
 * false where createImageBitmap/Blob are unavailable (Node, workers without the API). The
 * decoded bitmap is closed immediately to free memory (matters across hundreds of files).
 * @param {Uint8Array} bytes
 * @returns {Promise<boolean>}
 */
export async function decodeProbe(bytes) {
  const g = globalThis;
  if (typeof g.createImageBitmap !== 'function' || typeof g.Blob !== 'function') return false;
  let bitmap = null;
  try {
    bitmap = await g.createImageBitmap(new g.Blob([bytes]));
    return !!(bitmap && bitmap.width > 0 && bitmap.height > 0);
  } catch {
    return false;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

/**
 * Validate fetched media bytes according to the enabled checks.
 * @param {Uint8Array} bytes
 * @param {{ magic?: boolean, decode?: boolean }} [opts]
 *   magic  — Check 1 (default true). decode — Check 2 (only consulted when Check 1 is uncertain).
 * @returns {Promise<{ ok: boolean, verdict: string, kind: string, format: string, reason: string }>}
 */
export async function validateBytes(bytes, opts = {}) {
  const magic = opts.magic !== false;
  const decode = opts.decode === true;
  if (!magic) {
    return { ok: true, verdict: 'skipped', kind: 'unknown', format: '', reason: 'validation disabled' };
  }

  const s = sniffBytes(bytes);
  if (s.verdict === 'reject') {
    return { ok: false, verdict: 'reject', kind: s.kind, format: s.format, reason: s.reason };
  }
  if (s.verdict === 'ok') {
    return { ok: true, verdict: 'ok', kind: s.kind, format: s.format, reason: '' };
  }

  // Uncertain: an unknown signature that is NOT a known-dangerous payload.
  if (!decode) {
    // Check 1 only — don't block legitimate-but-unusual media just because we don't know it.
    return { ok: true, verdict: 'uncertain', kind: 'unknown', format: '', reason: `${s.reason} (decode check off)` };
  }
  const decoded = await decodeProbe(bytes);
  if (decoded) {
    return { ok: true, verdict: 'decoded', kind: 'image', format: 'decoded', reason: '' };
  }
  return { ok: false, verdict: 'undecodable', kind: 'unknown', format: '', reason: `${s.reason} and failed to decode as an image` };
}
