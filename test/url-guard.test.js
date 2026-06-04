import { describe, it, expect } from 'vitest';
import {
  parseHttpUrl,
  hostMatchesAllowlist,
  isPrivateIpv4,
  isPrivateIpv6,
  isUnsafeHost,
  validateMediaUrl,
  extFromUrl,
  sanitizeFilename,
} from '../src/url-guard.js';
import { MEDIA_HOST_ALLOWLIST } from '../src/config.js';

describe('parseHttpUrl', () => {
  it('accepts http and https', () => {
    expect(parseHttpUrl('https://i.redd.it/a.jpg')?.hostname).toBe('i.redd.it');
    expect(parseHttpUrl('http://i.redd.it/a.jpg')?.hostname).toBe('i.redd.it');
  });
  it('rejects dangerous and non-http schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'blob:https://x/y',
      'file:///etc/passwd',
      'ftp://host/x',
      'vbscript:msgbox',
      '',
      'not a url',
    ]) {
      expect(parseHttpUrl(bad)).toBeNull();
    }
  });
  it('rejects absurdly long input', () => {
    expect(parseHttpUrl('https://i.redd.it/' + 'a'.repeat(5000))).toBeNull();
  });
});

describe('hostMatchesAllowlist', () => {
  it('matches exact and sub-domain', () => {
    expect(hostMatchesAllowlist('imgur.com', MEDIA_HOST_ALLOWLIST)).toBe(true);
    expect(hostMatchesAllowlist('i.imgur.com', MEDIA_HOST_ALLOWLIST)).toBe(true);
    expect(hostMatchesAllowlist('i.redd.it', MEDIA_HOST_ALLOWLIST)).toBe(true);
    expect(hostMatchesAllowlist('a.thumbs.redditmedia.com', MEDIA_HOST_ALLOWLIST)).toBe(true);
  });
  it('rejects look-alike / suffix-injection domains', () => {
    expect(hostMatchesAllowlist('evilimgur.com', MEDIA_HOST_ALLOWLIST)).toBe(false);
    expect(hostMatchesAllowlist('imgur.com.evil.net', MEDIA_HOST_ALLOWLIST)).toBe(false);
    expect(hostMatchesAllowlist('notreddit.it', MEDIA_HOST_ALLOWLIST)).toBe(false);
    expect(hostMatchesAllowlist('i.redd.it.attacker.com', MEDIA_HOST_ALLOWLIST)).toBe(false);
  });
  it('is case-insensitive and tolerates trailing dot', () => {
    expect(hostMatchesAllowlist('I.Redd.It.', MEDIA_HOST_ALLOWLIST)).toBe(true);
  });
});

describe('isPrivateIpv4', () => {
  it('flags private/reserved/loopback ranges', () => {
    for (const ip of [
      '0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '169.254.1.1',
      '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '192.0.2.5',
      '198.18.0.1', '198.51.100.1', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
  });
  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '151.101.1.140', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });
  it('rejects malformed octets', () => {
    expect(isPrivateIpv4('999.1.1.1')).toBe(false);
    expect(isPrivateIpv4('10.0.0')).toBe(false);
  });
});

describe('isPrivateIpv6', () => {
  it('flags loopback, link-local, ULA, mapped-v4', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '[::1]']) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
  });
  it('allows public v6', () => {
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateIpv6('2001:4860:4860::8888')).toBe(false);
  });
});

describe('isUnsafeHost', () => {
  it('flags localhost names and private IPs', () => {
    for (const h of ['localhost', 'foo.localhost', 'printer.local', '127.0.0.1', '192.168.0.5', '::1']) {
      expect(isUnsafeHost(h), h).toBe(true);
    }
  });
  it('allows real public hostnames', () => {
    expect(isUnsafeHost('i.redd.it')).toBe(false);
    expect(isUnsafeHost('i.imgur.com')).toBe(false);
  });
});

describe('validateMediaUrl', () => {
  it('accepts allowlisted media and upgrades to https', () => {
    const r = validateMediaUrl('http://i.redd.it/abc.jpg');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe('https://i.redd.it/abc.jpg');
      expect(r.host).toBe('i.redd.it');
    }
  });
  it('rejects non-allowlisted hosts', () => {
    const r = validateMediaUrl('https://example.com/a.jpg');
    expect(r.ok).toBe(false);
  });
  it('rejects private IP hosts even if someone forces them', () => {
    expect(validateMediaUrl('https://127.0.0.1/a.jpg').ok).toBe(false);
    expect(validateMediaUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
  });
  it('rejects dangerous schemes', () => {
    expect(validateMediaUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateMediaUrl('data:image/png;base64,AAAA').ok).toBe(false);
  });
});

describe('extFromUrl', () => {
  it('reads known extensions and maps gifv->mp4', () => {
    expect(extFromUrl('https://i.redd.it/a.JPG')).toBe('jpg');
    expect(extFromUrl('https://i.imgur.com/a.gifv')).toBe('mp4');
    expect(extFromUrl('https://v.redd.it/a.mp4')).toBe('mp4');
  });
  it('falls back for unknown/missing extensions', () => {
    expect(extFromUrl('https://i.redd.it/a.exe')).toBe('bin');
    expect(extFromUrl('https://i.redd.it/noext')).toBe('bin');
    expect(extFromUrl('garbage', 'jpg')).toBe('jpg');
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators and traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toMatch(/[\\/]/);
    expect(sanitizeFilename('a/b\\c')).toBe('a_b_c');
  });
  it('removes illegal characters and control chars', () => {
    expect(sanitizeFilename('a:b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h');
  });
  it('handles empty / dotty input with a fallback', () => {
    expect(sanitizeFilename('')).toBe('reddit-media');
    expect(sanitizeFilename('...')).toBe('reddit-media');
    expect(sanitizeFilename('   ')).toBe('reddit-media');
  });
  it('avoids reserved windows device names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('lpt1')).toBe('_lpt1');
  });
  it('bounds length', () => {
    expect(sanitizeFilename('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});
