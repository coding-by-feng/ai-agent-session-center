/**
 * AgendaTaskCard — one task: checkbox, title (click or Enter to edit), a quiet
 * priority control, an icon group (edit tags, delete), and a meta row (due
 * date, tags, details) that renders only when there is meta to show.
 *
 * Layout notes (Oct 2026):
 * - A task with no tags, date or details is ONE line. The add-tag "+" used to
 *   sit alone on a second row of every such card; it is now the "Edit tags"
 *   icon beside delete.
 * - The priority control is quiet (dot + sentence case, no box until hover):
 *   the group heading above already says URGENT, so a loud per-card URGENT
 *   badge repeated it on every row. It stays a real control.
 * - The title is a <button>: the old click-only <span> was unreachable by
 *   keyboard.
 *
 * Focus never falls to <body>: finishing an edit by keyboard returns focus to
 * what opened it, closing the delete confirm returns it to the trash button,
 * and deleting moves it to the next card (else the neighbouring group).
 *
 * Inline edit pattern follows RobotListSidebar.tsx (Enter to commit, Escape to
 * cancel, blur to commit).
 */
import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import IconButton from '@/components/ui/IconButton';
import TrashIcon from '@/components/ui/TrashIcon';
import UnfoldIcon from '@/components/ui/UnfoldIcon';
import type { AgendaTask, AgendaPriority } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRIORITY_CLASS: Record<AgendaPriority, string> = {
  urgent: styles.priorityUrgent,
  high: styles.priorityHigh,
  medium: styles.priorityMedium,
  low: styles.priorityLow,
};

const PRIORITY_LABEL: Record<AgendaPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// Highest first, matching the group order on the page.
const PRIORITY_CHOICES: AgendaPriority[] = ['urgent', 'high', 'medium', 'low'];

function getDueDateStatus(dueDate?: string): 'overdue' | 'today' | 'future' | null {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + 'T00:00:00');
  if (due < today) return 'overdue';
  if (due.getTime() === today.getTime()) return 'today';
  return 'future';
}

