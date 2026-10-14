/**
 * agendaTasks — how the AGENDA tab filters, sorts and groups tasks (priority
 * groups, then the completed ones). Shared by the desktop view
 * (routes/AgendaView) and the phone's (components/mobile/views/PhoneAgenda).
 */
import type { NativeSelectOption } from '@/components/ui/NativeSelect';
import type { AgendaFilter, AgendaPriority, AgendaTask } from '@/types';

export const PRIORITY_ORDER: AgendaPriority[] = ['urgent', 'high', 'medium', 'low'];

const PRIORITY_WEIGHT: Record<AgendaPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const PRIORITY_LABELS: Record<AgendaPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** A task's priority, highest first (the order of the groups on the page). */
export const AGENDA_PRIORITY_OPTIONS: NativeSelectOption<AgendaPriority>[] =
  PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));

export const AGENDA_PRIORITY_FILTER_OPTIONS: NativeSelectOption<AgendaFilter['priority']>[] = [
  { value: 'all', label: 'All' },
  ...AGENDA_PRIORITY_OPTIONS,
];

export const AGENDA_SORT_OPTIONS: NativeSelectOption<AgendaFilter['sortBy']>[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'dueDate', label: 'Due date' },
  { value: 'createdAt', label: 'Newest' },
];

export function matchesFilter(
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

export function sortTasks(
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

export interface AgendaGroup {
  id: AgendaPriority;
  label: string;
  tasks: AgendaTask[];
}

export interface GroupedAgenda {
  /** The non-empty priority groups, highest first. */
  groups: AgendaGroup[];
  completedTasks: AgendaTask[];
  totalIncomplete: number;
  totalCompleted: number;
}

/** Filter, sort and group: what both agenda views draw. */
export function groupAgendaTasks(tasks: Iterable<AgendaTask>, filter: AgendaFilter): GroupedAgenda {
  const filtered = [...tasks].filter((t) => matchesFilter(t, filter.search, filter.priority, filter.tag));
  const incomplete = filtered.filter((t) => !t.completed);
  const completed = filtered.filter((t) => t.completed);
  const sorted = sortTasks(incomplete, filter.sortBy);
  const groups = PRIORITY_ORDER
    .map((p) => ({ id: p, label: PRIORITY_LABELS[p], tasks: sorted.filter((t) => t.priority === p) }))
    .filter((g) => g.tasks.length > 0);
  return {
    groups,
    completedTasks: sortTasks(completed, filter.sortBy),
    totalIncomplete: incomplete.length,
    totalCompleted: completed.length,
  };
}

/** Every tag in use, sorted; an active tag filter stays listed even once unused. */
export function agendaTagOptions(tasks: Iterable<AgendaTask>, activeTag: string): string[] {
  const tags = new Set<string>();
  for (const task of tasks) for (const tag of task.tags) if (tag) tags.add(tag);
  if (activeTag !== 'all') tags.add(activeTag);
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** "a, b ,, c" → ["a", "b", "c"] */
export function parseTags(input: string): string[] {
  return input.split(',').map((t) => t.trim()).filter(Boolean);
}
