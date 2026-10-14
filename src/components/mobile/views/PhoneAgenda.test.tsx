// PhoneAgenda.test.tsx — AGENDA on a phone (AASC-20, feature 6): priority
// groups in one column, a 44px checkbox per task, a task opens full screen to
// edit / complete / delete (delete asks first), + adds one from the same form,
// and an emptied due date is cleared (null), not silently kept.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgendaTask } from '@/types';
import { useAgendaStore } from '@/stores/agendaStore';
import PhoneAgenda from './PhoneAgenda';

const task = (id: string, over: Partial<AgendaTask> = {}): AgendaTask => ({
  id, title: `Task ${id}`, priority: 'medium', tags: [], completed: false,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
});

let actions: Record<'fetchTasks' | 'createTask' | 'updateTask' | 'deleteTask' | 'toggleTask', ReturnType<typeof vi.fn>>;

beforeEach(() => {
  actions = {
    fetchTasks: vi.fn(async () => {}),
    createTask: vi.fn(async () => {}),
    updateTask: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => {}),
    toggleTask: vi.fn(async () => {}),
  };
  useAgendaStore.setState({
    tasks: new Map([
      ['u', task('u', { title: 'Ship it', priority: 'urgent', dueDate: '2020-01-02', tags: ['work'] })],
      ['l', task('l', { title: 'Tidy up', priority: 'low' })],
      ['d', task('d', { title: 'Done one', completed: true })],
    ]),
    loading: false,
    filter: { search: '', priority: 'all', tag: 'all', showCompleted: false, sortBy: 'priority' },
    ...actions,
  } as Partial<ReturnType<typeof useAgendaStore.getState>>);
});

describe('PhoneAgenda', () => {
  it('groups open tasks by priority, says what a row means in words, and fetches on open', () => {
    render(<PhoneAgenda />);
    expect(actions.fetchTasks).toHaveBeenCalled();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Urgent · 1', 'Low · 1']);
    const ship = screen.getByRole('button', { name: /Ship it/ });
    expect(ship.textContent).toContain('Urgent');
    expect(ship.textContent).toContain('Overdue');
    expect(ship.textContent).toContain('#work');
    expect(screen.queryByText('Done one')).toBeNull();
    expect(screen.getByText('2 open · 1 completed')).toBeTruthy();
  });

  it('completes a task from its checkbox', async () => {
    render(<PhoneAgenda />);
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Mark "Tidy up" as done' }));
    expect(actions.toggleTask).toHaveBeenCalledWith('l');
  });

  it('edits a task full screen; an emptied due date is cleared', async () => {
    const user = userEvent.setup();
    render(<PhoneAgenda />);
    await user.click(screen.getByRole('button', { name: /Ship it/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Task' });
    const title = within(sheet).getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Ship it today');
    await user.selectOptions(within(sheet).getByRole('combobox', { name: 'Priority' }), 'high');
    await user.clear(within(sheet).getByLabelText('Due'));
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(actions.updateTask).toHaveBeenCalledWith('u', {
      title: 'Ship it today', priority: 'high', tags: ['work'], description: '', dueDate: null,
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deletes only after a confirm sheet', async () => {
    const user = userEvent.setup();
    render(<PhoneAgenda />);
    await user.click(screen.getByRole('button', { name: /Tidy up/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Task' })).getByRole('button', { name: 'Delete' }));
    expect(actions.deleteTask).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Delete this task?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(actions.deleteTask).toHaveBeenCalledWith('l');
  });

  it('adds a task from +', async () => {
    const user = userEvent.setup();
    render(<PhoneAgenda />);
    await user.click(screen.getByRole('button', { name: 'New task' }));
    const sheet = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(sheet).getByRole('button', { name: 'Add task' }).hasAttribute('disabled')).toBe(true);
    await user.type(within(sheet).getByRole('textbox', { name: 'Title' }), 'Call the bank');
    await user.type(within(sheet).getByRole('textbox', { name: 'Tags, comma-separated' }), 'home, ,money');
    await user.click(within(sheet).getByRole('button', { name: 'Add task' }));
    expect(actions.createTask).toHaveBeenCalledWith({
      title: 'Call the bank', priority: 'medium', tags: ['home', 'money'], dueDate: undefined, description: undefined,
    });
  });

  it('shows completed tasks from the filters sheet', async () => {
    const user = userEvent.setup();
    render(<PhoneAgenda />);
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Filters' })).getByRole('button', { name: 'Show completed' }));
    expect(useAgendaStore.getState().filter.showCompleted).toBe(true);
    expect(screen.getByRole('heading', { name: 'Completed · 1' })).toBeTruthy();
  });
});
