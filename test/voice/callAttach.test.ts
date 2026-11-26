// callAttach.ts (Nov 24 2026): what a phone adds on the voice call screen. A photo, video or file
// is streamed to the Mac's prompt-media folder under the queue-img name (so the 24 h sweep clears
// it); the call keeps it until the person's next question takes it to the Voice central.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { isQueueImageId } from '../../server/queueImages.js';
import {
  CALL_ATTACH_MAX_BYTES, MAX_CALL_ATTACHMENTS, attachmentKind, cleanFileName, createPendingList, extensionFor, saveCallUpload, skillPick,
} from '../../server/voice/callAttach.js';

describe('attachmentKind / extensionFor / cleanFileName', () => {
  it('sorts a type into photo, video or file', () => {
    expect(attachmentKind('image/jpeg')).toBe('photo');
    expect(attachmentKind('video/quicktime')).toBe('video');
    expect(attachmentKind('application/pdf')).toBe('file');
    expect(attachmentKind('')).toBe('file');
  });

  it('keeps a safe extension from the name, else one from the type, else bin', () => {
    expect(extensionFor('IMG_0001.HEIC', 'image/heic')).toBe('HEIC');
    expect(extensionFor('photo', 'image/png')).toBe('png');
    expect(extensionFor('a.tar.gz', '')).toBe('gz');
    expect(extensionFor('evil.$(rm)', '')).toBe('bin');
    expect(extensionFor('noext', 'application/x-unknown')).toBe('bin');
  });

  it('keeps a readable one-line name, no path, capped', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('a\nb\u0007c.txt')).toBe('a b c.txt');
    expect(cleanFileName('')).toBe('file');
    expect(cleanFileName('x'.repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

describe('skillPick', () => {
  it('takes a /command or $skill name only', () => {
    expect(skillPick('/expense-log')).toBe('/expense-log');
    expect(skillPick('$deploy-krt')).toBe('$deploy-krt');
    expect(skillPick('/plugin:name')).toBe('/plugin:name');
    expect(skillPick('expense-log')).toBeNull();
    expect(skillPick('/rm -rf ~')).toBeNull();
    expect(skillPick(`/${'a'.repeat(200)}`)).toBeNull();
  });
});

describe('createPendingList', () => {
  it('puts taken items back in front, up to the cap, and answers what did not fit', () => {
    const list = createPendingList(2);
    list.add({ kind: 'skill', name: '/a' });
    const taken = list.take();
    list.add({ kind: 'skill', name: '/b' });
    list.add({ kind: 'skill', name: '/c' });
    expect(list.putBack(taken)).toEqual([{ kind: 'skill', name: '/c', id: 'att3' }]);
    expect(list.items().map((a) => a.name)).toEqual(['/a', '/b']);
  });

  it('holds up to the cap, removes by id, and hands everything over once', () => {
    const list = createPendingList();
    for (let i = 0; i < MAX_CALL_ATTACHMENTS; i += 1) expect(list.add({ kind: 'skill', name: `/s${i}` })).not.toBeNull();
    expect(list.add({ kind: 'skill', name: '/one-too-many' })).toBeNull();
    const [first] = list.items();
    expect(list.remove(first.id)).toBe(true);
    expect(list.remove(first.id)).toBe(false);
    expect(list.items()).toHaveLength(MAX_CALL_ATTACHMENTS - 1);
    expect(list.take()).toHaveLength(MAX_CALL_ATTACHMENTS - 1);
    expect(list.items()).toEqual([]);
  });
});

describe('saveCallUpload', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'call-attach-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('streams the bytes under a queue-img name the sweep knows', async () => {
    const saved = await saveCallUpload(Readable.from([Buffer.from('hello')]), { dir, ext: 'txt' });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(isQueueImageId(saved.path.split('/').pop() ?? '')).toBe(true);
    expect(readFileSync(saved.path, 'utf8')).toBe('hello');
  });

  it('refuses a body over the cap and leaves no partial file', async () => {
    const saved = await saveCallUpload(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), { dir, ext: 'bin', maxBytes: 15 });
    expect(saved).toEqual({ ok: false, code: 'too_large' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses an empty body', async () => {
    expect(await saveCallUpload(Readable.from([]), { dir, ext: 'bin' })).toEqual({ ok: false, code: 'empty' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('caps at 100 MB by default', () => {
    expect(CALL_ATTACH_MAX_BYTES).toBe(100 * 1024 * 1024);
  });
});
