// test/mcp/tools.images.test.ts — image_upload (prompts toolset, server/mcp/tools/imageUpload.ts): a central gives AASC
// an image, by a file under the person's home or by a data URL, and gets back an id that prompt_send can attach. The
// file is read by AASC, so the rules are the whole of its safety: under home (symlinks followed first), an image by
// its bytes and not its name, at most 10 MB, never named back in a refusal. The home folder is a temporary one here.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { allTools } from '../../server/mcp/registry.js';
import { deliverCtx } from './deliverToolFixtures.js';
import { dataOf, ok, run, runRefused } from './toolHarness.js';

const home = vi.hoisted(() => ({ dir: '', outside: '' }));
vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => home.dir }));
vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const MB10 = 10 * 1024 * 1024;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const stored = ok({ ok: true, paths: ['/tmp/claude-queue-images/queue-img-1-abc123.png'], ids: ['queue-img-1-abc123.png'] });

beforeAll(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'aasc-home-'));
  home.outside = mkdtempSync(join(tmpdir(), 'aasc-outside-'));
  mkdirSync(join(home.dir, 'pics'));
  writeFileSync(join(home.dir, 'pics', 'shot.png'), PNG);
  writeFileSync(join(home.dir, 'pics', 'photo.dat'), JPEG);
  writeFileSync(join(home.dir, 'pics', 'anim.gif'), GIF);
  writeFileSync(join(home.dir, 'pics', 'pic.webp'), WEBP);
  writeFileSync(join(home.dir, 'pics', 'notes.png'), 'this is text, not a picture');
  writeFileSync(join(home.outside, 'secret.png'), PNG);
  symlinkSync(join(home.outside, 'secret.png'), join(home.dir, 'pics', 'link.png'));
  symlinkSync(join(home.dir, 'pics', 'shot.png'), join(home.outside, 'into-home.png'));
  // The places the media scope leaves out: ~/Library, and any hidden folder below home (D-M3).
  mkdirSync(join(home.dir, 'Library', 'Messages'), { recursive: true });
  mkdirSync(join(home.dir, '.ssh'));
  writeFileSync(join(home.dir, 'Library', 'Messages', 'a.png'), PNG);
  writeFileSync(join(home.dir, '.ssh', 'pic.png'), PNG);
  symlinkSync(join(home.dir, 'Library', 'Messages', 'a.png'), join(home.dir, 'pics', 'tolibrary.png'));
});

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(home.outside, { recursive: true, force: true });
});

const setup = (answer = stored) => deliverCtx({ routes: { 'POST /queue-images': answer } });

interface Upload {
  imageId: string;
  type: string;
  bytes: number;
  expiresInHours: number;
}

