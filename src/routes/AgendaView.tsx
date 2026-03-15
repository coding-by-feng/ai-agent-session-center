/**
 * AgendaView — Personal task/todo management view.
 * Groups tasks by priority (urgent -> high -> medium -> low),
 * with completed tasks in a collapsible section at the bottom.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
import AgendaFilterBar from '@/components/agenda/AgendaFilterBar';
import AgendaTaskCard from '@/components/agenda/AgendaTaskCard';
import AddTaskForm from '@/components/agenda/AddTaskForm';
import type { AgendaTask, AgendaPriority } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: AgendaPriority[] = ['urgent', 'high', 'medium', 'low'];

const PRIORITY_WEIGHT: Record<AgendaPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_LABELS: Record<AgendaPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesFilter(
  task: AgendaTask,
  search: string,
  priority: AgendaPriority | 'all',
  tag: string | 'all',
): boolean {
  if (priority !== 'all' && task.priority !== priority) return false;
  if (tag !== 'all' && !task.tags.includes(tag)) return false;
  if (search) {
    const q = search.toLowerCase();
    const titleMatch = task.title.toLowerCase().includes(q);
    const descMatch = (task.description ?? '').toLowerCase().includes(q);
    if (!titleMatch && !descMatch) return false;
  }
  return true;
}

function sortTasks(
  tasks: AgendaTask[],
  sortBy: 'priority' | 'dueDate' | 'createdAt',
): AgendaTask[] {
  return [...tasks].sort((a, b) => {
    if (sortBy === 'priority') {
      const pa = PRIORITY_WEIGHT[a.priority];
      const pb = PRIORITY_WEIGHT[b.priority];
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    if (sortBy === 'dueDate') {
      // Tasks without due date go last
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    // createdAt — newest first
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

// ---------------------------------------------------------------------------
// Group Header
// ---------------------------------------------------------------------------

function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.groupHeader} onClick={onToggle}>
      <svg
        className={`${styles.groupChevron} ${collapsed ? styles.collapsed : ''}`}
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span className={styles.groupLabel}>{label}</span>
      <span className={styles.groupCount}>{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AgendaView() {
  const tasks = useAgendaStore((s) => s.tasks);
  const loading = useAgendaStore((s) => s.loading);
  const filter = useAgendaStore((s) => s.filter);
  const fetchTasks = useAgendaStore((s) => s.fetchTasks);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Filter and group tasks
  const { groups, completedTasks, totalIncomplete, totalCompleted } = useMemo(() => {
    const allTasks = [...tasks.values()];
    const filtered = allTasks.filter((t) =>
      matchesFilter(t, filter.search, filter.priority, filter.tag),
    );

    const incomplete = filtered.filter((t) => !t.completed);
    const completed = filtered.filter((t) => t.completed);

    const sorted = sortTasks(incomplete, filter.sortBy);

    // Group by priority
    const grouped = new Map<AgendaPriority, AgendaTask[]>();
    for (const p of PRIORITY_ORDER) {
      grouped.set(p, []);
    }
    for (const task of sorted) {
      const arr = grouped.get(task.priority);
      if (arr) {
        arr.push(task);
      }
    }

    // Build non-empty groups
    const nonEmpty: Array<{ id: AgendaPriority; label: string; tasks: AgendaTask[] }> = [];
    for (const p of PRIORITY_ORDER) {
      const arr = grouped.get(p) ?? [];
      if (arr.length > 0) {
        nonEmpty.push({ id: p, label: PRIORITY_LABELS[p], tasks: arr });
      }
    }

    return {
      groups: nonEmpty,
      completedTasks: sortTasks(completed, filter.sortBy),
      totalIncomplete: incomplete.length,
      totalCompleted: completed.length,
    };
  }, [tasks, filter]);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading tasks...</div>
      </div>
    );
  }

  const noResults = groups.length === 0 && completedTasks.length === 0;
  const noTasks = tasks.size === 0;

  return (
    <div className={styles.container} data-testid="agenda-view">
      <AgendaFilterBar />

      {/* Stats */}
      <div className={styles.stats}>
        <span>
          {totalIncomplete} task{totalIncomplete !== 1 ? 's' : ''}
        </span>
        <span className={styles.statsSep}>|</span>
        <span>
          {totalCompleted} completed
        </span>
      </div>

      {/* Task list */}
      <div className={styles.taskList}>
        {noTasks ? (
          <div className={styles.emptyState}>
            <div>No tasks yet</div>
            <span>Add your first task below</span>
          </div>
        ) : noResults ? (
          <div className={styles.emptyState}>
            <div>No tasks match the current filter</div>
            <span>Try adjusting your search or filter criteria</span>
          </div>
        ) : (
          <>
            {/* Priority groups */}
            {groups.map((group) => {
              const isCollapsed = collapsedGroups.has(group.id);
              return (
                <div key={group.id}>
                  <GroupHeader
                    label={group.label}
                    count={group.tasks.length}
                    collapsed={isCollapsed}
                    onToggle={() => toggleGroup(group.id)}
                  />
                  {!isCollapsed &&
                    group.tasks.map((task) => (
                      <AgendaTaskCard key={task.id} task={task} />
                    ))}
                </div>
              );
            })}

            {/* Completed section */}
            {filter.showCompleted && completedTasks.length > 0 && (
              <div>
                <GroupHeader
                  label="Completed"
                  count={completedTasks.length}
                  collapsed={collapsedGroups.has('__completed__')}
                  onToggle={() => toggleGroup('__completed__')}
                />
                {!collapsedGroups.has('__completed__') &&
                  completedTasks.map((task) => (
                    <AgendaTaskCard key={task.id} task={task} />
                  ))}
              </div>
            )}
          </>
        )}
      </div>

      <AddTaskForm />
    </div>
  );
}
