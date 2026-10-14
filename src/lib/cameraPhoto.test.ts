// cameraPhoto.test.ts — a phone photo, made fit for a note (AASC-20).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fitWithin, preparePhoto } from './cameraPhoto';

afterEach(() => vi.unstubAllGlobals());

describe('fitWithin', () => {
  it('scales the long edge down to the cap, keeping the shape', () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
  });

  it('never scales up', () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });
});

describe('preparePhoto', () => {
  it('sends a file it can’t decode as it came', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('HEIC not supported'); }));
    const file = new File(['x'], 'IMG_0001.HEIC', { type: 'image/heic' });
    expect(await preparePhoto(file)).toBe(file);
  });

  it('keeps a small JPEG untouched', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 640, height: 480, close })));
    const file = new File(['x'], 'small.jpg', { type: 'image/jpeg' });
    expect(await preparePhoto(file)).toBe(file);
    expect(close).toHaveBeenCalled();
  });

  it('leaves a video alone', async () => {
    const file = new File(['x'], 'clip.mov', { type: 'video/quicktime' });
    expect(await preparePhoto(file)).toBe(file);
  });
});
