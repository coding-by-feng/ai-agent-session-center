/**
 * Photos for the queue on a phone (AASC-20, feature 61) stay inside the
 * queue's limits: five images a prompt, a large or HEIC photo shrunk to a JPEG
 * the agents can read, and one that can't be brought under ~2 MB refused out
 * loud — never dropped silently.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  fitInside,
  MAX_QUEUE_IMAGES,
  needsShrink,
  PHONE_IMAGE_MAX_CHARS,
  PHONE_IMAGE_MAX_EDGE,
  readQueueImage,
  readQueueImages,
  type ImageCodec,
} from './queueImageAttach';

const file = (name: string, type: string, bytes = 1000) => new File([new Uint8Array(bytes)], name, { type });

function codec(overrides: Partial<ImageCodec> = {}): ImageCodec & { shrink: ReturnType<typeof vi.fn> } {
  return {
    dataUrl: vi.fn(async () => 'data:image/png;base64,AAAA'),
    size: vi.fn(async () => ({ width: 800, height: 600 })),
    shrink: vi.fn(async () => 'data:image/jpeg;base64,BBBB'),
    ...overrides,
  } as ImageCodec & { shrink: ReturnType<typeof vi.fn> };
}

describe('needsShrink / fitInside', () => {
  it('passes a small PNG or JPEG through and shrinks a big, heavy or unreadable one', () => {
    expect(needsShrink('image/png', 200_000, { width: 1170, height: 2532 })).toBe(true);
    expect(needsShrink('image/png', 200_000, { width: 800, height: 600 })).toBe(false);
    expect(needsShrink('image/jpeg', 4_000_000, { width: 800, height: 600 })).toBe(true);
    expect(needsShrink('image/heic', 900_000, null)).toBe(true);
  });

  it('fits inside the long edge without enlarging', () => {
    expect(fitInside(4032, 3024, PHONE_IMAGE_MAX_EDGE)).toEqual({ width: 2048, height: 1536 });
    expect(fitInside(300, 200, PHONE_IMAGE_MAX_EDGE)).toEqual({ width: 300, height: 200 });
  });
});

describe('readQueueImage', () => {
  it('keeps a small screenshot as it is', async () => {
    const c = codec();
    expect(await readQueueImage(file('shot.png', 'image/png'), 0, c)).toEqual({
      ok: true, image: { name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' },
    });
    expect(c.shrink).not.toHaveBeenCalled();
  });

  it('re-encodes a camera photo as a JPEG inside the long edge', async () => {
    const c = codec({ size: vi.fn(async () => ({ width: 4032, height: 3024 })) });
    const result = await readQueueImage(file('IMG_1234.HEIC', 'image/heic', 3_000_000), 0, c);
    expect(result).toEqual({ ok: true, image: { name: 'IMG_1234.jpg', dataUrl: 'data:image/jpeg;base64,BBBB' } });
    expect(c.shrink).toHaveBeenCalledWith(expect.any(File), PHONE_IMAGE_MAX_EDGE, expect.any(Number));
  });

  it('tries lower qualities, then refuses an image it cannot bring under the limit', async () => {
    const huge = `data:image/jpeg;base64,${'A'.repeat(PHONE_IMAGE_MAX_CHARS)}`;
    const c = codec({ shrink: vi.fn(async () => huge) });
    expect(await readQueueImage(file('big.jpg', 'image/jpeg', 9_000_000), 0, c)).toEqual({ ok: false, reason: 'too-large' });
    expect(c.shrink).toHaveBeenCalledTimes(3);
  });

  it('refuses what is not an image, or what cannot be decoded', async () => {
    expect(await readQueueImage(file('notes.pdf', 'application/pdf'), 0, codec())).toEqual({ ok: false, reason: 'not-image' });
    const c = codec({ shrink: vi.fn(async () => null) });
    expect(await readQueueImage(file('x.heic', 'image/heic'), 0, c)).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('readQueueImages', () => {
  it('fills the prompt up to five and says how many were left out', async () => {
    const files = Array.from({ length: 4 }, (_, i) => file(`p${i}.png`, 'image/png'));
    const { images, message } = await readQueueImages(files, 3, codec());
    expect(images).toHaveLength(MAX_QUEUE_IMAGES - 3);
    expect(message).toBe(`A prompt holds at most ${MAX_QUEUE_IMAGES} images: 2 not added.`);
  });

  it('says why an image was refused, and keeps the good ones', async () => {
    const { images, message } = await readQueueImages([file('a.png', 'image/png'), file('b.txt', 'text/plain')], 0, codec());
    expect(images.map((i) => i.name)).toEqual(['a.png']);
    expect(message).toBe('Only images can be attached here.');
  });
});
