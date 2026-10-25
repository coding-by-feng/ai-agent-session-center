/**
 * PhoneAgenda — the AGENDA tab on a phone (AASC-20, feature 6). The desktop's
 * board edits in place (a title you click, a priority select, a tag field, a
 * hover-revealed delete); on a phone each task is one row with a 44px
 * checkbox, and tapping it opens the task full screen to edit, complete or
 * delete. "+" adds a task from the same form.
 *
 *   [Search tasks…        ] [Filters] [+]
 *   3 open · 1 completed
 *   URGENT · 1
 *   [☐] Ship the release              Urgent · Overdue · Oct 7 · #work
 *
 * The tasks come from the Mac (`/api/agenda`, open to a paired phone), in the
 * same agendaStore and with the same grouping (lib/agendaTasks.ts) as the
 * desktop.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
import {
  AGENDA_PRIORITY_FILTER_OPTIONS,
  AGENDA_PRIORITY_OPTIONS,
  AGENDA_SORT_OPTIONS,
  PRIORITY_LABELS,
  agendaTagOptions,
  groupAgendaTasks,
  parseTags,
} from '@/lib/agendaTasks';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect from '@/components/ui/NativeSelect';
import TextArea from '@/components/ui/TextArea';
import TextInput from '@/components/ui/TextInput';
import { NewSessionIcon } from '@/components/ui/icons';
import type { AgendaPriority, AgendaTask } from '@/types';
import PhoneViewBar from './PhoneViewBar';
import PhoneDateInput from './PhoneDateInput';
import styles from '@/styles/modules/PhoneViews.module.css';

const PRIORITY_ACCENT: Record<AgendaPriority, string> = {
  urgent: 'var(--accent-red)',
  high: 'var(--accent-orange)',
  medium: 'var(--accent-yellow)',
  low: 'var(--accent-green)',
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "Overdue · Oct 7", "Today · Oct 15", "Oct 30": the date with what it means today. */
function dueLabel(task: AgendaTask, today: string): string {
  if (!task.dueDate) return '';
  const d = new Date(`${task.dueDate}T00:00:00`);
  const sameYear = d.getFullYear() === new Date(`${today}T00:00:00`).getFullYear();
  const date = d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
  if (task.completed) return date;
  if (task.dueDate < today) return `Overdue · ${date}`;
  if (task.dueDate === today) return `Today · ${date}`;
  return date;
}

