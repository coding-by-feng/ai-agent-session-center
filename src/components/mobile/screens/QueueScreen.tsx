/**
 * QueueScreen — the Queue tab's root (AASC-47, design §5.7): every session's
 * queue in one list.
 *
 *   Queue                                          ＋
 *   ⓘ Your Mac sends queued prompts                       who fires them, always
 *     AASC is open on your Mac (MacBook).
 *   AGENT-MANAGER-2 · 3                              ›    → this session's queue
 *   Auto-send on · Auto-Enter on
 *   │ ≡  1  Run the tests again            ⚡ │      hold ≡ to reorder; ⚡ send now
 *   │ ≡  2  Then update the docs           ⚡ │      tap = the full edit form
 *
 * Swipe a row for Move and Delete (Delete confirms); hold it for the same plus
 * Edit, Send now and Move up / down. The edit form is the session queue's own
 * (chains, loops, quiet hours, photos), full screen; the group header opens the
 * session's queue screen for adding prompts, automation switches and history.
 * The Mac's scheduler, not this phone, sends queued prompts.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type CSSProperties } from 'react';
import type { Session } from '@/types';
import { Banner, ConfirmSheet, ContextMenu, EmptyState, ListRow, ListSection, Screen, Sheet, SwipeRow } from '../kit';
import type { ContextMenuItem, SwipeAction } from '../kit';
import { ChevronRightIcon, QueueTabIcon } from '../kit/kitIcons';
import { PlusIcon } from '../phoneIcons';
import ConnectionBanner from './ConnectionBanner';
import QueueItemEditModal from '@/components/session/QueueItemEditModal';
import QueueMoveSheet from '@/components/session/QueueMoveSheet';
import { DEFAULT_AUTOMATION, useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { getClientId } from '@/lib/deviceIdentity';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { infoPath } from '@/lib/chat/phoneRoutes';
import { automationWords, itemSummary, moveId, promptLine, queueGroups, senderLine, type QueueGroup } from '@/lib/chat/queueTabModel';
import { sendQueueItemNow } from '@/lib/chat/queueSendNow';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/mobile/PhoneQueue.module.css';

/** A finger held this long on ≡ picks the row up; moving first cancels. */
export const REORDER_HOLD_MS = 250;
const HOLD_SLOP_PX = 10;
const FIT = ['fit'] as const;

interface Drag {
  sessionId: string;
  itemId: number;
  from: number;
  target: number;
  dy: number;
  rowH: number;
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 8h14M5 12h14M5 16h14" />
    </svg>
  );
}

interface RowProps {
  session: Session;
  item: QueueItem;
  index: number;
  count: number;
  drag: Drag | null;
  onEdit: (item: QueueItem) => void;
  onMove: (item: QueueItem) => void;
  onDelete: (item: QueueItem) => void;
  onReorder: (sessionId: string, from: number, to: number) => void;
  onDragChange: (drag: Drag | null) => void;
}

