/**
 * useSyncAutoload — when the RESOURCES tab reads the cloud sync list (Oct 23 2026): as soon as this
 * Mac's cloud connection is usable, again on every connection change (a new session epoch), and
 * after every catalog scan, since a local edit changes a resource's state. Never on a timer: a read
 * lists every cloud head and hashes each synced resource on disk.
 *
 * The status poll replaces the binding object every 15 s, so the binding is read through a ref
 * rather than being a dependency (that would re-read the list on every poll).
 */
import { useEffect, useRef } from 'react';
import { cacheKey } from './cloudCache';
import { useCloudSession } from './cloudSession';
import { hydrateSyncStatus, loadSyncStatus } from './syncStatusStore';

export function useSyncAutoload(scannedAt: number | string | null): void {
  const session = useCloudSession();
  const binding = session.status.connection;
  const live = useRef(binding);
  useEffect(() => {
    live.current = binding;
  }, [binding]);
  const key = cacheKey(binding);
  const connected = session.status.state === 'connected' && !session.changed;
  useEffect(() => {
    const now = live.current;
    if (!now || !connected) {
      hydrateSyncStatus(key, session.epoch);
      return;
    }
    void loadSyncStatus(now, session.epoch);
  }, [key, session.epoch, connected, scannedAt]);
}