function formatDueDate(dueDate: string): string {
  const d = new Date(dueDate + 'T00:00:00');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Enter that only confirms an IME candidate (Chinese/Japanese input) must not
 * commit the edit. Chromium flags it `isComposing`; WebKit fires that Enter
 * after compositionend with isComposing=false but keyCode 229.
 */
function isImeEnter(e: KeyboardEvent<HTMLInputElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * Where focus goes once a card is deleted: the next card's title, else the
 * previous one's, else a neighbouring group's header, else the new-task field.
 */
function focusAfterRemoval(card: HTMLElement | null): void {
  const item = card?.closest('li');
  const group = item?.closest('section');
  const candidates = [
    item?.nextElementSibling?.querySelector<HTMLElement>('[data-task-title]'),
    item?.previousElementSibling?.querySelector<HTMLElement>('[data-task-title]'),
    group?.nextElementSibling?.querySelector<HTMLElement>('button[aria-expanded]'),
    group?.previousElementSibling?.querySelector<HTMLElement>('button[aria-expanded]'),
    card?.closest('[data-testid="agenda-view"]')?.querySelector<HTMLElement>('form input'),
  ];
  candidates.find(Boolean)?.focus();
}

function TagGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgendaTaskCardProps {
  task: AgendaTask;
}

export default function AgendaTaskCard({ task }: AgendaTaskCardProps) {
  const toggleTask = useAgendaStore((s) => s.toggleTask);
  const updateTask = useAgendaStore((s) => s.updateTask);
  const deleteTask = useAgendaStore((s) => s.deleteTask);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [editingTags, setEditingTags] = useState(false);
  const [tagsDraft, setTagsDraft] = useState('');
  const [showDesc, setShowDesc] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagsInputRef = useRef<HTMLInputElement>(null);
  const tagsButtonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  // Set only by KEYBOARD endings (Enter / Escape), never by blur: a blur means
  // the user put focus somewhere else on purpose, and stealing it back would
  // undo their click.
  const restoreTitleFocus = useRef(false);
  const restoreTagsFocus = useRef(false);
  const restoreDeleteFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreTitleFocus.current) {
      restoreTitleFocus.current = false;
      titleRef.current?.focus();
    }
  }, [editing]);

  useEffect(() => {
    if (editingTags) {
      tagsInputRef.current?.focus();
    } else if (restoreTagsFocus.current) {
      restoreTagsFocus.current = false;
      tagsButtonRef.current?.focus();
    }
  }, [editingTags]);

  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
    } else if (restoreDeleteFocus.current) {
      restoreDeleteFocus.current = false;
      deleteRef.current?.focus();
    }
  }, [confirming]);

  const startEditing = useCallback(() => {
    setDraft(task.title);
    setEditing(true);
  }, [task.title]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== task.title) {
      updateTask(task.id, { title: trimmed });
    } else {
      setDraft(task.title);
    }
  }, [draft, task.id, task.title, updateTask]);

  const handleDelete = useCallback(() => {
    // Move focus first, while this card (and so its neighbours' order) is
    // still in the DOM; the optimistic delete then unmounts it.
    focusAfterRemoval(cardRef.current);
    deleteTask(task.id);
    setConfirming(false);
  }, [deleteTask, task.id]);

  const cancelDelete = useCallback(() => {
    restoreDeleteFocus.current = true;
    setConfirming(false);
  }, []);

  const startEditingTags = useCallback(() => {
    setTagsDraft(task.tags.join(', '));
    setEditingTags(true);
  }, [task.tags]);

  const commitTagsEdit = useCallback(() => {
    setEditingTags(false);
    const newTags = tagsDraft
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const oldTags = task.tags.join(',');
    const newTagsStr = newTags.join(',');
    if (oldTags !== newTagsStr) {
      updateTask(task.id, { tags: newTags });
    }
  }, [tagsDraft, task.id, task.tags, updateTask]);

  const dueDateStatus = getDueDateStatus(task.dueDate);
  const hasMeta = Boolean(task.dueDate) || task.tags.length > 0 || Boolean(task.description) || editingTags;

  // Build card className
  const cardClasses = [styles.card];
  if (task.completed) cardClasses.push(styles.completed);
  if (!task.completed && dueDateStatus === 'overdue') cardClasses.push(styles.overdue);
  if (!task.completed && dueDateStatus === 'today') cardClasses.push(styles.dueToday);

  const descId = `agenda-desc-${task.id}`;
  const named = `"${task.title}"`;

  return (
    <div ref={cardRef} className={cardClasses.join(' ')} data-task-id={task.id}>
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={task.completed}
        onChange={() => toggleTask(task.id)}
        aria-label={`Mark ${named} as ${task.completed ? 'incomplete' : 'complete'}`}
      />

      <div className={styles.cardMain}>
        <div className={styles.cardLine}>
          {editing ? (
            <input
              ref={inputRef}
              className={styles.titleInput}
              aria-label="Task title"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (isImeEnter(e)) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  restoreTitleFocus.current = true;
                  commitEdit();
                }
                if (e.key === 'Escape') {
                  restoreTitleFocus.current = true;
                  setDraft(task.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              ref={titleRef}
              type="button"
              className={styles.title}
              onClick={startEditing}
              title={task.title}
              data-task-title=""
            >
              {task.title}
            </button>
          )}

          <span className={`${styles.priority} ${PRIORITY_CLASS[task.priority]}`}>
            <span className={styles.priorityDot} aria-hidden="true" />
            <select
              className={styles.prioritySelect}
              value={task.priority}
              onChange={(e) => updateTask(task.id, { priority: e.target.value as AgendaPriority })}
              aria-label={`Priority of ${named}`}
              title="Change priority"
            >
              {PRIORITY_CHOICES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
            <span className={styles.priorityChevron} aria-hidden="true"><ChevronGlyph /></span>
          </span>
        </div>

        {hasMeta && (
          <div className={styles.meta} data-task-meta="">
            {task.dueDate && (
              <Chip tone={task.completed ? 'neutral' : dueDateStatus === 'overdue' ? 'danger' : dueDateStatus === 'today' ? 'warning' : 'neutral'}>
                {!task.completed && dueDateStatus === 'overdue' && 'Overdue · '}
                {!task.completed && dueDateStatus === 'today' && 'Today · '}
                {formatDueDate(task.dueDate)}
              </Chip>
            )}
            {editingTags ? (
              <input
                ref={tagsInputRef}
                className={styles.tagInput}
                aria-label={`Tags of ${named}, comma-separated`}
                value={tagsDraft}
                onChange={(e) => setTagsDraft(e.target.value)}
                onBlur={commitTagsEdit}
                onKeyDown={(e) => {
                  if (isImeEnter(e)) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    restoreTagsFocus.current = true;
                    commitTagsEdit();
                  }
                  if (e.key === 'Escape') {
                    restoreTagsFocus.current = true;
                    setEditingTags(false);
                  }
                }}
                placeholder="tag1, tag2"
              />
            ) : (
              task.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={styles.tag}
                  onClick={startEditingTags}
                  title="Edit tags"
                >
                  #{t}
                </button>
              ))
            )}
            {task.description && (
              <Button
                variant="quiet"
                size="sm"
                icon={<UnfoldIcon expanded={showDesc} />}
                aria-expanded={showDesc}
                aria-controls={descId}
                onClick={() => setShowDesc((v) => !v)}
              >
                Details
              </Button>
            )}
          </div>
        )}

        {task.description && showDesc && (
          <div id={descId} className={styles.description}>{task.description}</div>
        )}
      </div>

      <div className={styles.cardActions}>
        {confirming ? (
          <div
            className={styles.confirm}
            role="group"
            aria-label={`Delete ${named}?`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelDelete();
            }}
          >
            <span className={styles.confirmText}>Delete?</span>
            <Button variant="danger" size="sm" onClick={handleDelete}>Delete</Button>
            <Button ref={cancelRef} variant="quiet" size="sm" onClick={cancelDelete}>Cancel</Button>
          </div>
        ) : (
          <>
            <IconButton
              ref={tagsButtonRef}
              label="Edit tags"
              ariaLabel={`Edit tags of ${named}`}
              onClick={startEditingTags}
            >
              <TagGlyph />
            </IconButton>
            <IconButton
              ref={deleteRef}
              label="Delete task"
              ariaLabel={`Delete ${named}`}
              tone="danger"
              onClick={() => setConfirming(true)}
            >
              <TrashIcon />
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}
