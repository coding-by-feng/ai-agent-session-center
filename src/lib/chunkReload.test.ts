import { describe, it, expect, vi } from 'vitest';
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_WINDOW_MS,
  installChunkReloadGuard,
  shouldReloadForChunkError,
} from './chunkReload';

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe('shouldReloadForChunkError', () => {
  it('reloads when it never reloaded before', () => {
    expect(shouldReloadForChunkError(null, 1_000_000)).toBe(true);
  });

  it('does not reload again inside the window (no reload loop)', () => {
    const now = 1_000_000;
    expect(shouldReloadForChunkError(String(now - 1_000), now)).toBe(false);
  });

  it('reloads again once the window has passed', () => {
    const now = 1_000_000;
    expect(shouldReloadForChunkError(String(now - CHUNK_RELOAD_WINDOW_MS - 1), now)).toBe(true);
  });

  it('treats an unreadable or future stamp as never reloaded', () => {
    expect(shouldReloadForChunkError('garbage', 1_000_000)).toBe(true);
    expect(shouldReloadForChunkError(String(2_000_000), 1_000_000)).toBe(true);
  });
});

describe('installChunkReloadGuard', () => {
  function fire(target: EventTarget): Event {
    const e = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(e);
    return e;
  }

  it('reloads once and swallows the error on the first failed chunk', () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    const reload = vi.fn();
    installChunkReloadGuard({ target, storage, reload, now: () => 5_000_000 });

    const e = fire(target);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('5000000');
  });

  it('lets the error through (to the boundary) when it just reloaded', () => {
    const target = new EventTarget();
    const storage = memoryStorage({ [CHUNK_RELOAD_KEY]: String(5_000_000 - 2_000) });
    const reload = vi.fn();
    installChunkReloadGuard({ target, storage, reload, now: () => 5_000_000 });

    const e = fire(target);

    expect(reload).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('still reloads when storage throws (private mode)', () => {
    const target = new EventTarget();
    const storage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const reload = vi.fn();
    installChunkReloadGuard({ target, storage, reload, now: () => 1 });

    fire(target);

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
