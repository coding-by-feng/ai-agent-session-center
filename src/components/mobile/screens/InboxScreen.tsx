/**
 * InboxScreen — the Inbox tab's root (AASC-39 placeholder; AASC-43 answers
 * approvals and questions in place).
 *
 * Every session waiting for you (approval, question, interrupted turn), the one
 * waiting longest first. A row opens the session's Chat on this tab's own stack,
 * so back returns to the Inbox (the triage loop).
 */
import { useMemo } from 'react';
import type { Session } from '@/types';
import { EmptyState, ListSection, Screen } from '../kit';
import { InboxTabIcon } from '../kit/kitIcons';
import SessionListRow from './SessionListRow';
import ConnectionBanner from './ConnectionBanner';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { waitingLine, waitingSessions } from '@/lib/chat/inboxModel';
import { sessionPath } from '@/lib/chat/phoneRoutes';

export default function InboxScreen() {
  const sessions = useSessionStore((s) => s.sessions);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const push = usePhoneNavStore((s) => s.push);
  const waiting = useMemo(() => waitingSessions(sessions), [sessions]);

  const open = (session: Session) => push(sessionPath(session.sessionId, 'chat'));

  return (
    <Screen title="Inbox" large banner={<ConnectionBanner />} testId="phone-inbox">
      {!snapshotReceived ? (
        <EmptyState live title="Loading…" />
      ) : waiting.length === 0 ? (
        <EmptyState
          icon={<InboxTabIcon />}
          title="Nothing needs you"
          message="Approvals, questions and turns that stopped show up here."
        />
      ) : (
        <ListSection header="Waiting for you">
          {waiting.map((s) => (
            <SessionListRow key={s.sessionId} session={s} detail={waitingLine(s)} onOpen={open} />
          ))}
        </ListSection>
      )}
    </Screen>
  );
}
