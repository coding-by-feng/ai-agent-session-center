import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Node 22+ exposes a built-in `localStorage` that lacks standard Web Storage
// methods (getItem, setItem, clear, etc.). When vitest uses jsdom, it should
// override this, but the override may arrive too late. Polyfill if needed.
if (typeof globalThis.localStorage !== 'undefined' &&
    typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(key: string) { return store.get(key) ?? null; },
    key(index: number) { return [...store.keys()][index] ?? null; },
    removeItem(key: string) { store.delete(key); },
    setItem(key: string, value: string) { store.set(key, String(value)); },
  };
  globalThis.localStorage = storage;
}

/**
 * Clear localStorage safely.
 */
export function clearLocalStorage(): void {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.clear === 'function') {
      localStorage.clear();
    }
  } catch {
    // Ignore
  }
}

// Reset localStorage between tests
afterEach(() => {
  clearLocalStorage();
});