function QueueRow({ session, item, index, count, drag, onEdit, onMove, onDelete, onReorder, onDragChange }: RowProps) {
  const rowRef = useRef<HTMLLIElement>(null);
  const hold = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout>; armed: boolean; pointer: number } | null>(null);
  const [sendingNow, setSendingNow] = useState(false);
  const n = index + 1;
  const line = promptLine(item);
  const summary = itemSummary(item);
  const sid = session.sessionId;
  // Every group has a prompt 1: the session's name keeps the spoken names apart.
  const whose = `prompt ${n} for ${sessionDisplayTitle(session)}`;

  // Where this row sits while another is being dragged past it.
  let offset = 0;
  const dragging = drag?.sessionId === sid && drag.itemId === item.id;
  if (drag && drag.sessionId === sid && !dragging) {
    if (drag.from < drag.target && index > drag.from && index <= drag.target) offset = -drag.rowH;
    if (drag.from > drag.target && index < drag.from && index >= drag.target) offset = drag.rowH;
  }

  const sendNow = async () => {
    if (sendingNow) return;
    setSendingNow(true);
    try {
      await sendQueueItemNow(session, item);
    } finally {
      setSendingNow(false);
    }
  };

  const endHold = () => {
    if (hold.current) clearTimeout(hold.current.timer);
    hold.current = null;
  };

  const onHandleDown = (e: PointerEvent<HTMLButtonElement>) => {
    // The handle is its own gesture: not the row's swipe, not its long-press menu.
    e.stopPropagation();
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: the moves still reach the handle */
    }
    const { clientX: x, clientY: y, pointerId } = e;
    hold.current = {
      x,
      y,
      pointer: pointerId,
      armed: false,
      timer: setTimeout(() => {
        if (!hold.current) return;
        hold.current.armed = true;
        navigator.vibrate?.(10);
        const rowH = rowRef.current?.getBoundingClientRect().height ?? 64;
        onDragChange({ sessionId: sid, itemId: item.id, from: index, target: index, dy: 0, rowH });
      }, REORDER_HOLD_MS),
    };
  };

  const onHandleMove = (e: PointerEvent<HTMLButtonElement>) => {
    const h = hold.current;
    if (!h || h.pointer !== e.pointerId) return;
    const dy = e.clientY - h.y;
    if (!h.armed) {
      if (Math.hypot(e.clientX - h.x, dy) > HOLD_SLOP_PX) endHold();
      return;
    }
    if (!drag) return;
    const target = Math.max(0, Math.min(count - 1, index + Math.round(dy / drag.rowH)));
    onDragChange({ ...drag, dy, target });
  };

  const onHandleUp = (e: PointerEvent<HTMLButtonElement>) => {
    const h = hold.current;
    if (!h || h.pointer !== e.pointerId) return;
    const wasArmed = h.armed;
    endHold();
    if (!wasArmed || !drag) return;
    onDragChange(null);
    if (e.type !== 'pointercancel' && drag.target !== drag.from) onReorder(sid, drag.from, drag.target);
  };

  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      onReorder(sid, index, index - 1);
    } else if (e.key === 'ArrowDown' && index < count - 1) {
      e.preventDefault();
      onReorder(sid, index, index + 1);
    }
  };

  const swipeActions: SwipeAction[] = [
    { id: 'move', label: 'Move', onAction: () => onMove(item) },
    { id: 'delete', label: 'Delete', tone: 'destructive', onAction: () => onDelete(item) },
  ];
  const menuItems: ContextMenuItem[] = [
    { id: 'edit', label: 'Edit', onSelect: () => onEdit(item) },
    { id: 'now', label: 'Send now', disabledReason: item.disabled ? 'This prompt is paused.' : undefined, onSelect: () => void sendNow() },
    { id: 'top', label: 'Move to top', disabledReason: index === 0 ? 'It is first already.' : undefined, onSelect: () => onReorder(sid, index, 0) },
    { id: 'up', label: 'Move up', disabledReason: index === 0 ? 'It is first already.' : undefined, onSelect: () => onReorder(sid, index, index - 1) },
    { id: 'down', label: 'Move down', disabledReason: index === count - 1 ? 'It is last already.' : undefined, onSelect: () => onReorder(sid, index, index + 1) },
    { id: 'move', label: 'Move to another session…', onSelect: () => onMove(item) },
    { id: 'delete', label: 'Delete…', destructive: true, onSelect: () => onDelete(item) },
  ];

  return (
    <li
      ref={rowRef}
      className={styles.item}
      data-dragging={dragging ? '' : undefined}
      data-shifted={offset !== 0 ? '' : undefined}
      style={{ '--drag-y': `${dragging ? drag!.dy : offset}px` } as CSSProperties}
      data-testid={`queue-row-${item.id}`}
    >
      <SwipeRow actions={swipeActions}>
        <ContextMenu items={menuItems} label={`Actions for ${whose}`}>
          <div className={styles.row} data-disabled={item.disabled ? '' : undefined}>
            <button
              type="button"
              className={styles.handle}
              aria-label={`Reorder ${whose}: hold and drag, or use the up and down arrow keys`}
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              onKeyDown={onHandleKey}
              onContextMenu={(e) => e.preventDefault()}
            >
              <GripIcon />
            </button>
            <button type="button" className={styles.main} onClick={() => onEdit(item)} aria-label={`${whose[0].toUpperCase()}${whose.slice(1)}: ${line}${summary ? `, ${summary}` : ''}. Edit`}>
              <span className={styles.num} aria-hidden="true">{n}</span>
              <span className={styles.text}>
                <span className={styles.line}>{line}</span>
                {summary && <span className={styles.summary}>{summary}</span>}
              </span>
            </button>
            <button
              type="button"
              className={styles.now}
              onClick={() => void sendNow()}
              aria-label={`Send ${whose} now`}
              aria-disabled={item.disabled || sendingNow ? true : undefined}
              aria-busy={sendingNow || undefined}
            >
              <BoltIcon />
            </button>
          </div>
        </ContextMenu>
      </SwipeRow>
    </li>
  );
}

