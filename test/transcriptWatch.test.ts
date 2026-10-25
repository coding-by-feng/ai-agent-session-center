// transcriptWatch.test.ts — the Mac tells a reading phone the moment a session's transcript grows (Oct 22 2026):
// watched only on a lease each chat read renews, size-gated, coalesced, capped, and dropped when the file is
// replaced or the watcher fails.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranscriptWatch, LEASE_MS } from '../server/chat/transcriptWatch.js';

/** fs.watch and the file sizes, by hand. */
function fakeFs() {
  const sizes = new Map<string, number>();
  const listeners = new Map<string, { change: (event: string) => void; fail: (err: unknown) => void; closed: boolean }>();
  return {
    sizes,
    listeners,
    watch: vi.fn((path: string, change: (event: string) => void, fail: (err: unknown) => void) => {
      const entry = { change, fail, closed: false };
      listeners.set(path, entry);
      return { close: () => { entry.closed = true; } };
    }),
    sizeOf: async (path: string) => sizes.get(path) ?? null,
    open: () => [...listeners.entries()].filter(([, l]) => !l.closed).map(([p]) => p),
  };
}

describe('createTranscriptWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onGrow once per burst of writes, and not for a change that left the size alone', async () => {
    const fs = fakeFs();
    const onGrow = vi.fn();
    const w = createTranscriptWatch({ onGrow, watch: fs.watch, sizeOf: fs.sizeOf });
    fs.sizes.set('/t/a.jsonl', 100);
    w.touch('s1', '/t/a.jsonl');
    await vi.advanceTimersByTimeAsync(0);

    fs.sizes.set('/t/a.jsonl', 180);
    const l = fs.listeners.get('/t/a.jsonl')!;
    l.change('change');
    l.change('change');
    l.change('change');
    await vi.advanceTimersByTimeAsync(150);
    expect(onGrow).toHaveBeenCalledTimes(1);
    expect(onGrow).toHaveBeenCalledWith('s1');

    l.change('change'); // touched, same size
    await vi.advanceTimersByTimeAsync(150);
    expect(onGrow).toHaveBeenCalledTimes(1);
  });

  it('stops watching when no read renewed the lease, and keeps watching while reads keep coming', async () => {
    const fs = fakeFs();
    const w = createTranscriptWatch({ onGrow: vi.fn(), watch: fs.watch, sizeOf: fs.sizeOf });
    w.touch('s1', '/t/a.jsonl');
    await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
    w.touch('s1', '/t/a.jsonl');
    expect(fs.watch).toHaveBeenCalledTimes(1); // renewed, not re-watched
    await vi.advanceTimersByTimeAsync(LEASE_MS - 1_000);
    expect(w.watched()).toEqual(['s1']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(w.watched()).toEqual([]);
    expect(fs.open()).toEqual([]);
  });

  it('watches at most maxFiles: the one whose lease ends first makes room', async () => {
    const fs = fakeFs();
    const w = createTranscriptWatch({ onGrow: vi.fn(), watch: fs.watch, sizeOf: fs.sizeOf, maxFiles: 2 });
    w.touch('s1', '/t/1.jsonl');
    await vi.advanceTimersByTimeAsync(10);
    w.touch('s2', '/t/2.jsonl');
    await vi.advanceTimersByTimeAsync(10);
    w.touch('s1', '/t/1.jsonl'); // s1 renewed: s2 now ends first
    w.touch('s3', '/t/3.jsonl');
    expect(w.watched().sort()).toEqual(['s1', 's3']);
    expect(fs.open().sort()).toEqual(['/t/1.jsonl', '/t/3.jsonl']);
  });

  it('follows a session to a new transcript file', () => {
    const fs = fakeFs();
    const w = createTranscriptWatch({ onGrow: vi.fn(), watch: fs.watch, sizeOf: fs.sizeOf });
    w.touch('s1', '/t/old.jsonl');
    w.touch('s1', '/t/new.jsonl');
    expect(fs.open()).toEqual(['/t/new.jsonl']);
  });

  it('a replaced file says it changed and is dropped; a failing watcher is dropped quietly', () => {
    const fs = fakeFs();
    const onGrow = vi.fn();
    const w = createTranscriptWatch({ onGrow, watch: fs.watch, sizeOf: fs.sizeOf });
    w.touch('s1', '/t/a.jsonl');
    w.touch('s2', '/t/b.jsonl');
    fs.listeners.get('/t/a.jsonl')!.change('rename');
    fs.listeners.get('/t/b.jsonl')!.fail(new Error('EMFILE'));
    expect(onGrow).toHaveBeenCalledWith('s1');
    expect(onGrow).toHaveBeenCalledTimes(1);
    expect(w.watched()).toEqual([]);
  });

  it('a file that cannot be watched is simply not watched', () => {
    const w = createTranscriptWatch({ onGrow: vi.fn(), watch: () => { throw new Error('ENOENT'); } });
    expect(() => w.touch('s1', '/nope')).not.toThrow();
    expect(w.watched()).toEqual([]);
  });

  it('close stops every watcher', () => {
    const fs = fakeFs();
    const w = createTranscriptWatch({ onGrow: vi.fn(), watch: fs.watch, sizeOf: fs.sizeOf });
    w.touch('s1', '/t/a.jsonl');
    w.touch('s2', '/t/b.jsonl');
    w.close();
    expect(fs.open()).toEqual([]);
  });
});

describe('createTranscriptWatch on a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aasc-transcript-watch-'));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hears an appended line', async () => {
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '{"type":"user"}\n');
    const grew = new Promise<string>((resolve) => {
      const w = createTranscriptWatch({ onGrow: (id) => { w.close(); resolve(id); } });
      w.touch('real', file);
      setTimeout(() => appendFileSync(file, '{"type":"assistant"}\n'), 50);
    });
    await expect(grew).resolves.toBe('real');
  });
});
