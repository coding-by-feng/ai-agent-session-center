// test/queueImages.test.ts — AASC-42: a phone names an uploaded queue image by its id (the
// file name POST /api/queue-images gave it), never by a path. Only a name of that exact shape,
// for a file that is still there, resolves; anything else is refused.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { isQueueImageId, queueImageId, resolveQueueImage, QUEUE_IMAGES_DIR } from '../server/queueImages.js';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aasc42-images-'));
  writeFileSync(join(dir, 'queue-img-1760000000000-ab12cd.png'), 'PNG');
  mkdirSync(join(dir, 'queue-img-1760000000000-folder.png'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('queue image ids', () => {
  it('is the file name of a saved image', () => {
    expect(queueImageId(join(QUEUE_IMAGES_DIR, 'queue-img-1760000000000-ab12cd.jpg'))).toBe('queue-img-1760000000000-ab12cd.jpg');
  });

  it.each([
    'queue-img-1760000000000-ab12cd.png', 'queue-img-1-a.jpg', 'queue-img-1760000000000-zz9.webp',
  ])('accepts %s', (id) => {
    expect(isQueueImageId(id)).toBe(true);
  });

  it.each([
    '', '../queue-img-1-a.png', 'queue-img-1-a.png/../../etc/passwd', '/tmp/claude-queue-images/queue-img-1-a.png',
    'queue-img-1-a', 'queue-img-x-a.png', 'other-1-a.png', 'queue-img-1-a.png\n', 'queue-img-1-A B.png',
  ])('refuses %j', (id) => {
    expect(isQueueImageId(id)).toBe(false);
  });

  it('resolves an id to the file while it is still there', () => {
    expect(resolveQueueImage('queue-img-1760000000000-ab12cd.png', dir)).toBe(join(dir, 'queue-img-1760000000000-ab12cd.png'));
  });

  it('resolves nothing for a missing file, a folder or a malformed id', () => {
    expect(resolveQueueImage('queue-img-1760000000000-gone.png', dir)).toBeNull();
    expect(resolveQueueImage('queue-img-1760000000000-folder.png', dir)).toBeNull();
    expect(resolveQueueImage('../queue-img-1760000000000-ab12cd.png', dir)).toBeNull();
  });
});
