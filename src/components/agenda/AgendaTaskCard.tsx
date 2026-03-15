/**
 * AgendaTaskCard — Single task card with checkbox, inline title editing,
 * priority badge, due date, tags, expandable description, and delete.
 *
 * Inline edit pattern follows RobotListSidebar.tsx (click title to edit,
 * Enter to commit, Escape to cancel, blur to commit).
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  const [showDesc, setShowDesc] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Sync draft with task title when it changes externally
  useEffect(() => {
    if (!editing) {
      setDraft(task.title);
    }
  }, [task.title, editing]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== task.title) {
      updateTask(task.id, { title: trimmed });
    } else {
      setDraft(task.title);
    }
  }, [draft, task.id, task.title, updateTask]);

  const handleToggle = useCallback(() => {
    toggleTask(task.id);
  }, [toggleTask, task.id]);

  const handleDelete = useCallback(() => {
    deleteTask(task.id);
    setConfirming(false);
  }, [deleteTask, task.id]);

  const dueDateStatus = getDueDateStatus(task.dueDate);

  // Build card className
  const cardClasses = [styles.taskCard];
  if (task.completed) cardClasses.push(styles.completed);
  if (!task.completed && dueDateStatus === 'overdue') cardClasses.push(styles.overdue);
  if (!task.completed && dueDateStatus === 'today') cardClasses.push(styles.dueToday);

  return (
    <div className={cardClasses.join(' ')}>
      {/* Checkbox */}
      <input
        type="checkbox"
        className={styles.checkbox}
        checked={task.completed}
        onChange={handleToggle}
        aria-label={`Mark "${task.title}" as ${task.completed ? 'incomplete' : 'complete'}`}
      />

      {/* Content */}
      <div className={styles.taskContent}>
        <div className={styles.taskHeader}>
          {/* Title (editable) */}
          {editing ? (
            <input
              ref={inputRef}
              className={styles.taskTitleInput}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === 'Escape') {
                  setDraft(task.title);
                  setEditing(false);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={styles.taskTitle}
              onClick={() => {
                setDraft(task.title);
                setEditing(true);
              }}
              title="Click to edit"
            >
              {task.title}
            </span>
          )}

          {/* Priority badge */}
          <span className={`${styles.priorityBadge} ${PRIORITY_CLASS[task.priority]}`}>
            {task.priority}
          </span>
        </div>

        {/* Meta row: due date + tags */}
        <div className={styles.taskMeta}>
          {task.dueDate && (
            <span
              className={`${styles.dueDate} ${
                dueDateStatus === 'overdue' ? styles.dueDateOverdue : ''
              } ${dueDateStatus === 'today' ? styles.dueDateToday : ''}`}
            >
              {dueDateStatus === 'overdue' && 'Overdue: '}
              {dueDateStatus === 'today' && 'Today: '}
              {formatDueDate(task.dueDate)}
            </span>
          )}
          {task.tags.map((t) => (
            <span key={t} className={styles.tag}>
              {t}
            </span>
          ))}
        </div>

        {/* Description expandable */}
        {task.description && (
          <>
            <button
              className={styles.descriptionToggle}
              onClick={() => setShowDesc((v) => !v)}
            >
              {showDesc ? '- Hide details' : '+ Show details'}
            </button>
            {showDesc && (
              <div className={styles.description}>{task.description}</div>
            )}
          </>
        )}
      </div>

      {/* Delete */}
      {confirming ? (
        <div className={styles.confirmOverlay}>
          <span>Delete?</span>
          <button className={styles.confirmBtn} onClick={handleDelete}>
            Yes
          </button>
          <button
            className={styles.cancelBtn}
            onClick={() => setConfirming(false)}
          >
            No
          </button>
        </div>
      ) : (
        <button
          className={styles.deleteBtn}
          onClick={() => setConfirming(true)}
          aria-label={`Delete "${task.title}"`}
          title="Delete task"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      )}
    </div>
  );
}
