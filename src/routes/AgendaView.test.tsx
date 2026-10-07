// AgendaView.test.tsx — the AGENDA tab on the shared primitives.
//
// Pins the screenshot fixes (Oct 2026): a group's count sits beside its label
// inside a real <button aria-expanded>; a task with no tags/date/details is a
// single line (its add-tag control lives in the icon group, not on a second
// row of its own); the priority control still edits; the title edits by
// keyboard; the cached list never blanks behind "Loading…"; and a list whose
// every task is done says so instead of rendering an empty body.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { AgendaTask } from '@/types';

import AgendaView from './AgendaView';
import { useAgendaStore } from '@/stores/agendaStore';

function task(id: string, over: Partial<AgendaTask> = {}): AgendaTask {
  return {
    id,
    title: `Task ${id}`,
    priority: 'medium',
    tags: [],
    completed: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const actions = {
  fetchTasks: vi.fn(async () => {}),
  updateTask: vi.fn(async () => {}),
  deleteTask: vi.fn(async () => {}),
  toggleTask: vi.fn(async () => {}),
  createTask: vi.fn(async () => {}),
};

function seed(tasks: AgendaTask[], loading = false): void {
  useAgendaStore.setState({
    ...actions,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    loading,
    filter: { search: '', priority: 'all', tag: 'all', showCompleted: false, sortBy: 'priority' },
  });
}

beforeEach(() => {
  Object.values(actions).forEach((fn) => fn.mockClear());
});

describe('AgendaView — groups', () => {
  it('heads each priority group with a button whose count sits beside the label', () => {
    seed([task('a', { priority: 'urgent' }), task('b', { priority: 'urgent' }), task('c', { priority: 'low' })]);
    render(<AgendaView />);

    const urgent = screen.getByRole('button', { name: /^Urgent\s*2/ });
    expect(urgent.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Task a')).toBeTruthy();

    fireEvent.click(urgent);
    expect(urgent.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Task a')).toBeNull();
    // the other group is untouched
    expect(screen.getByText('Task c')).toBeTruthy();
  });

  it('summarises open and completed tasks', () => {
    seed([task('a'), task('b'), task('c', { completed: true })]);
    render(<AgendaView />);
    expect(screen.getByText('2 open · 1 completed')).toBeTruthy();
  });

  it('keeps the cached list on screen while a refresh is loading', () => {
    seed([task('a')], true);
    render(<AgendaView />);
    expect(screen.getByText('Task a')).toBeTruthy();
    expect(screen.queryByText(/Loading tasks/)).toBeNull();
  });

  it('shows the loading state only when there is nothing cached yet', () => {
    seed([], true);
    render(<AgendaView />);
    expect(screen.getByRole('status').textContent).toContain('Loading tasks');
  });

  it('says everything is done instead of rendering an empty body', () => {
    seed([task('a', { completed: true })]);
    render(<AgendaView />);
    expect(screen.getByText('All done')).toBeTruthy();
    // the toolbar's own toggle is "Show completed"; the empty state's names the count
    expect(screen.getByRole('button', { name: 'Show completed' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 completed' }));
    expect(useAgendaStore.getState().filter.showCompleted).toBe(true);
  });
});

describe('AgendaTaskCard', () => {
  it('is one line when the task has no tags, date or details — add-tag is in the icon group', () => {
    seed([task('a')]);
    render(<AgendaView />);
    const card = screen.getByText('Task a').closest('[data-task-id]') as HTMLElement;
    expect(card.querySelector('[data-task-meta]')).toBeNull();
    expect(within(card).getByRole('button', { name: 'Edit tags of "Task a"' })).toBeTruthy();
  });

  it('shows the meta row when there is meta to show', () => {
    seed([task('a', { tags: ['health'], dueDate: '2099-01-01' })]);
    render(<AgendaView />);
    const card = screen.getByText('Task a').closest('[data-task-id]') as HTMLElement;
    const meta = card.querySelector('[data-task-meta]') as HTMLElement;
    expect(meta).not.toBeNull();
    expect(within(meta).getByRole('button', { name: '#health' })).toBeTruthy();
  });

  it('changes priority through its select', () => {
    seed([task('a', { priority: 'urgent' })]);
    render(<AgendaView />);
    const select = screen.getByRole('combobox', { name: 'Priority of "Task a"' });
    expect(select).toHaveValue('urgent');
    fireEvent.change(select, { target: { value: 'low' } });
    expect(actions.updateTask).toHaveBeenCalledWith('a', { priority: 'low' });
  });

  it('edits the title from a keyboard-reachable button', () => {
    seed([task('a')]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Task a' }));
    const input = screen.getByRole('textbox', { name: 'Task title' });
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.updateTask).toHaveBeenCalledWith('a', { title: 'Renamed' });
  });

  it('asks before deleting and can be cancelled', () => {
    seed([task('a')]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Task a"' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(actions.deleteTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete "Task a"' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(actions.deleteTask).toHaveBeenCalledWith('a');
  });
});

// Focus must never fall to <body> when the control holding it unmounts.
describe('AgendaTaskCard — focus', () => {
  it('returns focus to the title after a keyboard edit (Enter) and after Escape', () => {
    seed([task('a')]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Task a' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task title' }), { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Task a' }));

    fireEvent.click(screen.getByRole('button', { name: 'Task a' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task title' }), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Task a' }));
  });

  it('returns focus to "Edit tags" after Escape in the tag editor', () => {
    seed([task('a')]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags of "Task a"' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tags of "Task a", comma-separated' }), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit tags of "Task a"' }));
  });

  it('focuses Cancel when the delete confirm opens and the trash button when it closes', () => {
    seed([task('a')]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Task a"' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete "Task a"' }));
  });

  it('moves focus to the next card when a task is deleted', () => {
    seed([
      task('a', { createdAt: '2026-10-03T00:00:00Z' }),
      task('b', { createdAt: '2026-10-02T00:00:00Z' }),
    ]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete "Task a"' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Task b' }));
  });

  it('ignores the Enter that confirms an IME candidate (Chromium and WebKit forms)', () => {
    seed([task('a')]);
    render(<AgendaView />);
    fireEvent.click(screen.getByRole('button', { name: 'Task a' }));
    const input = screen.getByRole('textbox', { name: 'Task title' });
    fireEvent.change(input, { target: { value: '整理' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(actions.updateTask).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Task title' })).toBeTruthy();
  });
});

describe('AgendaFilterBar', () => {
  it('Clear filters empties the search box as well as the filter', () => {
    seed([task('a')]);
    useAgendaStore.setState({ filter: { search: 'zzz', priority: 'all', tag: 'all', showCompleted: false, sortBy: 'priority' } });
    render(<AgendaView />);
    expect(screen.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('zzz');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(useAgendaStore.getState().filter.search).toBe('');
    expect(screen.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('');
  });

  it('names every control and hides the tag filter while no task has a tag', () => {
    seed([task('a')]);
    render(<AgendaView />);
    expect(screen.getByRole('textbox', { name: 'Search tasks' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Tag' })).toBeNull();
  });

  it('shows the tag filter once a tag exists', () => {
    seed([task('a', { tags: ['ops'] })]);
    render(<AgendaView />);
    const tag = screen.getByRole('combobox', { name: 'Tag' }) as HTMLSelectElement;
    expect(Array.from(tag.options).map((o) => o.textContent)).toEqual(['All', '#ops']);
  });
});
