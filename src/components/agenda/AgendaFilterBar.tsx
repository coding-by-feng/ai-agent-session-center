/**
 * AgendaFilterBar — Search, priority filter, tag filter, sort, and the
 * completed toggle for the Agenda task list, on the shared toolbar primitives
 * (SearchInput `field`, Field + NativeSelect, a pressed Button).
 */
import { useCallback, useMemo } from 'react';
import SearchInput from '@/components/ui/SearchInput';
import Field from '@/components/ui/Field';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import Button from '@/components/ui/Button';
import { useAgendaStore } from '@/stores/agendaStore';
import type { AgendaFilter } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

const PRIORITY_OPTIONS: NativeSelectOption<AgendaFilter['priority']>[] = [
  { value: 'all', label: 'All' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

// Captioned "Sort by" — a bare "Priority" select beside the priority FILTER
// read as a second priority filter (Oct 2026 screenshot).
const SORT_OPTIONS: NativeSelectOption<AgendaFilter['sortBy']>[] = [
  { value: 'priority', label: 'Priority' },
  { value: 'dueDate', label: 'Due date' },
  { value: 'createdAt', label: 'Newest' },
];

export default function AgendaFilterBar() {
  const filter = useAgendaStore((s) => s.filter);
  const setFilter = useAgendaStore((s) => s.setFilter);
  const tasks = useAgendaStore((s) => s.tasks);

  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const task of tasks.values()) {
      for (const tag of task.tags) {
        if (tag) tagSet.add(tag);
      }
    }
    return [...tagSet].sort((a, b) => a.localeCompare(b));
  }, [tasks]);

  // The tag filter only appears once a tag exists — but an ACTIVE tag filter
  // always stays visible (and listed), even after its last task is deleted,
  // or the list would be filtered by a control nobody can see to reset.
  const tagOptions = useMemo<NativeSelectOption[]>(() => {
    const tags = filter.tag !== 'all' && !availableTags.includes(filter.tag)
      ? [...availableTags, filter.tag]
      : availableTags;
    return [{ value: 'all', label: 'All' }, ...tags.map((t) => ({ value: t, label: `#${t}` }))];
  }, [availableTags, filter.tag]);
  const showTagFilter = availableTags.length > 0 || filter.tag !== 'all';

  const handleSearch = useCallback(
    (search: string) => setFilter({ search }),
    [setFilter],
  );

  return (
    <div className={styles.toolbar}>
      <SearchInput
        variant="field"
        ariaLabel="Search tasks"
        value={filter.search}
        onChange={handleSearch}
        placeholder="Search tasks…"
        debounceMs={200}
        className={styles.search}
      />

      <Field label="Priority">
        <NativeSelect
          value={filter.priority}
          onChange={(priority) => setFilter({ priority })}
          options={PRIORITY_OPTIONS}
        />
      </Field>

      {showTagFilter && (
        <Field label="Tag">
          <NativeSelect
            value={filter.tag}
            onChange={(tag) => setFilter({ tag })}
            options={tagOptions}
          />
        </Field>
      )}

      <Field label="Sort by">
        <NativeSelect
          value={filter.sortBy}
          onChange={(sortBy) => setFilter({ sortBy })}
          options={SORT_OPTIONS}
        />
      </Field>

      <Button
        pressed={filter.showCompleted}
        onClick={() => setFilter({ showCompleted: !filter.showCompleted })}
      >
        Show completed
      </Button>
    </div>
  );
}
