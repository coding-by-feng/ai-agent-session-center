/**
 * The Move markers (`GET /api/project-transfer/moved`), read once while any Projects row shows
 * them: every row subscribes, the first subscriber reads, and when the last one goes (the tab
 * closed) the list is forgotten so the next visit reads it again. A finished Move asks again.
 */
import { useSyncExternalStore } from 'react';
import type { MovedProject } from '@/types/projectTransfer';
import { projectTransferApi } from '@/lib/projectTransferApi';

const EMPTY: MovedProject[] = [];
let moved: MovedProject[] = EMPTY;
let loaded = false;
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function load() {
  loaded = true;
  const asked = ++generation;
  projectTransferApi.moved().then(
    (list) => {
      if (asked !== generation) return;
      moved = Array.isArray(list) ? list : EMPTY;
      emit();
    },
    () => {
      // A decoration only: an older server without the route, or a read that failed, shows no
      // "Moved to" lines. The next visit to the tab asks again.
      if (asked === generation) loaded = false;
    },
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) load();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      loaded = false;
      generation += 1;
      moved = EMPTY;
    }
  };
}

const read = () => moved;
const readNone = () => EMPTY;
const subscribeNone = () => () => {};

/** Ask again (after a Move finished here). */
export function refreshMoved() {
  if (listeners.size > 0) load();
}

/** The marker for this folder, or null. `enabled: false` reads nothing. */
export function useMovedProject(root: string | null, enabled: boolean): MovedProject | null {
  const list = useSyncExternalStore(
    enabled && root ? subscribe : subscribeNone,
    enabled && root ? read : readNone,
  );
  if (!root) return null;
  return list.find((m) => m.root === root) ?? null;
}

/** Tests only. */
export function resetMovedForTests() {
  listeners.clear();
  loaded = false;
  generation += 1;
  moved = EMPTY;
}
