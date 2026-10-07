/**
 * QueueView — the QUEUE tab: every session's queued prompts in one place.
 *
 * A compose card on top adds a plain prompt to any session; below it, one table
 * per session that has queued prompts, each row with Move (to another session)
 * and Remove. It is the simple cross-session list: no type pills, chains or
 * automation — those live in each session's own QUEUE tab (`QueueTab`).
 *
 * Built from the shared primitives in `src/components/ui/`. The Move menu is the
 * portaled, viewport-placed `QueueMovePicker` the per-session tab uses, so it
 * stays inside the window and takes its colours from the active theme.
 */
import { useCallback, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { isMac } from '@/lib/shortcutKeys';
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import { showToast } from '@/components/ui/ToastContainer';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import TextArea from '@/components/ui/TextArea';
import TrashIcon from '@/components/ui/TrashIcon';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import SectionHeader from '@/components/ui/SectionHeader';
import QueueMovePicker, {
  MOVE_TRIGGER_ATTR,
  type QueueMoveTarget,
} from '@/components/session/QueueMovePicker';
import type { Session } from '@/types';
import styles from '@/styles/modules/Queue.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = Date.now();
function localId(): number {
  return nextId++;
}

/** "1 prompt" / "2 prompts": the number with its noun, pluralised. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

/** "14:32" for today; "Oct 6, 14:32" otherwise, with the year only if it is not this one. */
function formatAdded(ts: number, now: number = Date.now()): string {
  const added = new Date(ts);
  const today = new Date(now);
  if (added.toDateString() === today.toDateString()) {
    return added.toLocaleTimeString('en-US', TIME_OPTIONS);
  }
  const year = added.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' as const };
  return added.toLocaleString('en-US', { month: 'short', day: 'numeric', ...year, ...TIME_OPTIONS });
}

/** "project — title", or a short id for a session with no project name. */
function sessionLabel(id: string, projectName: string | undefined, title: string | undefined): string {
  return `${projectName || id.slice(0, 8)}${title ? ` — ${title}` : ''}`;
}

const NO_TARGETS: QueueMoveTarget[] = [];

/** Every row's Move button — where focus goes when a neighbouring row leaves. */
const MOVE_TRIGGER = `[${MOVE_TRIGGER_ATTR}]`;

// ---------------------------------------------------------------------------
// Move menu state, shared by every row
// ---------------------------------------------------------------------------

/**
 * One menu is open at most, so its state lives in the view: a row's own state
 * would let two rows hold a menu open at once (the picker ignores clicks on any
 * Move button, so opening a second would not close the first).
 */
interface MoveController {
  /** The prompt whose Move menu is open. */
  itemId: number | null;
  /** The Move button the menu hangs off; placement is measured from it. */
  anchor: HTMLElement | null;
  /** Every session but the open prompt's own. */
  targets: QueueMoveTarget[];
  toggle: (itemId: number, fromSessionId: string, anchor: HTMLElement) => void;
  confirm: (toSessionId: string) => void;
  close: () => void;
}

interface MovingState {
  itemId: number;
  fromSessionId: string;
  anchor: HTMLElement;
}

// ---------------------------------------------------------------------------
// One queued prompt
// ---------------------------------------------------------------------------

interface QueueRowProps {
  item: QueueItem;
  position: number;
  sessionId: string;
  move: MoveController;
  onRemove: (sessionId: string, itemId: number, row: Element | null) => void;
}

function QueueRow({ item, position, sessionId, move, onRemove }: QueueRowProps) {
  const moveOpen = move.itemId === item.id;
  const added = formatAdded(item.createdAt);
  return (
    <tr>
      <td className={styles.pos}>{position}</td>
      {/* `data-added` lets a narrow layout show the time under the prompt in
          place of the Added column (see Queue.module.css). */}
      <td className={styles.text} data-added={added}>{item.text}</td>
      <td className={styles.added}>{added}</td>
      <td className={styles.actions}>
        <div className={styles.actionsRow}>
          <Button
            size="sm"
            className={styles.moveBtn}
            {...{ [MOVE_TRIGGER_ATTR]: item.id }}
            aria-haspopup="listbox"
            aria-expanded={moveOpen}
            aria-label={`Move prompt ${position} to another session`}
            // The button is the picker's anchor; capture it before state flips.
            onClick={(e) => move.toggle(item.id, sessionId, e.currentTarget)}
          >
            Move
          </Button>
          <IconButton
            label="Remove from queue"
            ariaLabel={`Remove prompt ${position} from the queue`}
            tone="danger"
            size="sm"
            className={styles.removeBtn}
            onClick={(e) => onRemove(sessionId, item.id, e.currentTarget.closest('tr'))}
          >
            <TrashIcon />
          </IconButton>
        </div>
        {moveOpen && (
          <QueueMovePicker
            anchor={move.anchor}
            targets={move.targets}
            onSelect={move.confirm}
            onClose={move.close}
          />
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// One session's prompts
// ---------------------------------------------------------------------------

interface QueueGroupProps {
  sessionId: string;
  session: Session | undefined;
  items: QueueItem[];
  move: MoveController;
  onRemove: (sessionId: string, itemId: number, row: Element | null) => void;
}

function QueueGroup({ sessionId, session, items, move, onRemove }: QueueGroupProps) {
  const shortId = sessionId.slice(0, 8);
  const name = session?.projectName || shortId;
  return (
    <section className={styles.group}>
      <SectionHeader
        level={2}
        sticky
        label={
          // The id is noise beside the name, but it is the only handle on a
          // session with no project name, so it stays one hover away.
          <span title={`Session ${shortId}`}>
            <span className={styles.groupName}>{name}</span>
            {session?.title && <span className={styles.groupTitle}> — {session.title}</span>}
          </span>
        }
        count={items.length}
        countLabel={plural(items.length, 'prompt')}
      />
      <div className={styles.tableCard}>
        <table className={styles.table} aria-label={`Queued prompts for ${name}`}>
          <thead>
            <tr>
              <th scope="col" className={styles.pos} title="Position in this session's queue">#</th>
              <th scope="col">Prompt</th>
              <th scope="col" className={styles.added}>Added</th>
              <th scope="col" className={styles.actions}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <QueueRow
                key={item.id}
                item={item}
                position={idx + 1}
                sessionId={sessionId}
                move={move}
                onRemove={onRemove}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function QueueView() {
  const queues = useQueueStore((s) => s.queues);
  const add = useQueueStore((s) => s.add);
  const remove = useQueueStore((s) => s.remove);
  const moveToSession = useQueueStore((s) => s.moveToSession);
  const sessions = useSessionStore((s) => s.sessions);

  const [composeSessionId, setComposeSessionId] = useState('');
  const [composeText, setComposeText] = useState('');
  const [moving, setMoving] = useState<MovingState | null>(null);
  const hintId = useId();
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /** Before a row leaves (Remove, or Move to another session) its focused
   *  button would drop focus to <body>: hand it to the nearest other row's Move
   *  button, across session tables, else to the compose box. */
  const focusPastRow = useCallback((row: Element | null) => {
    focusSiblingAfterRemoval(row, MOVE_TRIGGER, composeRef.current, bodyRef.current);
  }, []);

  const handleRemove = useCallback(
    (sessionId: string, itemId: number, row: Element | null) => {
      focusPastRow(row);
      remove(sessionId, itemId);
    },
    [focusPastRow, remove],
  );

  // Sessions that have at least one queued prompt.
  const sessionIds = Array.from(
    new Set([...queues.keys(), ...sessions.keys()]),
  ).filter((sid) => {
    const items = queues.get(sid);
    return items && items.length > 0;
  });

  const totalItems = Array.from(queues.values()).reduce(
    (sum, items) => sum + items.length,
    0,
  );
  const summary = `${plural(totalItems, 'queued prompt')} · ${plural(sessionIds.length, 'session')}`;

  const sessionOptions = useMemo<NativeSelectOption[]>(
    () => [
      { value: '', label: 'Choose a session…' },
      ...Array.from(sessions, ([sid, s]) => ({
        value: sid,
        label: sessionLabel(sid, s.projectName, s.title),
      })),
    ],
    [sessions],
  );

  // ---- Add prompt to a session ----
  // A chosen session that has since ended and left the map reads as no choice:
  // the select would otherwise show blank while Add stayed enabled for it.
  const targetSessionId = sessions.has(composeSessionId) ? composeSessionId : '';
  const canAdd = composeText.trim() !== '' && targetSessionId !== '';

  const handleAdd = useCallback(() => {
    const trimmed = composeText.trim();
    if (!trimmed || !targetSessionId) return;
    const items = queues.get(targetSessionId) ?? [];
    const newItem: QueueItem = {
      id: localId(),
      sessionId: targetSessionId,
      text: trimmed,
      position: items.length,
      createdAt: Date.now(),
    };
    add(targetSessionId, newItem);
    setComposeText('');
    showToast('Prompt added to queue', 'info', 2000);
  }, [composeText, targetSessionId, queues, add]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleAdd();
  };

  const handleComposeKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleAdd();
    }
  };

  // ---- Move to another session ----
  const toggleMove = useCallback((itemId: number, fromSessionId: string, anchor: HTMLElement) => {
    setMoving((cur) => (cur?.itemId === itemId ? null : { itemId, fromSessionId, anchor }));
  }, []);

  /** Closing without a pick (Escape, a click elsewhere) hands focus back to the
   *  button — without scrolling it back into view if the list moved meanwhile. */
  const closeMovePicker = useCallback(() => {
    moving?.anchor.focus({ preventScroll: true });
    setMoving(null);
  }, [moving]);

  const handleMoveConfirm = useCallback(
    (toSessionId: string) => {
      if (!moving) return;
      focusPastRow(moving.anchor.closest('tr'));
      moveToSession([moving.itemId], moving.fromSessionId, toSessionId);
      setMoving(null);
      showToast('Prompt moved', 'info', 2000);
    },
    [moving, moveToSession, focusPastRow],
  );

  const move: MoveController = {
    itemId: moving?.itemId ?? null,
    anchor: moving?.anchor ?? null,
    targets: moving
      ? Array.from(sessions, ([id, s]) => ({ id, projectName: s.projectName, title: s.title }))
          .filter((target) => target.id !== moving.fromSessionId)
      : NO_TARGETS,
    toggle: toggleMove,
    confirm: handleMoveConfirm,
    close: closeMovePicker,
  };

  return (
    <div className={styles.view} data-testid="queue-view">
      <div className={styles.header}>
        <form className={styles.compose} aria-label="Add a prompt to the queue" onSubmit={handleSubmit}>
          <Field label="Session" className={styles.sessionField}>
            <NativeSelect value={targetSessionId} onChange={setComposeSessionId} options={sessionOptions} />
          </Field>
          <div className={styles.composeRow}>
            <TextArea
              ref={composeRef}
              className={styles.textarea}
              aria-label="Prompt"
              aria-describedby={hintId}
              placeholder="Add a prompt to the queue…"
              rows={2}
              value={composeText}
              onChange={(e) => setComposeText(e.target.value)}
              onKeyDown={handleComposeKeyDown}
            />
            <div className={styles.composeActions}>
              <span id={hintId} className={styles.hint}>
                <span aria-hidden="true">{isMac ? '⌘↵' : 'Ctrl+↵'} to add</span>
                <span className={styles.srOnly}>Press {isMac ? 'Command' : 'Control'} and Enter to add</span>
              </span>
              <Button type="submit" variant="primary" disabled={!canAdd}>
                Add
              </Button>
            </div>
          </div>
        </form>
        <p className={styles.summary}>{summary}</p>
      </div>

      <div ref={bodyRef} className={styles.body}>
        {sessionIds.length === 0 ? (
          <EmptyState
            title="No prompts in the queue"
            hint="Add one above, or from a session's QUEUE tab."
          />
        ) : (
          sessionIds.map((sid) => (
            <QueueGroup
              key={sid}
              sessionId={sid}
              session={sessions.get(sid)}
              items={queues.get(sid) ?? []}
              move={move}
              onRemove={handleRemove}
            />
          ))
        )}
      </div>
    </div>
  );
}
