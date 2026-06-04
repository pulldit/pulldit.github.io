import { describe, it, expect } from 'vitest';
import { buildItemFilename } from '../src/download.js';

describe('buildItemFilename', () => {
  it('produces an ordered, safe, extensioned name', () => {
    const name = buildItemFilename({ title: 'Cute Cat in a Box', id: 'p1', url: 'https://i.redd.it/a.jpg', ext: 'jpg', type: 'image' }, 0);
    expect(name).toMatch(/^001_Cute_Cat_in_a_Box_p1\.jpg$/);
  });
  it('omits the sequence prefix when asked (single download)', () => {
    const name = buildItemFilename({ title: 'Hello', id: 'p2', ext: 'png', type: 'image', url: 'https://i.redd.it/h.png' }, 0, false);
    expect(name).toBe('Hello_p2.png');
  });
  it('defaults a video extension to mp4', () => {
    const name = buildItemFilename({ title: 'clip', id: 'v1', type: 'video', url: 'https://v.redd.it/v1/DASH_720' }, 2);
    expect(name).toMatch(/^003_clip_v1\.mp4$/);
  });
  it('sanitizes path separators and illegal characters out of titles', () => {
    const name = buildItemFilename({ title: '../../etc/passwd', id: 'x', ext: 'jpg', type: 'image', url: 'https://i.redd.it/x.jpg' }, 0);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
    expect(name).toContain('_x.jpg');
  });
  it('bounds the filename length', () => {
    const name = buildItemFilename({ title: 'y'.repeat(500), id: 'zz', ext: 'jpg', type: 'image', url: 'https://i.redd.it/y.jpg' }, 0);
    expect(name.length).toBeLessThanOrEqual(160);
  });
  it('does not duplicate the id when the title already ends with it', () => {
    const name = buildItemFilename({ title: 'photo_abc', id: 'abc', ext: 'jpg', type: 'image', url: 'https://i.redd.it/a.jpg' }, 0, false);
    expect(name).toBe('photo_abc.jpg');
  });
});