function GroupHeader({ group, onOpen }: { group: QueueGroup; onOpen: () => void }) {
  const automation = useQueueStore((s) => s.automation.get(group.session.sessionId) ?? DEFAULT_AUTOMATION);
  const title = sessionDisplayTitle(group.session);
  return (
    <button type="button" className={styles.groupHeader} onClick={onOpen} aria-label={`${title}, ${group.items.length} queued, ${automationWords(automation)}. Open its queue`}>
      <span className={styles.groupText}>
        <span className={styles.groupTitle}>{title} · {group.items.length}</span>
        <span className={styles.groupState} data-paused={automation.paused ? '' : undefined}>{automationWords(automation)}</span>
      </span>
      <ChevronRightIcon />
    </button>
  );
}

export default function QueueScreen() {
  const queues = useQueueStore((s) => s.queues);
  const sessions = useSessionStore((s) => s.sessions);
  const received = usePresenceStore((s) => s.received);
  const workspaceWriter = usePresenceStore((s) => s.workspaceWriter);
  const devices = usePresenceStore((s) => s.devices);
  const push = usePhoneNavStore((s) => s.push);
  const reorder = useQueueStore((s) => s.reorder);
  const updateItem = useQueueStore((s) => s.updateItem);
  const remove = useQueueStore((s) => s.remove);
  const moveToSession = useQueueStore((s) => s.moveToSession);

  const groups = useMemo(() => queueGroups(queues, sessions), [queues, sessions]);
  const sender = useMemo(() => senderLine({ received, workspaceWriter, devices }, getClientId()), [received, workspaceWriter, devices]);

  const [drag, setDrag] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<{ sessionId: string; itemId: number } | null>(null);
  const [moving, setMoving] = useState<QueueItem | null>(null);
  const [deleting, setDeleting] = useState<QueueItem | null>(null);
  const [picking, setPicking] = useState(false);
  const closeMove = useCallback(() => setMoving(null), []);
  const cancelDelete = useCallback(() => setDeleting(null), []);
  const closePicker = useCallback(() => setPicking(false), []);

  const onReorder = useCallback((sessionId: string, from: number, to: number) => {
    const items = useQueueStore.getState().queues.get(sessionId) ?? [];
    const ids = [...items].sort((a, b) => a.position - b.position).map((i) => i.id);
    const next = moveId(ids, from, to);
    if (next.join() !== ids.join()) reorder(sessionId, next);
  }, [reorder]);

  const editItem = editing ? (queues.get(editing.sessionId) ?? []).find((i) => i.id === editing.itemId) : undefined;
  const editSession = editing ? sessions.get(editing.sessionId) : undefined;
  const editAutomation = useQueueStore((s) => (editing ? s.automation.get(editing.sessionId) ?? DEFAULT_AUTOMATION : DEFAULT_AUTOMATION));
  const moveTargets = useMemo(
    () => (moving
      ? [...sessions.values()]
        .filter((s) => s.sessionId !== moving.sessionId && s.status !== 'ended' && !s.isFloating)
        .map((s) => ({ id: s.sessionId, projectName: s.projectName, title: sessionDisplayTitle(s) }))
      : []),
    [moving, sessions],
  );
  const liveSessions = useMemo(
    () => [...sessions.values()].filter((s) => s.status !== 'ended' && !s.isFloating).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
    [sessions],
  );

  const actions = (
    <button type="button" className={styles.navAction} onClick={() => setPicking(true)} aria-label="Queue a prompt" aria-haspopup="dialog">
      <PlusIcon />
    </button>
  );

  return (
    <Screen title="Queue" large banner={<ConnectionBanner />} actions={actions} testId="phone-queue">
      <div className={styles.sender}>
        <Banner tone={sender.tone === 'ok' ? 'info' : 'warning'} title={sender.title}>{sender.detail}</Banner>
      </div>
      {groups.length === 0 ? (
        <EmptyState
          icon={<QueueTabIcon />}
          title="Nothing queued"
          message="Queue a prompt for a session and your Mac sends it when the session is free."
        />
      ) : groups.map((group) => (
        <ListSection
          key={group.session.sessionId}
          header={<GroupHeader group={group} onOpen={() => push(infoPath(group.session.sessionId, 'queue'))} />}
          className={styles.group}
        >
          {group.items.map((item, index) => (
            <QueueRow
              key={item.id}
              session={group.session}
              item={item}
              index={index}
              count={group.items.length}
              drag={drag}
              onEdit={(it) => setEditing({ sessionId: group.session.sessionId, itemId: it.id })}
              onMove={setMoving}
              onDelete={setDeleting}
              onReorder={onReorder}
              onDragChange={setDrag}
            />
          ))}
        </ListSection>
      ))}

      {editItem && editSession && editing && (
        <QueueItemEditModal
          item={editItem}
          autoSendEnabled={editAutomation.autoSend}
          sessionId={editing.sessionId}
          projectPath={editSession.projectPath}
          onClose={() => setEditing(null)}
          onSave={(patch) => updateItem(editing.sessionId, editItem.id, patch)}
          onDelete={() => {
            remove(editing.sessionId, editItem.id);
            setEditing(null);
          }}
        />
      )}
      <QueueMoveSheet
        open={moving !== null}
        targets={moveTargets}
        onSelect={(to) => {
          if (moving) {
            moveToSession([moving.id], moving.sessionId, to);
            showToast('Prompt moved', 'info');
          }
          setMoving(null);
        }}
        onClose={closeMove}
      />
      <ConfirmSheet
        open={deleting !== null}
        title="Delete this prompt?"
        message={deleting ? `“${promptLine(deleting)}” leaves this session’s queue on every device.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleting) remove(deleting.sessionId, deleting.id);
          setDeleting(null);
        }}
        onCancel={cancelDelete}
      />
      <Sheet open={picking} onClose={closePicker} title="Queue a prompt for…" detents={FIT} testId="queue-pick-session">
        {liveSessions.length === 0 ? (
          <EmptyState title="No live sessions" message="Start a session first, then queue prompts for it." />
        ) : (
          <ListSection label="Sessions" footer="Its queue opens, with the box to add a prompt.">
            {liveSessions.map((s) => (
              <ListRow
                key={s.sessionId}
                title={sessionDisplayTitle(s)}
                subtitle={s.projectName}
                chevron
                onClick={() => {
                  setPicking(false);
                  push(infoPath(s.sessionId, 'queue'));
                }}
              />
            ))}
          </ListSection>
        )}
      </Sheet>
    </Screen>
  );
}
