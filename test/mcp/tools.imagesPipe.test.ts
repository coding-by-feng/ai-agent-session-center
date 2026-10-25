// test/mcp/tools.imagesPipe.test.ts — image_upload (server/mcp/tools/imageUpload.ts) never waits on a named pipe (A-M6):
// opening one blocks until something writes to it, which may be never. Two guards, each pinned on its own here: a
// path that is not a plain file is refused before it is opened, and the open itself never waits, should a pipe take
// the file's place between the check and the open. `node:fs/promises` is wrapped to record each open and to stage
// that swap; the rest of image_upload's rules: tools.images.test.ts.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deliverCtx } from './deliverToolFixtures.js';
import { ok, runRefused } from './toolHarness.js';

const home = vi.hoisted(() => ({ dir: '' }));
const opened = vi.hoisted((): string[] => []);
/** The file name whose check sees a plain file: by the open, a pipe has taken its place. */
const SWAPPED = 'swapped.png';

vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => home.dir }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: async (...args: Parameters<typeof real.stat>) => {
      const info = await real.stat(...args);
      return basename(String(args[0])) === SWAPPED ? { ...info, isFile: () => true } : info;
    },
    open: (...args: Parameters<typeof real.open>) => {
      opened.push(basename(String(args[0])));
      return real.open(...args);
    },
  };
});
vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const STILL_WAITING = 'still waiting';
const RACE_MS = 2_000;

beforeAll(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'aasc-home-'));
  mkdirSync(join(home.dir, 'pics'));
});

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

afterEach(() => {
  opened.length = 0;
});

const setup = () => deliverCtx({ routes: { 'POST /queue-images': ok({ ok: true, ids: ['never'] }) } });

/** Uploads the pipe at `name`, answering STILL_WAITING should the upload not end within RACE_MS. */
async function uploadPipe(name: string) {
  const { ctx, client } = setup();
  const fifo = join(home.dir, 'pics', name);
  execFileSync('mkfifo', [fifo]);
  try {
    const answer = await Promise.race([
      runRefused('image_upload', { path: fifo }, ctx),
      new Promise<typeof STILL_WAITING>((resolve) => setTimeout(() => resolve(STILL_WAITING), RACE_MS)),
    ]);
    return { answer, calls: client.calls };
  } finally {
    // Should an open be stuck on the pipe all the same, a writer lets it go.
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is waiting: nothing to let go.
    }
    rmSync(fifo, { force: true });
  }
}

describe.skipIf(process.platform === 'win32')('image_upload and a named pipe (A-M6)', () => {
  it('refuses a pipe before it is opened', async () => {
    const { answer, calls } = await uploadPipe('pipe.png');

    expect(answer).toMatchObject({ code: 'INVALID', message: 'That path is not a file.' });
    expect(opened).not.toContain('pipe.png');
    expect(calls).toEqual([]);
  });

  it('opens a pipe swapped in after the check without waiting for a writer, and refuses it', async () => {
    const { answer, calls } = await uploadPipe(SWAPPED);

    expect(answer).not.toBe(STILL_WAITING);
    expect(opened).toContain(SWAPPED);
    expect(answer).toMatchObject({ code: 'INVALID', message: 'That path is not a file.' });
    expect(calls).toEqual([]);
  });
});
