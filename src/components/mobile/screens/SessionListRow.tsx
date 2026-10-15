/**
 * SessionListRow — one session in a phone list (AASC-39 placeholder for the
 * Sessions tab's real rows, AASC-40): status ring, display title, what it is
 * doing in words, and a push to the session.
 */
import type { Session } from '@/types';
import { ListRow, StatusRing } from '../kit';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { sessionStatusLine } from '@/lib/chat/phoneStatus';

export interface SessionListRowProps {
  session: Session;
  /** The line under the title; default: status · project. */
  detail?: string;
  onOpen: (session: Session) => void;
}

export default function SessionListRow({ session, detail, onOpen }: SessionListRowProps) {
  const title = sessionDisplayTitle(session);
  const line = detail ?? sessionStatusLine(session);
  return (
    <ListRow
      tall
      leading={<StatusRing status={session.status} interrupted={!!session.interruption} />}
      title={title}
      subtitle={line}
      chevron
      onClick={() => onOpen(session)}
      ariaLabel={`${title}, ${line}`}
      testId={`session-row-${session.sessionId}`}
    />
  );
}
