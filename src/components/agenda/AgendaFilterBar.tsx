/**
 * AgendaFilterBar — Search, priority filter, completed toggle, and sort selector
 * for the Agenda task list.
 */
import { useCallback } from 'react';
import SearchInput from '@/components/ui/SearchInput';
import { useAgendaStore } from '@/stores/agendaStore';
import type { AgendaPriority, AgendaFilter } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

const PRIORITY_OPTIONS: Array<{ value: AgendaFilter['priority']; label: string }> = [
  { value: 'all', label: 'All priorities' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const SORT_OPTIONS: Array<{ value: AgendaFilter['sortBy']; label: string }> = [
  { value: 'priority', label: 'Priority' },
  { value: 'dueDate', label: 'Due date' },
  { value: 'createdAt', label: 'Created' },
];

export default function AgendaFilterBar() {
  const filter = useAgendaStore((s) => s.filter);
  const setFilter = useAgendaStore((s) => s.setFilter);

  const handleSearch = useCallback(
    (search: string) => setFilter({ search }),
    [setFilter],
  );

  const handlePriority = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) =>
      setFilter({ priority: e.target.value as AgendaPriority | 'all' }),
    [setFilter],
  );

  const handleSort = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) =>
      setFilter({ sortBy: e.target.value as AgendaFilter['sortBy'] }),
    [setFilter],
  );

  const handleToggleCompleted = useCallback(
    () => setFilter({ showCompleted: !filter.showCompleted }),
    [setFilter, filter.showCompleted],
  );

  return (
    <div className={styles.filterBar}>
      <SearchInput
        value={filter.search}
        onChange={handleSearch}
        placeholder="Search tasks..."
        debounceMs={200}
      />

      <select value={filter.priority} onChange={handlePriority}>
        {PRIORITY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <select value={filter.sortBy} onChange={handleSort}>
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <label className={styles.toggleLabel}>
        <input
          type="checkbox"
          checked={filter.showCompleted}
          onChange={handleToggleCompleted}
        />
        Show completed
      </label>
    </div>
  );
}