describe('image_upload from a file', () => {
  it('posts a file under the person’s home as a data URL, and gives back the id the route made', async () => {
    const { ctx, client } = setup();
    const path = join(home.dir, 'pics', 'shot.png');

    const result = await run('image_upload', { path }, ctx);

    expect(client.calls).toEqual([
      { method: 'POST', path: '/queue-images', body: { images: [{ name: 'shot.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }] } },
    ]);
    expect(result.data).toEqual({ imageId: 'queue-img-1-abc123.png', type: 'png', bytes: PNG.length, expiresInHours: 24 });
    expect(result.summary).toMatch(/queue-img-1-abc123\.png/);
    expect(result.summary).toMatch(/imageIds/);
    expect(result.activity).toEqual([
      { summary: `Uploaded a png image (${PNG.length} bytes) for prompts.`, detail: { type: 'png', bytes: PNG.length, source: 'file' } },
    ]);
  });

  it('never gives the path the route stored it at, nor the central’s own path, back', async () => {
    const { ctx } = setup();
    const path = join(home.dir, 'pics', 'shot.png');

    const result = await run('image_upload', { path }, ctx);

    const shown = JSON.stringify([result.data, result.summary, result.activity]);
    expect(shown).not.toContain('/tmp/claude-queue-images');
    expect(shown).not.toContain(home.dir);
  });

  it('takes ~ for the home folder', async () => {
    const { ctx, client } = setup();

    await run('image_upload', { path: '~/pics/shot.png' }, ctx);

    expect((client.calls[0].body as { images: Array<{ name: string }> }).images[0].name).toBe('shot.png');
  });

  it('goes by what the bytes are, not what the file is called: png, jpeg, gif, webp', async () => {
    const { ctx, client } = setup();

    const types = [];
    for (const file of ['photo.dat', 'anim.gif', 'pic.webp']) {
      types.push((await dataOf<Upload>('image_upload', { path: join(home.dir, 'pics', file) }, ctx)).type);
    }

    expect(types).toEqual(['jpeg', 'gif', 'webp']);
    const heads = client.calls.map((c) => (c.body as { images: Array<{ dataUrl: string }> }).images[0].dataUrl.split(',')[0]);
    expect(heads).toEqual(['data:image/jpeg;base64', 'data:image/gif;base64', 'data:image/webp;base64']);
  });

  it('refuses a file that is not an image whatever its name says', async () => {
    const { ctx, client } = setup();

    const err = await runRefused('image_upload', { path: join(home.dir, 'pics', 'notes.png') }, ctx);

    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/png|jpeg|gif|webp/i);
    expect(client.calls).toEqual([]);
  });

  it('refuses a path outside the home folder, one that climbs out of it, and a symlink that leads out of it', async () => {
    const { ctx, client } = setup();
    const outside = join(home.outside, 'secret.png');
    const sibling = basename(home.outside);
    const attempts = [
      outside,
      `~/../${sibling}/secret.png`,
      join(home.dir, 'pics', '..', '..', sibling, 'secret.png'),
      join(home.dir, 'pics', 'link.png'),
      join(home.outside, 'into-home.png'),
      '/etc/hosts',
    ];

    for (const path of attempts) {
      const err = await runRefused('image_upload', { path }, ctx);
      expect(err.code, path).toBe('INVALID');
      expect(`${err.message} ${err.hint ?? ''}`, path).not.toContain(path);
    }
    expect(client.calls).toEqual([]);
  });

  it('refuses ~/Library and hidden folders below home, given or real, in the words of outside home (D-M3)', async () => {
    const outsideWords = await runRefused('image_upload', { path: join(home.outside, 'secret.png') }, setup().ctx);
    const paths = [
      join(home.dir, 'Library', 'Messages', 'a.png'),
      '~/library/Messages/a.png',
      join(home.dir, '.ssh', 'pic.png'),
      join(home.dir, 'pics', 'tolibrary.png'),
      join(home.dir, '.nothing', 'nothing.png'),
    ];
    for (const path of paths) {
      const { ctx, client } = setup();

      const err = await runRefused('image_upload', { path }, ctx);

      expect(err, path).toMatchObject({ code: 'INVALID', message: outsideWords.message });
      expect(client.calls, path).toEqual([]);
    }
    expect(allTools().find((t) => t.name === 'image_upload')?.description).toMatch(/Library/);
  });

  it('refuses a folder, a missing file, a relative path, and the home folder itself', async () => {
    const { ctx, client } = setup();

    expect((await runRefused('image_upload', { path: join(home.dir, 'pics') }, ctx)).code).toBe('INVALID');
    expect((await runRefused('image_upload', { path: join(home.dir, 'pics', 'gone.png') }, ctx)).code).toBe('NOT_FOUND');
    expect((await runRefused('image_upload', { path: 'pics/shot.png' }, ctx)).code).toBe('INVALID');
    expect((await runRefused('image_upload', { path: '~' }, ctx)).code).toBe('INVALID');
    expect((await runRefused('image_upload', { path: `${join(home.dir, 'pics', 'shot.png')}\u0000.txt` }, ctx)).code).toBe('INVALID');
    expect(client.calls).toEqual([]);
  });

  it('takes a file of 10 MB and refuses one a byte larger, without reading it', async () => {
    const { ctx, client } = setup();
    const big = join(home.dir, 'pics', 'big.png');
    writeFileSync(big, PNG);
    truncateSync(big, MB10);
    const bigger = join(home.dir, 'pics', 'bigger.png');
    writeFileSync(bigger, PNG);
    truncateSync(bigger, MB10 + 1);

    await run('image_upload', { path: big }, ctx);
    const err = await runRefused('image_upload', { path: bigger }, ctx);

    expect(client.calls).toHaveLength(1);
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/10 MB/);
  });

  it.skipIf(process.platform === 'win32')('refuses a named pipe without opening it: nothing waits on a writer (A-M6)', async () => {
    const { ctx, client } = setup();
    const fifo = join(home.dir, 'pics', 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    try {
      const answer = await Promise.race([
        runRefused('image_upload', { path: fifo }, ctx),
        new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
      ]);

      expect(answer).not.toBe('still waiting');
      expect(answer).toMatchObject({ code: 'INVALID', message: 'That path is not a file.' });
      expect(client.calls).toEqual([]);
    } finally {
      // Should a read be stuck opening the pipe all the same, a writer lets it go.
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // No reader is waiting: nothing to let go.
      }
      rmSync(fifo, { force: true });
    }
  });
});

describe('image_upload from a data URL', () => {
  const urlOf = (buf: Buffer, type = 'png') => `data:image/${type};base64,${buf.toString('base64')}`;

  it('posts the data URL it was given, named as the central names it', async () => {
    const { ctx, client } = setup();

    const result = await run('image_upload', { dataUrl: urlOf(PNG), name: 'chart.png' }, ctx);

    expect(client.calls[0].body).toEqual({ images: [{ name: 'chart.png', dataUrl: urlOf(PNG) }] });
    expect(result.data).toMatchObject({ imageId: 'queue-img-1-abc123.png', type: 'png', bytes: PNG.length });
    expect(result.activity?.[0]).toMatchObject({ detail: { source: 'dataUrl' } });
  });

  it('labels the image by its bytes when the data URL says another type', async () => {
    const { ctx, client } = setup();

    const result = await run('image_upload', { dataUrl: urlOf(PNG, 'jpeg') }, ctx);

    expect((client.calls[0].body as { images: Array<{ dataUrl: string }> }).images[0].dataUrl).toBe(urlOf(PNG, 'png'));
    expect((result.data as Upload).type).toBe('png');
  });

  it('refuses what is not an image data URL: another type, a vector image, bytes that are not a picture, bad base64', async () => {
    const { ctx, client } = setup();
    const text = Buffer.from('<html>not an image</html>');
    const refused = [
      `data:text/html;base64,${text.toString('base64')}`,
      `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      urlOf(text),
      'data:image/png;base64,not base64!!',
      'data:image/png;base64,',
      'data:image/png,iVBORw0KGgo=',
      'https://example.com/a.png',
    ];

    for (const dataUrl of refused) {
      const err = await runRefused('image_upload', { dataUrl }, ctx);
      expect(err.code, dataUrl.slice(0, 40)).toBe('INVALID');
    }
    expect(client.calls).toEqual([]);
  });

  it('takes 10 MB of picture and refuses a byte more', async () => {
    const { ctx, client } = setup();
    const fill = (n: number): Buffer => Buffer.concat([PNG, Buffer.alloc(n - PNG.length)]);

    await run('image_upload', { dataUrl: urlOf(fill(MB10)) }, ctx);
    const err = await runRefused('image_upload', { dataUrl: urlOf(fill(MB10 + 1)) }, ctx);

    expect(client.calls).toHaveLength(1);
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/10 MB/);
  });
});

describe('image_upload, either way', () => {
  it('wants exactly one of a path and a data URL', async () => {
    const { ctx, client } = setup();
    const both = { path: join(home.dir, 'pics', 'shot.png'), dataUrl: 'data:image/png;base64,AAAA' };

    expect((await runRefused('image_upload', {}, ctx)).code).toBe('INVALID');
    expect((await runRefused('image_upload', both, ctx)).code).toBe('INVALID');
    expect(client.calls).toEqual([]);
  });

  it('is upstream trouble when the route stores nothing or fails', async () => {
    const path = join(home.dir, 'pics', 'shot.png');
    const none = setup(ok({ ok: true, paths: [], ids: [] }));
    const failing = deliverCtx({ routes: { 'POST /queue-images': { ok: false, status: 500, data: null, error: 'disk full' } } });

    expect((await runRefused('image_upload', { path }, none.ctx)).code).toBe('UPSTREAM');
    expect((await runRefused('image_upload', { path }, failing.ctx)).code).toBe('UPSTREAM');
  });

  it('is a write tool of the prompts toolset in phase 2, and says the id lasts a day', () => {
    const tool = allTools().find((t) => t.name === 'image_upload')!;
    const schema = z.object(tool.input);

    expect(tool).toMatchObject({ toolset: 'prompts', risk: 'write', phase: 2 });
    expect(tool.description).toMatch(/24 hours|a day/);
    expect(tool.description).toMatch(/10 MB/);
    expect(schema.safeParse({ path: '~/a.png' }).success).toBe(true);
    expect(schema.safeParse({ path: '' }).success).toBe(false);
    expect(schema.safeParse({ dataUrl: 'x'.repeat(14_500_000) }).success).toBe(false);
    expect(schema.safeParse({ path: '~/a.png', name: 'n'.repeat(256) }).success).toBe(false);
  });
});
