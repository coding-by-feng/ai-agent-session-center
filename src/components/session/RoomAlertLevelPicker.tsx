/**
 * RoomAlertLevelPicker — the room frame header's alert level (Nov 25 2026, lib/attention.ts), in place of the one-shot
 * room Alert: the level of the room's sessions that have none of their own, stored on the room (`Room.alertLevel`), so a
 * session filed into it later follows it too. A session's own level wins; the menu offers to clear those in one go.
 * On the Mac's window it is a room-store change; elsewhere an op the Mac applies (`requestRoomChange`). Full only:
 * Lite keeps RoomAlertToggle.
 */
import { useCallback, useMemo } from 'react';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { unalertSession, unmuteSession } from '@/lib/alarmEngine';
import { ALERT_LEVELS, ALERT_LEVEL_LABEL, alertLevelSummary, ownAlertLevel, type AlertLevel } from '@/lib/attention';
import { liveRoomIds } from '@/lib/roomAlert';
import { requestRoomChange, useIsRoomWriter } from '@/lib/roomSync';
import { showToast } from '@/components/ui/ToastContainer';
import Menu, { type MenuSection } from '@/components/ui/Menu';
import { AlertLevelIcon } from '@/components/ui/icons';
import type { Session } from '@/types';
import styles from '@/styles/modules/DetailPanel.module.css';

interface RoomAlertLevelPickerProps {
  roomId: string;
  roomName: string;
  sessionIds: readonly string[];
  /** The sessions the switcher lists (its own `sessions`), so the menu counts the same live cards as the skull. */
  sessions: ReadonlyMap<string, Session>;
}

export default function RoomAlertLevelPicker({ roomId, roomName, sessionIds, sessions }: RoomAlertLevelPickerProps) {
  const roomLevel = useRoomStore((s) => s.rooms.find((r) => r.id === roomId)?.alertLevel);
  const config = useAlertConfigStore((s) => s.config);
  const setAlertLevel = useSessionStore((s) => s.setAlertLevel);
  const isWriter = useIsRoomWriter();
  const live = liveRoomIds(sessionIds, sessions);
  const ownLevelIds = live.filter((id) => {
    const s = sessions.get(id);
    return s !== undefined && ownAlertLevel(s) !== undefined;
  });
  const shown = roomLevel ?? config.defaultLevel;

  const setRoomLevel = useCallback(
    async (level: AlertLevel | null) => {
      const outcome = await requestRoomChange({ type: 'alert-level', roomId, level }, isWriter);
      if (!outcome.ok) showToast(outcome.message, 'error');
    },
    [isWriter, roomId],
  );

  const followRoom = useCallback(() => {
    for (const id of ownLevelIds) {
      unmuteSession(id);
      unalertSession(id);
      setAlertLevel(id, null);
    }
    const n = `${ownLevelIds.length} session${ownLevelIds.length === 1 ? '' : 's'}`;
    showToast(`${n} in ${roomName} now follow the room`, 'info');
  }, [ownLevelIds, roomName, setAlertLevel]);

  const sections = useMemo<MenuSection[]>(() => {
    const levels: MenuSection = {
      id: 'room-alert-level',
      title: `${roomName} alert level`,
      items: [
        {
          kind: 'radio',
          id: 'default',
          label: `Follow default (${ALERT_LEVEL_LABEL[config.defaultLevel]})`,
          hint: 'Use the default level from Settings ▸ Sound',
          icon: <AlertLevelIcon level={config.defaultLevel} />,
          checked: roomLevel === undefined,
          onSelect: () => void setRoomLevel(null),
        },
        ...ALERT_LEVELS.map((level) => ({
          kind: 'radio' as const,
          id: level,
          label: ALERT_LEVEL_LABEL[level],
          hint: alertLevelSummary(config.levels[level]),
          icon: <AlertLevelIcon level={level} />,
          checked: roomLevel === level,
          onSelect: () => void setRoomLevel(level),
        })),
      ],
    };
    if (ownLevelIds.length === 0) return [levels];
    const n = `${ownLevelIds.length} session${ownLevelIds.length === 1 ? '' : 's'}`;
    return [
      levels,
      {
        id: 'room-alert-own',
        items: [{
          kind: 'action',
          id: 'follow-room',
          label: `Make ${n} follow the room`,
          hint: 'They have a level of their own, which wins over the room’s. This clears it.',
          onSelect: followRoom,
        }],
      },
    ];
  }, [config.defaultLevel, config.levels, followRoom, ownLevelIds.length, roomLevel, roomName, setRoomLevel]);

  if (live.length === 0) return null;
  const loud = shown === 'loud' || shown === 'urgent';
  const title = `${roomName}: ${ALERT_LEVEL_LABEL[shown]} alerts${roomLevel === undefined ? ' (default)' : ''}`;
  // The menu is portaled, but React still bubbles its clicks through here: they stop before the room header.
  return (
    <div className={styles.roomAlertWrap} onClick={(e) => e.stopPropagation()}>
    <Menu
      label={`${roomName} alert level`}
      triggerLabel={`Alert level for ${roomName}: ${ALERT_LEVEL_LABEL[shown]}`}
      align="end"
      sections={sections}
      plainTrigger={{
        className: [styles.roomAlertToggle, roomLevel !== undefined && styles.roomAlertSet, loud && styles.roomAlertLoud]
          .filter(Boolean)
          .join(' '),
        content: <AlertLevelIcon level={shown} />,
        title,
      }}
    />
    </div>
  );
}
