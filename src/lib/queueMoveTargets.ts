/**
 * queueMoveTargets — the sessions a queued prompt can move to, listed the same
 * way by every "Move to another session" picker: the phone Queue screen's sheet
 * (QueueScreen → QueueMoveSheet), a session's Queue tab (QueueTab →
 * QueueMovePicker, or the sheet at phone width) and the desktop QUEUE page
 * (QueueView → QueueMovePicker).
 *
 * You pick a target by its name (Oct 29 2026): each row leads with
 * `sessionDisplayTitle`, adds the folder only when it says something the name
 * doesn't, and the list runs A→Z. Only live sessions (`isListedSession`): a
 * prompt moved onto an ended session or a floating popup is never sent.
 */
import type { Session } from '@/types';
import { isListedSession } from '@/lib/sessionSort';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';

export interface QueueMoveTarget {
  id: string;
  /** The session's name, as every list shows it (`sessionDisplayTitle`). */
  name: string;
  /** Its project folder, when that differs from the name. */
  project?: string;
}

/** Natural A→Z: case ignored, "Codex 2" before "Codex 10". */
const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function toTarget(s: Session): QueueMoveTarget {
  const name = sessionDisplayTitle(s);
  const project = s.projectName?.trim();
  return project && NAME_ORDER.compare(project, name) !== 0
    ? { id: s.sessionId, name, project }
    : { id: s.sessionId, name };
}

/** Every live session but `fromSessionId`, by name, then folder, then the most recently active. */
export function queueMoveTargets(sessions: Iterable<Session>, fromSessionId: string): QueueMoveTarget[] {
  return [...sessions]
    .filter((s) => s.sessionId !== fromSessionId && isListedSession(s))
    .map((s) => ({ target: toTarget(s), lastActivityAt: s.lastActivityAt ?? 0 }))
    .sort((a, b) =>
      NAME_ORDER.compare(a.target.name, b.target.name)
      || NAME_ORDER.compare(a.target.project ?? '', b.target.project ?? '')
      || b.lastActivityAt - a.lastActivityAt
      || a.target.id.localeCompare(b.target.id))
    .map(({ target }) => target);
}
