/**
 * Photos for the queue on a phone (AASC-20, feature 61) stay inside the
 * queue's limits: five images a prompt, a large or HEIC photo shrunk to a JPEG
 * the agents can read, and one that can't be brought under ~2 MB refused out
 * loud — never dropped silently.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addImagesToPrompt,
  fitInside,
  MAX_PROMPT_IMAGES_CHARS,
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
    expect(fitInside(4032, 3024, PHONE_IMAGE_MAX_EDGE)).toEqual({ width: 2000, height: 1500 });
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
  it('fills the prompt up to the cap and says how many were left out', async () => {
    const files = Array.from({ length: 4 }, (_, i) => file(`p${i}.png`, 'image/png'));
    const { images, message } = await readQueueImages(files, 8, codec());
    expect(images).toHaveLength(MAX_QUEUE_IMAGES - 8);
    expect(message).toBe(`A prompt holds at most ${MAX_QUEUE_IMAGES} images: 2 not added.`);
  });

  // Oct 21 2026: 10 photos a prompt (was 5), each inside 2000 px — above 20 images in one Claude
  // request (earlier turns count) the API rejects any image over 2000 px.
  it('takes ten photos a prompt, each at most 2000 px on its long edge', () => {
    expect(MAX_QUEUE_IMAGES).toBe(10);
    expect(PHONE_IMAGE_MAX_EDGE).toBe(2000);
    expect(needsShrink('image/png', 1000, { width: 1170, height: 2532 })).toBe(true);
    expect(needsShrink('image/png', 1000, { width: 1000, height: 2000 })).toBe(false);
  });

  it('stops before a prompt’s photos pass ~6 MB together (the queue syncs as one 8 MB payload)', async () => {
    const big = `data:image/png;base64,${'A'.repeat(1_600_000)}`;
    const files = Array.from({ length: 5 }, (_, i) => file(`p${i}.png`, 'image/png'));
    const { images, message } = await readQueueImages(files, 0, codec({ dataUrl: vi.fn(async () => big) }));
    expect(images).toHaveLength(3);
    expect(images.reduce((n, i) => n + i.dataUrl.length, 0)).toBeLessThanOrEqual(MAX_PROMPT_IMAGES_CHARS);
    expect(message).toBe('These photos are too large together: 2 not added.');
    // What the prompt already holds counts too.
    const more = await readQueueImages(files.slice(0, 2), 3, codec({ dataUrl: vi.fn(async () => big) }), 3 * big.length);
    expect(more.images).toHaveLength(0);
    expect(more.message).toBe('These photos are too large together: 2 not added.');
  });

  it('says why an image was refused, and keeps the good ones', async () => {
    const { images, message } = await readQueueImages([file('a.png', 'image/png'), file('b.txt', 'text/plain')], 0, codec());
    expect(images.map((i) => i.name)).toEqual(['a.png']);
    expect(message).toBe('Only images can be attached here.');
  });
});

describe('addImagesToPrompt (the desktop’s paste, pick and drop)', () => {
  const img = (n: number, chars = 100) => ({ name: `i${n}.png`, dataUrl: `data:image/png;base64,${'A'.repeat(chars)}` });

  it('keeps the first ones up to the cap and says how many were left out', () => {
    const prev = [img(0), img(1)];
    const { images, message } = addImagesToPrompt(prev, Array.from({ length: 12 }, (_, i) => img(i + 2)));
    expect(images).toHaveLength(MAX_QUEUE_IMAGES);
    expect(images.slice(0, 2)).toEqual(prev);
    expect(message).toBe(`A prompt holds at most ${MAX_QUEUE_IMAGES} images: 4 not added.`);
  });

  it('stops before the photos pass ~6 MB together', () => {
    const { images, message } = addImagesToPrompt([], [img(0, 2_500_000), img(1, 2_500_000), img(2, 2_500_000)]);
    expect(images).toHaveLength(2);
    expect(message).toBe('These photos are too large together: 1 not added.');
  });

  it('says nothing when everything fits', () => {
    expect(addImagesToPrompt([img(0)], [img(1)])).toEqual({ images: [img(0), img(1)], message: null });
  });
});
