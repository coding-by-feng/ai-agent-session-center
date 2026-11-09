// chunkReload.ts — recover from a lazy screen whose file is gone.
//
// A page left open for hours (the phone app in the background, a browser tab) still runs the
// index.js it loaded. When the Mac's AASC is rebuilt or updated meanwhile, every hashed chunk
// gets a new name, so the next lazy() import asks for a file that no longer exists. Without this,
// the rejection reaches React, nothing catches it, and the whole root unmounts: an empty white
// page that stays until the app is killed. Vite fires `vite:preloadError` for exactly that
// failure; one reload fetches the new index.html and its new chunk names.
//
// At most one automatic reload per CHUNK_RELOAD_WINDOW_MS: if the fresh page fails too (the Mac
// is offline or serving a broken build), the error goes on to AppErrorBoundary, which shows a
// Reload button instead of looping.

export const CHUNK_RELOAD_KEY = 'aasc.chunkReloadAt';
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

/** True when no automatic reload happened in the last CHUNK_RELOAD_WINDOW_MS. */
export function shouldReloadForChunkError(lastReloadAt: string | null, now: number): boolean {
  const last = Number(lastReloadAt);
  if (!lastReloadAt || !Number.isFinite(last) || last > now) return true;
  return now - last > CHUNK_RELOAD_WINDOW_MS;
}

export interface ChunkReloadDeps {
  target: EventTarget;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
  now: () => number;
}

function readStamp(storage: ChunkReloadDeps['storage']): string | null {
  try {
    return storage.getItem(CHUNK_RELOAD_KEY);
  } catch {
    return null; // storage blocked: behave as if we never reloaded
  }
}

function writeStamp(storage: ChunkReloadDeps['storage'], value: string): void {
  try {
    storage.setItem(CHUNK_RELOAD_KEY, value);
  } catch {
    // storage blocked: the reload still happens; the boundary is the backstop
  }
}

export function installChunkReloadGuard(deps: ChunkReloadDeps): () => void {
  const onPreloadError = (event: Event): void => {
    const now = deps.now();
    if (!shouldReloadForChunkError(readStamp(deps.storage), now)) return;
    event.preventDefault();
    writeStamp(deps.storage, String(now));
    deps.reload();
  };
  deps.target.addEventListener('vite:preloadError', onPreloadError);
  return () => deps.target.removeEventListener('vite:preloadError', onPreloadError);
}

/** The browser wiring, for main.tsx. */
export function installBrowserChunkReloadGuard(): void {
  let storage: ChunkReloadDeps['storage'];
  try {
    storage = window.sessionStorage;
  } catch {
    storage = { getItem: () => null, setItem: () => {} };
  }
  installChunkReloadGuard({
    target: window,
    storage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  });
}
