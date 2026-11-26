/**
 * sessionAlertLevel — a session's alert level in this window (Nov 25 2026): its own, else its room's
 * (`Room.alertLevel`, room store), else the table's default (alertConfigStore), with what that level does.
 * Rules: src/lib/attention.ts. `sessionAlertOf` reads the stores as they are now (the alarm engine and the
 * notification hooks); `useSessionAlert` follows them, so a card re-renders when its room's level or the
 * table changes.
 */
import { useMemo } from 'react';
import { useRoomStore } from '@/stores/roomStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import {
  describeAlertLevel,
  ownAlertLevel,
  roomAlertLevelOf,
  type AlertConfig,
  type AlertLevel,
  type AlertLevelCarrier,
  type AlertLevelOutputs,
  type AlertLevelSource,
} from '@/lib/attention';
import type { Room } from '@/types';

export interface SessionAlert {
  level: AlertLevel;
  source: AlertLevelSource;
  outputs: AlertLevelOutputs;
  /** The level the session follows when it has none of its own: its room's, else the default. */
  followed: AlertLevel;
  /** Its room's level, when its room has one. */
  roomLevel?: AlertLevel;
}

type Carrier = AlertLevelCarrier & { sessionId: string };

export function alertOf(session: Carrier, rooms: readonly Room[], config: AlertConfig, own?: AlertLevel): SessionAlert {
  const roomLevel = roomAlertLevelOf(session.sessionId, rooms);
  const { level, source } = describeAlertLevel(own ? { alertLevel: own } : session, roomLevel, config.defaultLevel);
  return {
    level,
    source,
    outputs: config.levels[level],
    followed: roomLevel ?? config.defaultLevel,
    ...(roomLevel ? { roomLevel } : {}),
  };
}

/** The session's level from the stores as they are now. `own` stands in for its own level (the alarm engine's click fallback). */
export function sessionAlertOf(session: Carrier, own?: AlertLevel): SessionAlert {
  return alertOf(session, useRoomStore.getState().rooms, useAlertConfigStore.getState().config, own);
}

/** The session's level, re-read when its own level, its room's or the table changes. */
export function useSessionAlert(session: Carrier): SessionAlert {
  const rooms = useRoomStore((s) => s.rooms);
  const config = useAlertConfigStore((s) => s.config);
  const own = ownAlertLevel(session);
  const { sessionId } = session;
  return useMemo(
    () => alertOf({ sessionId, alertLevel: own ?? null }, rooms, config),
    [sessionId, own, rooms, config],
  );
}
