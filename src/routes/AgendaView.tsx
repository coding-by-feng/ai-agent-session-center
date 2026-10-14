/**
 * AgendaView — Personal task/todo management view.
 * Groups tasks by priority (urgent -> high -> medium -> low),
 * with completed tasks in a collapsible section at the bottom.
 *
 * Built from the shared primitives (src/components/ui): SectionHeader for the
 * collapsible groups, EmptyState for loading / empty / filtered-out / all-done.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
import AgendaFilterBar from '@/components/agenda/AgendaFilterBar';
import AgendaTaskCard from '@/components/agenda/AgendaTaskCard';
import AddTaskForm from '@/components/agenda/AddTaskForm';
import SectionHeader from '@/components/ui/SectionHeader';
import EmptyState from '@/components/ui/EmptyState';
import Button from '@/components/ui/Button';
import { groupAgendaTasks } from '@/lib/agendaTasks';
import { useIsMobile } from '@/lib/platform';
import PhoneAgenda from '@/components/mobile/views/PhoneAgenda';
import type { AgendaTask } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

const COMPLETED_GROUP = '__completed__';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Task group
// ---------------------------------------------------------------------------

function TaskGroup({
  id,
  label,
  tasks,
  collapsed,
  onToggle,
}: {
  id: string;
  label: string;
  tasks: AgendaTask[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const regionId = `agenda-group-${id}`;
  return (
    <section className={styles.group}>
      {/* h2: the groups are the page's top-level sections (no page title above
          them). aria-controls only while the list it names is mounted. */}
      <SectionHeader
        level={2}
        label={label}
        count={tasks.length}
        countLabel={plural(tasks.length, 'task', 'tasks')}
        collapsed={collapsed}
        onToggle={onToggle}
        controls={collapsed ? undefined : regionId}
      />
      {/* role="list": Safari/VoiceOver drops list semantics once list-style is none. */}
      {!collapsed && (
        <ul id={regionId} className={styles.taskList} role="list">
          {tasks.map((task) => (
            <li key={task.id}>
              <AgendaTaskCard task={task} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The AGENDA tab. A phone gets its own one-column view (PhoneAgenda, AASC-20):
 * a task opens full screen to edit, and a new one is added from a sheet.
 */
export default function AgendaView() {
  return useIsMobile() ? <PhoneAgenda /> : <DesktopAgenda />;
}

function DesktopAgenda() {
  const tasks = useAgendaStore((s) => s.tasks);
  const loading = useAgendaStore((s) => s.loading);
  const filter = useAgendaStore((s) => s.filter);
  const fetchTasks = useAgendaStore((s) => s.fetchTasks);
  const setFilter = useAgendaStore((s) => s.setFilter);

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

  const { groups, completedTasks, totalIncomplete, totalCompleted } = useMemo(
    () => groupAgendaTasks(tasks.values(), filter),
    [tasks, filter],
  );

  const filtersActive = filter.search !== '' || filter.priority !== 'all' || filter.tag !== 'all';
  const showCompletedGroup = filter.showCompleted && completedTasks.length > 0;
  const nothingVisible = groups.length === 0 && !showCompletedGroup;

  function renderBody() {
    // A refresh keeps the cached list on screen; the spinner is for a cold
    // start only, so a tab switch never blanks the board for a round trip.
    if (loading && tasks.size === 0) return <EmptyState busy fill title="Loading tasks…" />;
    if (tasks.size === 0) {
      return <EmptyState fill title="No tasks yet" hint="Add your first task below." />;
    }
    if (nothingVisible && completedTasks.length > 0 && !filtersActive) {
      return (
        <EmptyState
          fill
          title="All done"
          hint="Every task is completed."
          action={(
            <Button onClick={() => setFilter({ showCompleted: true })}>
              {`Show ${completedTasks.length} completed`}
            </Button>
          )}
        />
      );
    }
    if (nothingVisible) {
      return (
        <EmptyState
          fill
          title="No tasks match these filters"
          action={(
            <Button
              variant="quiet"
              onClick={() => setFilter({ search: '', priority: 'all', tag: 'all' })}
            >
              Clear filters
            </Button>
          )}
        />
      );
    }
    return (
      <>
        {groups.map((group) => (
          <TaskGroup
            key={group.id}
            id={group.id}
            label={group.label}
            tasks={group.tasks}
            collapsed={collapsedGroups.has(group.id)}
            onToggle={() => toggleGroup(group.id)}
          />
        ))}
        {showCompletedGroup && (
          <TaskGroup
            id="completed"
            label="Completed"
            tasks={completedTasks}
            collapsed={collapsedGroups.has(COMPLETED_GROUP)}
            onToggle={() => toggleGroup(COMPLETED_GROUP)}
          />
        )}
      </>
    );
  }

  return (
    <div className={styles.view} data-testid="agenda-view">
      <header className={styles.header}>
        <AgendaFilterBar />
        <p className={styles.summary}>
          {totalIncomplete} open · {totalCompleted} completed
        </p>
      </header>

      <div className={styles.body}>{renderBody()}</div>

      <AddTaskForm />
    </div>
  );
}
