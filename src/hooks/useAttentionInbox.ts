/**
 * useAttentionInbox — the header bell's list, and what a new moment does (Nov 26 2026). Used once, by AttentionBell in
 * the main window's header (Full only; a pop-out has no header, the phone its own screens).
 *
 * The list is src/lib/attentionInbox.ts `waitingItems` over the sessions, the alerts centrals raised and each
 * session's alert level, less what the person hid with ×. A moment that is new since the last look and still stands
 * after HINT_SETTLE_MS shows a hint, unless the person is looking at that session. A central's new alert also sounds
 * and notifies as its level says (src/lib/raisedAlerts.ts caps it by the session's own level): a session's own
 * question, approval and proceed ask already sound through the alarm engine and notify through
 * useAlertNotifications / useProceedNotifications, so they only hint here.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { useAttentionStore } from '@/stores/attentionStore';
import { alertOf } from '@/lib/sessionAlertLevel';
import { HINT_SETTLE_MS, newMoments, waitingItems, type InboxSession, type WaitItem } from '@/lib/attentionInbox';
import { soundEngine } from '@/lib/soundEngine';
import type { AlertConfig } from '@/lib/attention';

/** The person is looking at this session now: the window has focus and its panel is open. */
function lookingAt(sessionId: string): boolean {
  if (typeof document === 'undefined' || !document.hasFocus()) return false;
  const selected = useSessionStore.getState().selectedSessionId;
  return selected === sessionId && !useUiStore.getState().detailPanelMinimized;
}

/** A central's new alert: its level's sound, and a desktop notification when the level notifies every moment. */
function announceAlert(item: WaitItem, config: AlertConfig): void {
  const outputs = config.levels[item.level];
  if (outputs.sound === 'loud') soundEngine.playLoud('bells');
  else if (outputs.sound === 'normal') soundEngine.play('inputNeeded');
  if (outputs.notify === 'all') {
    window.electronAPI?.notify?.({ sessionId: item.sessionId, title: item.title, body: item.detail })
      .catch(() => { /* no notification is not worth a toast */ });
  }
}

export function useAttentionInbox(): { items: WaitItem[]; count: number } {
  const sessions = useSessionStore((s) => s.sessions);
  const rooms = useRoomStore((s) => s.rooms);
  const config = useAlertConfigStore((s) => s.config);
  const alerts = useAttentionStore((s) => s.alerts);
  const hidden = useAttentionStore((s) => s.hidden);
  const seenAt = useAttentionStore((s) => s.seenAt);

  const items = useMemo(
    () =>
      waitingItems(sessions.values() as Iterable<InboxSession>, alerts, {
        alertOf: (s) => {
          const a = alertOf(s, rooms, config);
          return { level: a.level, outputs: a.outputs };
        },
        outputsOf: (level) => config.levels[level],
        seenAt,
      }),
    [sessions, alerts, rooms, config, seenAt],
  );
  const visible = useMemo(() => items.filter((i) => !hidden.has(i.key)), [items, hidden]);

  const latest = useRef<WaitItem[]>(visible);
  const prevKeys = useRef<ReadonlySet<string> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    latest.current = visible;
  }, [visible]);

  useEffect(() => {
    useAttentionStore.getState().track(items, Date.now());
    const fresh = newMoments(prevKeys.current, items);
    prevKeys.current = new Set(items.map((i) => i.key));
    if (fresh.length === 0) return;
    const keys = new Set(fresh.map((i) => i.key));
    const t = setTimeout(() => {
      timers.current.delete(t);
      const standing = latest.current.filter((i) => keys.has(i.key));
      const shown = standing.filter((i) => !lookingAt(i.sessionId));
      if (shown.length > 0) useAttentionStore.getState().showHint(shown, Date.now());
      const cfg = useAlertConfigStore.getState().config;
      for (const item of standing) if (item.kind === 'alert') announceAlert(item, cfg);
    }, HINT_SETTLE_MS);
    timers.current.add(t);
  }, [items]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  return { items: visible, count: visible.length };
}
