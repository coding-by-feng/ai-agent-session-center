/**
 * AlertLevelPicker — the selected session's alert level (Nov 25 2026, lib/attention.ts), in place of the Mute and Alert
 * toggles: Silent, Quiet, Normal, Loud or Urgent, or follow its room's level (else the default). Each level's line is
 * what Settings ▸ Sound ▸ Alert levels says that level does. Full only: Lite keeps the two toggles, which the server
 * maps onto levels.
 */
import { useCallback, useMemo } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { unalertSession, unmuteSession } from '@/lib/alarmEngine';
import { ALERT_LEVELS, ALERT_LEVEL_LABEL, alertLevelSummary, type AlertLevel } from '@/lib/attention';
import { useSessionAlert } from '@/lib/sessionAlertLevel';
import Menu, { type MenuSection } from '@/components/ui/Menu';
import { AlertLevelIcon } from '@/components/ui/icons';

interface AlertLevelPickerProps {
  session: Session;
}

export default function AlertLevelPicker({ session }: AlertLevelPickerProps) {
  const setAlertLevel = useSessionStore((s) => s.setAlertLevel);
  const config = useAlertConfigStore((s) => s.config);
  const alert = useSessionAlert(session);
  const { sessionId } = session;

  const choose = useCallback(
    (level: AlertLevel | null) => {
      // A Mute or Alert click made in this window before levels must not outlive the choice (alarmEngine's fallback).
      unmuteSession(sessionId);
      unalertSession(sessionId);
      setAlertLevel(sessionId, level);
    },
    [sessionId, setAlertLevel],
  );

  const followWhat = alert.roomLevel ? 'room' : 'default';
  const followLabel = `Follow ${followWhat} (${ALERT_LEVEL_LABEL[alert.followed]})`;

  const sections = useMemo<MenuSection[]>(
    () => [
      {
        id: 'alert-level',
        title: 'Alert level',
        items: [
          {
            kind: 'radio',
            id: 'follow',
            label: followLabel,
            hint: alert.roomLevel ? 'Use its room’s level' : 'Use the default level from Settings ▸ Sound',
            icon: <AlertLevelIcon level={alert.followed} />,
            checked: alert.source !== 'session',
            onSelect: () => choose(null),
          },
          ...ALERT_LEVELS.map((level) => ({
            kind: 'radio' as const,
            id: level,
            label: ALERT_LEVEL_LABEL[level],
            hint: alertLevelSummary(config.levels[level]),
            icon: <AlertLevelIcon level={level} />,
            checked: alert.source === 'session' && alert.level === level,
            onSelect: () => choose(level),
          })),
        ],
      },
    ],
    [alert.followed, alert.level, alert.roomLevel, alert.source, choose, config.levels, followLabel],
  );

  const name = ALERT_LEVEL_LABEL[alert.level];
  const followed = alert.source === 'session' ? '' : `, from its ${alert.source === 'room' ? 'room' : 'default'}`;
  return (
    <Menu
      label="Alert level"
      triggerLabel={`Alert level: ${name}${followed}`}
      triggerText={name}
      triggerIcon={<AlertLevelIcon level={alert.level} />}
      triggerDescription={`${alertLevelSummary(alert.outputs)}${followed ? ` (${followed.slice(2)})` : ''}`}
      active={alert.level !== config.defaultLevel}
      size="sm"
      sections={sections}
    />
  );
}
