import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../server/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createScrollbackStore } from '../server/scrollbackStore.js';

describe('scrollbackStore (terminal output across a restart, Nov 25 2026)', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aasc-scrollback-'));
    dir = join(root, 'scrollback');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('saves each ring privately and hands it back once', () => {
    const store = createScrollbackStore(dir);
    expect(store.saveAll([{ sessionId: 'sess-1', data: Buffer.from('hello') }], ['sess-1'])).toBe(1);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'sess-1.bin')).mode & 0o777).toBe(0o600);
    expect(store.take('sess-1')?.toString()).toBe('hello');
    expect(store.take('sess-1')).toBeNull();
  });

  it('keeps the file of a session the server still has without a terminal, and drops the rest', () => {
    const store = createScrollbackStore(dir);
    store.saveAll([
      { sessionId: 'idle-1', data: Buffer.from('old') },
      { sessionId: 'gone-1', data: Buffer.from('old') },
    ], ['idle-1', 'gone-1']);
    // Next quit: idle-1 is still a card (no terminal, so no new ring); gone-1 was killed.
    store.saveAll([{ sessionId: 'live-1', data: Buffer.from('new') }], ['idle-1', 'live-1']);
    expect(readdirSync(dir).sort()).toEqual(['idle-1.bin', 'live-1.bin']);
  });

  it('forgets a killed session and ignores ids that are not safe file names', () => {
    const store = createScrollbackStore(dir);
    store.saveAll([
      { sessionId: 'sess-2', data: Buffer.from('x') },
      { sessionId: '../escape', data: Buffer.from('x') },
      { sessionId: 'empty', data: Buffer.alloc(0) },
    ], []);
    expect(readdirSync(dir)).toEqual(['sess-2.bin']);
    store.forget('sess-2');
    expect(readdirSync(dir)).toEqual([]);
    expect(store.take('../escape')).toBeNull();
  });

  it('leaves files that are not rings alone', () => {
    const store = createScrollbackStore(dir);
    store.saveAll([], []);
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    store.saveAll([], []);
    expect(readdirSync(dir)).toEqual(['notes.txt']);
  });
});