/** Today as YYYY-MM-DD in local time (what the date fields hold). */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function PhoneAgenda() {
  const tasks = useAgendaStore((s) => s.tasks);
  const loading = useAgendaStore((s) => s.loading);
  const filter = useAgendaStore((s) => s.filter);
  const fetchTasks = useAgendaStore((s) => s.fetchTasks);
  const setFilter = useAgendaStore((s) => s.setFilter);
  const toggleTask = useAgendaStore((s) => s.toggleTask);
  // A task id, 'new' for the add form, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [today] = useState(localToday);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const { groups, completedTasks, totalIncomplete, totalCompleted } = useMemo(
    () => groupAgendaTasks(tasks.values(), filter),
    [tasks, filter],
  );
  const tagOptions = useMemo(
    () => [{ value: 'all', label: 'All' }, ...agendaTagOptions(tasks.values(), filter.tag).map((t) => ({ value: t, label: `#${t}` }))],
    [tasks, filter.tag],
  );

  const active = [filter.priority !== 'all', filter.tag !== 'all', filter.showCompleted].filter(Boolean).length;
  const clearFilters = useCallback(
    () => setFilter({ priority: 'all', tag: 'all', showCompleted: false }),
    [setFilter],
  );
  const closeSheet = useCallback(() => setEditing(null), []);
  const editingTask = editing && editing !== 'new' ? tasks.get(editing) : undefined;
  const showCompletedGroup = filter.showCompleted && completedTasks.length > 0;
  const nothingVisible = groups.length === 0 && !showCompletedGroup;

  const row = (task: AgendaTask) => {
    const due = dueLabel(task, today);
    const overdue = !task.completed && !!task.dueDate && task.dueDate < today;
    return (
      <li key={task.id} className={styles.row}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={task.completed}
            onChange={() => void toggleTask(task.id)}
            aria-label={`Mark "${task.title}" as ${task.completed ? 'not done' : 'done'}`}
          />
        </label>
        <button
          type="button"
          className={`${styles.rowButton} ${styles.rowAccent}`}
          style={{ '--row-accent': PRIORITY_ACCENT[task.priority] } as CSSProperties}
          onClick={() => setEditing(task.id)}
          data-task-id={task.id}
        >
          <span className={`${styles.rowTitle}${task.completed ? ` ${styles.done}` : ''}`}>{task.title}</span>
          <span className={styles.rowMeta}>
            {PRIORITY_LABELS[task.priority]}
            {due && <> · <span className={overdue ? styles.overdue : undefined}>{due}</span></>}
            {task.tags.length > 0 && ` · ${task.tags.map((t) => `#${t}`).join(' ')}`}
            {task.description && ' · Details'}
          </span>
        </button>
      </li>
    );
  };

  const body = () => {
    if (loading && tasks.size === 0) return <EmptyState busy fill title="Loading tasks…" />;
    if (tasks.size === 0) {
      return (
        <EmptyState
          fill
          title="No tasks yet"
          action={<Button variant="primary" onClick={() => setEditing('new')}>Add a task</Button>}
        />
      );
    }
    if (nothingVisible && completedTasks.length > 0 && active === 0 && !filter.search) {
      return (
        <EmptyState
          fill
          title="All done"
          hint="Every task is completed."
          action={<Button onClick={() => setFilter({ showCompleted: true })}>{`Show ${completedTasks.length} completed`}</Button>}
        />
      );
    }
    if (nothingVisible) return <EmptyState fill title="No tasks match" hint="Try another search, or clear the filters." />;
    return (
      <>
        {groups.map((g) => (
          <section key={g.id} aria-label={`${g.label}, ${plural(g.tasks.length, 'task')}`}>
            <h2 className={styles.groupHeading}>{g.label} · {g.tasks.length}</h2>
            <ul className={styles.list} role="list">{g.tasks.map(row)}</ul>
          </section>
        ))}
        {showCompletedGroup && (
          <section aria-label={`Completed, ${plural(completedTasks.length, 'task')}`}>
            <h2 className={styles.groupHeading}>Completed · {completedTasks.length}</h2>
            <ul className={styles.list} role="list">{completedTasks.map(row)}</ul>
          </section>
        )}
      </>
    );
  };

  return (
    <div className={styles.view} data-testid="phone-agenda">
      <PhoneViewBar
        searchLabel="Search tasks"
        searchPlaceholder="Search…"
        search={filter.search}
        onSearch={(search) => setFilter({ search })}
        searchDebounceMs={200}
        activeFilters={active}
        onClearFilters={clearFilters}
        summary={`${totalIncomplete} open · ${totalCompleted} completed`}
        action={(
          <IconButton label="New task" tooltip={false} onClick={() => setEditing('new')} aria-haspopup="dialog">
            <NewSessionIcon />
          </IconButton>
        )}
        filters={(
          <>
            <Field label="Priority" className={styles.sheetField}>
              <NativeSelect value={filter.priority} onChange={(priority) => setFilter({ priority })} options={AGENDA_PRIORITY_FILTER_OPTIONS} />
            </Field>
            {tagOptions.length > 1 && (
              <Field label="Tag" className={styles.sheetField}>
                <NativeSelect value={filter.tag} onChange={(tag) => setFilter({ tag })} options={tagOptions} />
              </Field>
            )}
            <Field label="Sort by" className={styles.sheetField}>
              <NativeSelect value={filter.sortBy} onChange={(sortBy) => setFilter({ sortBy })} options={AGENDA_SORT_OPTIONS} />
            </Field>
            <Button pressed={filter.showCompleted} onClick={() => setFilter({ showCompleted: !filter.showCompleted })}>
              Show completed
            </Button>
          </>
        )}
      />
      <div className={styles.scroll}>{body()}</div>
      {(editing === 'new' || editingTask) && (
        <TaskSheet key={editing ?? 'new'} task={editingTask} onClose={closeSheet} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One task, full screen: edit, complete, delete — or a new one
// ---------------------------------------------------------------------------

function TaskSheet({ task, onClose }: { task?: AgendaTask; onClose: () => void }) {
  const createTask = useAgendaStore((s) => s.createTask);
  const updateTask = useAgendaStore((s) => s.updateTask);
  const deleteTask = useAgendaStore((s) => s.deleteTask);
  const toggleTask = useAgendaStore((s) => s.toggleTask);
  const [title, setTitle] = useState(task?.title ?? '');
  const [priority, setPriority] = useState<AgendaPriority>(task?.priority ?? 'medium');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [tags, setTags] = useState(task?.tags.join(', ') ?? '');
  const [details, setDetails] = useState(task?.description ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDelete = useCallback(() => setConfirmDelete(false), []);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    if (task) {
      void updateTask(task.id, {
        title: trimmed,
        priority,
        tags: parseTags(tags),
        description: details.trim(),
        // An emptied date is cleared (null), an untouched empty one left alone.
        dueDate: dueDate || (task.dueDate ? null : undefined),
      });
    } else {
      void createTask({
        title: trimmed,
        priority,
        tags: parseTags(tags),
        dueDate: dueDate || undefined,
        description: details.trim() || undefined,
      });
    }
    onClose();
  };

  return (
    <>
      <BottomSheet open onClose={onClose} title={task ? 'Task' : 'New task'} fullHeight className={styles.dress}>
        <form className={styles.detail} onSubmit={save} aria-label={task ? `Edit "${task.title}"` : 'Add a task'}>
          <div className={`${styles.detailScroll} ${styles.form}`}>
            <Field label="Title" className={styles.sheetField}>
              <TextInput value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={500} enterKeyHint="done" />
            </Field>
            <div className={styles.sheetPair}>
              <Field label="Priority" className={styles.sheetField}>
                <NativeSelect value={priority} onChange={setPriority} options={AGENDA_PRIORITY_OPTIONS} />
              </Field>
              <Field label="Due" className={styles.sheetField}>
                <PhoneDateInput value={dueDate} onChange={setDueDate} emptyLabel="No date" />
              </Field>
            </div>
            <Field label="Tags, comma-separated" className={styles.sheetField}>
              <TextInput value={tags} onChange={(e) => setTags(e.target.value)} placeholder="work, home" />
            </Field>
            <Field label="Details" className={styles.sheetField}>
              <TextArea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} maxLength={5000} />
            </Field>
            {task && (
              <Button
                className={styles.alignStart}
                pressed={task.completed}
                onClick={() => { void toggleTask(task.id); onClose(); }}
              >
                {task.completed ? 'Done — mark not done' : 'Mark done'}
              </Button>
            )}
          </div>
          <div className={styles.detailActions}>
            {task
              ? <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
              : <Button variant="quiet" onClick={onClose}>Cancel</Button>}
            <Button type="submit" variant="primary" disabled={!title.trim()}>{task ? 'Save' : 'Add task'}</Button>
          </div>
        </form>
      </BottomSheet>
      {task && (
        <ConfirmSheet
          open={confirmDelete}
          title="Delete this task?"
          message={`"${task.title}" is removed from your agenda. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { void deleteTask(task.id); setConfirmDelete(false); onClose(); }}
          onCancel={cancelDelete}
        />
      )}
    </>
  );
}
