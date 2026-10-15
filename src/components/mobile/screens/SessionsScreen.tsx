/**
 * SessionsScreen — the Sessions tab's root (AASC-39 placeholder; AASC-40 builds
 * the real one: host card, filter chips, grouping, swipe and long-press actions).
 *
 * The visible live sessions, the ones waiting for you first, each a push to the
 * session (Chat for Claude Code and Codex, Terminal for anything else).
 */
import { useMemo } from 'react';
import type { Session } from '@/types';
import { EmptyState, ListSection, Screen } from '../kit';
import { SessionsTabIcon } from '../kit/kitIcons';
import SessionListRow from './SessionListRow';
import ConnectionBanner from './ConnectionBanner';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { needsYou } from '@/lib/chat/inboxModel';
import { defaultSegment, sessionPath } from '@/lib/chat/phoneRoutes';
import { detectCli } from '@/lib/cliDetect';

const byRecent = (a: Session, b: Session) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);

export default function SessionsScreen() {
  const sessions = useSessionStore((s) => s.sessions);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const connected = useWsStore((s) => s.connected);
  const hiddenCount = useWsStore((s) => s.hiddenCount);
  const push = usePhoneNavStore((s) => s.push);

  const { waiting, others } = useMemo(() => {
    const live = [...sessions.values()].filter((s) => s.status !== 'ended');
    return {
      waiting: live.filter(needsYou).sort(byRecent),
      others: live.filter((s) => !needsYou(s)).sort(byRecent),
    };
  }, [sessions]);

  const open = (session: Session) => push(sessionPath(session.sessionId, defaultSegment(detectCli(session))));

  let body;
  if (!snapshotReceived) {
    body = <EmptyState live title={connected ? 'Loading sessions…' : 'Connecting to your Mac…'} />;
  } else if (waiting.length + others.length === 0) {
    body = (
      <EmptyState
        icon={<SessionsTabIcon />}
        title="No sessions here yet"
        message={hiddenCount > 0
          ? `${hiddenCount} ${hiddenCount === 1 ? 'session runs' : 'sessions run'} on your Mac but ${hiddenCount === 1 ? 'isn’t' : 'aren’t'} shared with this phone. On your Mac, share a session with 📡.`
          : 'No sessions shared with this phone yet. On your Mac, share a session with 📡.'}
      />
    );
  } else {
    body = (
      <>
        {waiting.length > 0 && (
          <ListSection header="Needs you">
            {waiting.map((s) => <SessionListRow key={s.sessionId} session={s} onOpen={open} />)}
          </ListSection>
        )}
        {others.length > 0 && (
          <ListSection header={waiting.length > 0 ? 'Other sessions' : 'Live sessions'}>
            {others.map((s) => <SessionListRow key={s.sessionId} session={s} onOpen={open} />)}
          </ListSection>
        )}
      </>
    );
  }

  return (
    <Screen title="Sessions" large banner={<ConnectionBanner />} testId="phone-sessions">
      {body}
    </Screen>
  );
}
