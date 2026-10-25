/**
 * WorkerBadge — the mark a session card carries while a central (server/mcp) has handed it a task that is not
 * over: the worker's side of the central's ★ badge.
 *
 *   ← ★ global · T12 · running      ← ★ room Backend · T12 · blocked      ← ★ project app · T3 · stalled
 *
 * It reads the open task of its session from `mcpStore` (the `mcp_task_update` feed and the read of the tasks in
 * flight), and the central that sent it from the same store, so it needs nothing from the card but the session's id
 * and renders nothing when there is no task (and once it is done, failed or cancelled: the work is over, and when
 * central sessions are known to be off here: whatever task is still held belongs to a ledger that is gone). A room's
 * name comes from the room store (plain `★ room` when that room is gone, `★ central` when the central is not in the
 * list). Its colour follows the state: quiet while the prompt is on its way, the central's colour while the session
 * works, a warning when it waits on a dialog or a fault, so a blocked worker stands out in a long list. Hovering it
 * gives the task (the central's own words), who sent it and what its state means, in the shared Tooltip.
 *
 * It is a mark, not a control: no button, no tab stop. It sits inside the rail's cards, which are buttons, and a
 * focusable thing inside a button is two controls in one. The words are the accessible name, spelled out
 * ("Task T12 from the global central: running") instead of arrows and stars; with `compact` (the task id alone,
 * for a card with no room for words) the name is the same.
 *
 * Squeezed (a card in the top rail has ~110px of text), the scope gives way first: it is cut with an ellipsis down
 * to about 14 characters, and below that it goes altogether, with its separator, so the badge reads `T12 · running`
 * and not `← ★… · T12 · running` (a fragment that names no central; rendered check, Oct 2026). The tooltip and the
 * accessible name always carry the whole scope. The CSS does it (WorkerBadge.module.css), so the words below stay in
 * one order for a screen reader, a copy and a test.
 */
import Tooltip from '@/components/ui/Tooltip';
import { useMcpStore, openTaskFor } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  workerBadgeCompactText,
  workerBadgeLabel,
  workerBadgeScope,
  workerBadgeTask,
  workerBadgeTip,
  workerBadgeTone,
  WORKER_BADGE_SEPARATOR,
  type WorkerBadgeTone,
} from '@/lib/centralActivity';
import styles from '@/styles/modules/WorkerBadge.module.css';

interface WorkerBadgeProps {
  /** The session whose task is shown (its card's id). */
  sessionId: string;
  /** The task id alone, with the whole badge in its accessible name and its tooltip. */
  compact?: boolean;
  /** For the card or header the badge sits in (its place in that layout). */
  className?: string;
}

const TONE_CLASS: Record<WorkerBadgeTone, string> = {
  pending: styles.pending,
  running: styles.running,
  attention: styles.attention,
};

export default function WorkerBadge({ sessionId, compact = false, className }: WorkerBadgeProps) {
  // Each selector answers a stable value (the object the store holds, or a string), so the badge re-renders when
  // its own task, its central or its room's name changes, and not when anything else does.
  const task = useMcpStore((s) => openTaskFor(s.tasks, sessionId));
  const central = useMcpStore((s) => (task ? s.centrals.get(task.centralId) : undefined));
  // Known to be off (a 404 for the centrals): the ledger that held the task is gone, so a task still held here is
  // stale and must not go on saying a worker is running. Not yet known (null) is not "off": the feed proves it.
  const off = useMcpStore((s) => s.available === false);
  const roomName = useRoomStore((s) =>
    central?.kind === 'room' ? s.rooms.find((r) => r.id === central.scopeRef)?.name : undefined,
  );
  if (!task || off) return null;

  const tone = `${styles.badge} ${TONE_CLASS[workerBadgeTone(task.state)]}`;
  const tip = workerBadgeTip(task, central, roomName);
  return (
    <span className={className ? `${styles.root} ${className}` : styles.root}>
      <Tooltip label={tip.label} description={tip.description} placement="bottom">
        <span
          className={compact ? `${tone} ${styles.compact}` : tone}
          role="img"
          aria-label={workerBadgeLabel(task, central, roomName)}
        >
          {compact ? (
            workerBadgeCompactText(task)
          ) : (
            <>
              <span className={styles.lead}>
                <span className={styles.scope}>{workerBadgeScope(central, roomName)}</span>
                <span className={styles.sep}>{WORKER_BADGE_SEPARATOR}</span>
              </span>
              <span className={styles.rest}>{workerBadgeTask(task)}</span>
            </>
          )}
        </span>
      </Tooltip>
    </span>
  );
}
