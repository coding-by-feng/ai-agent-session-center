// videoAttach.test.ts — a phone's video for a prompt (Oct 27 2026): which files are videos, the
// upload to the Mac (POST /api/queue-media), the path line a message carries, and the clip's length.
import { describe, it, expect, vi } from 'vitest';
import {
  MAX_VIDEO_BYTES,
  formatVideoLength,
  splitMediaFiles,
  uploadVideo,
  videoTypeOf,
  withVideoPaths,
} from './videoAttach';

const file = (name: string, type: string, size = 10): File => {
  const f = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('videoTypeOf / splitMediaFiles', () => {
  it('reads the type, or the extension when the picker gives none', () => {
    expect(videoTypeOf(file('a.mov', 'video/quicktime'))).toBe('video/quicktime');
    expect(videoTypeOf(file('a.MOV', ''))).toBe('video/quicktime');
    expect(videoTypeOf(file('a.mp4', ''))).toBe('video/mp4');
    expect(videoTypeOf(file('a.m4v', ''))).toBe('video/x-m4v');
    expect(videoTypeOf(file('a.webm', ''))).toBe('video/webm');
    expect(videoTypeOf(file('a.png', 'image/png'))).toBeNull();
    expect(videoTypeOf(file('a.3gp', 'video/3gpp'))).toBe('video/3gpp');
  });

  it('splits picked files into photos and videos, keeping their order', () => {
    const a = file('a.jpg', 'image/jpeg');
    const b = file('b.mov', 'video/quicktime');
    const c = file('c.png', 'image/png');
    const d = file('d.mp4', '');
    expect(splitMediaFiles([a, b, c, d])).toEqual({ images: [a, c], videos: [b, d] });
  });
});

describe('uploadVideo', () => {
  it('posts the raw file with its type and answers the Mac path', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, path: '/tmp/claude-queue-images/queue-img-1-a.mov', id: 'queue-img-1-a.mov' }), { status: 200 }));
    const clip = file('clip.MOV', '');
    const result = await uploadVideo(clip, fetchImpl);
    expect(result).toEqual({ ok: true, path: '/tmp/claude-queue-images/queue-img-1-a.mov', id: 'queue-img-1-a.mov' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/queue-media', expect.objectContaining({
      method: 'POST',
      body: clip,
      headers: { 'Content-Type': 'video/quicktime' },
    }));
  });

  it('refuses before uploading a type the Mac won’t take, or a clip over the cap', async () => {
    const fetchImpl = vi.fn();
    expect(await uploadVideo(file('a.3gp', 'video/3gpp'), fetchImpl)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await uploadVideo(file('a.mp4', 'video/mp4', MAX_VIDEO_BYTES + 1), fetchImpl)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
  });

  it('says why the Mac refused, or that it could not be reached', async () => {
    const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    expect(await uploadVideo(file('a.mp4', 'video/mp4'), reply(413, { ok: false, code: 'too_large' }))).toMatchObject({ ok: false, reason: 'too-large' });
    expect(await uploadVideo(file('a.mp4', 'video/mp4'), reply(415, { ok: false }))).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await uploadVideo(file('a.mp4', 'video/mp4'), reply(429, { ok: false }))).toMatchObject({ ok: false, reason: 'busy' });
    expect(await uploadVideo(file('a.mp4', 'video/mp4'), reply(500, { ok: false }))).toMatchObject({ ok: false, reason: 'failed' });
    expect(await uploadVideo(file('a.mp4', 'video/mp4'), reply(200, { ok: true }))).toMatchObject({ ok: false, reason: 'failed' });
    const down = vi.fn(async () => { throw new TypeError('offline'); });
    expect(await uploadVideo(file('a.mp4', 'video/mp4'), down)).toMatchObject({ ok: false, reason: 'network' });
    const result = await uploadVideo(file('a.mp4', 'video/mp4', MAX_VIDEO_BYTES + 1), vi.fn());
    expect(result.ok === false && result.message).toBe('That video is over 100 MB. Trim it, or send a shorter one.');
  });
});

describe('withVideoPaths', () => {
  it('puts each path on its own line under the text, as a photo’s path is typed', () => {
    expect(withVideoPaths('look at this', ['/tmp/a.mov', '/tmp/b.mp4'])).toBe('look at this\n/tmp/a.mov\n/tmp/b.mp4');
    expect(withVideoPaths('look', [])).toBe('look');
    expect(withVideoPaths('', ['/tmp/a.mov'])).toBe('/tmp/a.mov');
    expect(withVideoPaths('look\n', ['/tmp/a.mov'])).toBe('look\n/tmp/a.mov');
  });
});

describe('formatVideoLength', () => {
  it('reads like a clip’s length', () => {
    expect(formatVideoLength(42.4)).toBe('0:42');
    expect(formatVideoLength(65)).toBe('1:05');
    expect(formatVideoLength(3723)).toBe('1:02:03');
    expect(formatVideoLength(Number.NaN)).toBeNull();
    expect(formatVideoLength(Infinity)).toBeNull();
    expect(formatVideoLength(null)).toBeNull();
  });
});
