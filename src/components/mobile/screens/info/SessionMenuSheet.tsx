/**
 * SessionMenuSheet — the session screen's ⋯ (AASC-46): the actions used most,
 * one tap away; everything else is on Info (tap the title).
 *
 *   Terminal ›   (AASC-56: the terminal left the tabs; not on the terminal itself)
 *   Restart (Resume once it has ended) · Fork · Mute / Turn notifications on
 *   Info ›
 *   Kill session (red)
 *
 * Restart and Kill confirm in a sheet. Mounted only while open.
 */
import { useCallback, useState } from 'react';
import { ListRow, ListSection, Sheet } from '../../kit';
import SessionSheets, { type SessionSheetKind } from './SessionSheets';
import { forkBlocker, useSessionActions } from './useSessionActions';
import { useSessionStore } from '@/stores/sessionStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { infoPath } from '@/lib/chat/phoneRoutes';
import { restartBlocker } from '@/lib/chat/sessionInfoModel';

const FIT = ['fit'] as const;

export interface SessionMenuSheetProps {
  sessionId: string;
  /** Keep it stable: the sheet's focus handling re-runs when it changes. */
  onClose: () => void;
  /** Opens the session's terminal; the menu offers "Terminal" when given. */
  onTerminal?: () => void;
}

export default function SessionMenuSheet({ sessionId, onClose, onTerminal }: SessionMenuSheetProps) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const push = usePhoneNavStore((s) => s.push);
  const { busy, copy, resume, setNotifications } = useSessionActions();
  // A confirm replaces the menu (one sheet at a time); closing the confirm closes both.
  const [confirm, setConfirm] = useState<SessionSheetKind | null>(null);
  const onConfirmSheet = useCallback((next: SessionSheetKind | null) => {
    setConfirm(next);
    if (next === null) onClose();
  }, [onClose]);

  if (!session) return null;
  const ended = session.status === 'ended';
  const restartWhyNot = restartBlocker(session);
  const forkWhyNot = forkBlocker(session);
  const busyReason = busy ? 'Working on it…' : undefined;
  const thenClose = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <>
      <Sheet open={confirm === null} onClose={onClose} title={sessionDisplayTitle(session)} detents={FIT} testId="session-menu-sheet">
        <ListSection label="Session actions">
          {onTerminal && (
            <ListRow
              title="Terminal"
              subtitle={session.terminalId ? 'Full screen, with keys to type' : 'No terminal right now'}
              chevron
              onClick={thenClose(onTerminal)}
            />
          )}
          {ended ? (
            <ListRow
              title={busy === 'resume' ? 'Resuming…' : 'Resume'}
              subtitle="Start it again where it left off"
              disabledReason={busyReason}
              onClick={thenClose(() => void resume(sessionId))}
            />
          ) : (
            <ListRow title="Restart" subtitle="A fresh terminal, same session" disabledReason={restartWhyNot ?? undefined} onClick={() => setConfirm('restart')} />
          )}
          <ListRow
            title={busy === 'fork' ? 'Forking…' : 'Fork'}
            subtitle="Continue this conversation in a new session"
            disabledReason={forkWhyNot ?? busyReason}
            onClick={thenClose(() => void copy(sessionId, 'fork'))}
          />
          <ListRow
            title={session.muted ? 'Turn notifications on' : 'Mute'}
            subtitle={session.muted ? 'It is muted: no pushes or sounds' : 'No pushes or sounds from this session'}
            onClick={thenClose(() => setNotifications(session, !!session.muted))}
          />
          <ListRow title="Info" subtitle="Model, notes, queue, agents, every action" chevron onClick={thenClose(() => push(infoPath(sessionId)))} />
        </ListSection>
        <ListSection label="Danger">
          <ListRow title="Kill session" destructive disabledReason={ended ? 'It has already ended.' : undefined} onClick={() => setConfirm('kill')} />
        </ListSection>
      </Sheet>
      <SessionSheets sessionId={sessionId} sheet={confirm} onSheet={onConfirmSheet} />
    </>
  );
}
