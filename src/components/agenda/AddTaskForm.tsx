/**
 * AddTaskForm — the new-task bar pinned under the Agenda list.
 * Title is required; priority defaults to medium; due date and tags are optional.
 */
import { useState, useCallback } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import type { AgendaPriority } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

const PRIORITY_OPTIONS: NativeSelectOption<AgendaPriority>[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

function PlusGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export default function AddTaskForm() {
  const createTask = useAgendaStore((s) => s.createTask);

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<AgendaPriority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedTitle = title.trim();
      if (!trimmedTitle) return;

      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      createTask({
        title: trimmedTitle,
        priority,
        tags,
        dueDate: dueDate || undefined,
      });

      // Clear form
      setTitle('');
      setPriority('medium');
      setDueDate('');
      setTagsInput('');
    },
    [title, priority, dueDate, tagsInput, createTask],
  );

  return (
    <form className={styles.addForm} onSubmit={handleSubmit} aria-label="Add a task">
      <TextInput
        className={styles.addTitle}
        placeholder="New task…"
        aria-label="New task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />

      {/* aria-labels keep the visible caption's words but name the field for
          the NEW task — the toolbar above already has a "Priority" filter. */}
      <Field label="Priority">
        <NativeSelect
          aria-label="New task priority"
          value={priority}
          onChange={setPriority}
          options={PRIORITY_OPTIONS}
        />
      </Field>

      <Field label="Due">
        <TextInput
          type="date"
          aria-label="Due date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </Field>

      <TextInput
        className={styles.addTags}
        placeholder="Tags, comma-separated"
        aria-label="Tags, comma-separated"
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
      />

      <Button type="submit" variant="primary" icon={<PlusGlyph />} disabled={!title.trim()}>
        Add task
      </Button>
    </form>
  );
}
