/**
 * attentionStore — the header bell's state (Nov 26 2026): the alerts centrals raised (from the server: `GET /api/alerts`
 * after each connect, then every `alerts_update`, already cut for this device), the items the person hid with ×, when
 * each item was first seen, and the hint on screen. The rules are src/lib/attentionInbox.ts; useAttentionInbox drives
 * them.
 */
import { create } from 'zustand';
import type { Hint, WaitItem } from '@/lib/attentionInbox';
import { mergeHint, pruneHidden } from '@/lib/attentionInbox';
import type { RaisedAlert } from '@/types';

interface AttentionState {
  alerts: RaisedAlert[];
  /** Keys of session items the person hid with ×, until that moment is over. */
  hidden: ReadonlySet<string>;
  /** When each listed item was first seen in this window. */
  seenAt: ReadonlyMap<string, number>;
  hint: Hint | null;
  setAlerts: (alerts: RaisedAlert[]) => void;
  /** × on a row: a session's item hides here; a central's alert is dismissed for everyone. */
  dismiss: (item: WaitItem) => void;
  /** Close a central's alert for every device (the bell's ×, the phone Inbox's Dismiss). */
  dismissAlert: (alertId: string) => void;
  /** The items listed now: forget hides and first sightings of items that went, note the new ones. */
  track: (items: readonly WaitItem[], now: number) => void;
  showHint: (fresh: readonly WaitItem[], now: number) => void;
  clearHint: () => void;
}

export const useAttentionStore = create<AttentionState>((set, get) => ({
  alerts: [],
  hidden: new Set(),
  seenAt: new Map(),
  hint: null,

  setAlerts: (alerts) => set({ alerts: Array.isArray(alerts) ? alerts : [] }),

  dismiss: (item) => {
    const { hint } = get();
    const clearedHint = hint?.item.key === item.key ? { hint: null } : {};
    if (item.alertId) {
      if (clearedHint.hint === null) set(clearedHint);
      get().dismissAlert(item.alertId);
      return;
    }
    set((s) => ({ hidden: new Set([...s.hidden, item.key]), ...clearedHint }));
  },

  dismissAlert: (id) => {
    set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
    fetch(`/api/alerts/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => { /* the next alerts_update says what the server has */ });
  },

  track: (items, now) => {
    const { hidden, seenAt } = get();
    const nextHidden = pruneHidden(hidden, items);
    const keys = new Set(items.map((i) => i.key));
    let changed = seenAt.size !== keys.size || [...seenAt.keys()].some((k) => !keys.has(k));
    const nextSeen = new Map<string, number>();
    for (const key of keys) {
      const at = seenAt.get(key);
      if (at === undefined) changed = true;
      nextSeen.set(key, at ?? now);
    }
    if (!changed && nextHidden === hidden) return;
    set({ hidden: nextHidden, ...(changed ? { seenAt: nextSeen } : {}) });
  },

  showHint: (fresh, now) => {
    const next = mergeHint(get().hint, fresh, now);
    if (next !== get().hint) set({ hint: next });
  },

  clearHint: () => set({ hint: null }),
}));

/** Read the server's alerts once (after each connect: an `alerts_update` sent while the socket was down is not replayed). */
export async function fetchAlerts(): Promise<void> {
  try {
    const res = await fetch('/api/alerts', { method: 'GET' });
    if (!res.ok) return;
    const body = (await res.json()) as { alerts?: unknown } | null;
    if (body && Array.isArray(body.alerts)) useAttentionStore.getState().setAlerts(body.alerts as RaisedAlert[]);
  } catch {
    /* best-effort: the next alerts_update brings the list */
  }
}
