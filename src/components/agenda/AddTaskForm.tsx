/**
 * AddTaskForm — Inline form at the bottom of the Agenda view for creating tasks.
 * Title is required; priority defaults to medium; due date and tags are optional.
 */
import { useState, useCallback } from 'react';
import { useAgendaStore } from '@/stores/agendaStore';
import type { AgendaPriority } from '@/types';
import styles from '@/styles/modules/Agenda.module.css';

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
    <form className={styles.addForm} onSubmit={handleSubmit}>
      <input
        type="text"
        className={styles.titleInput}
        placeholder="New task title..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />

      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as AgendaPriority)}
      >
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>

      <input
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        title="Due date (optional)"
      />

      <input
        type="text"
        className={styles.tagsInput}
        placeholder="Tags (comma-sep)"
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
      />

      <button
        type="submit"
        className={styles.addBtn}
        disabled={!title.trim()}
      >
        ADD
      </button>
    </form>
  );
}
