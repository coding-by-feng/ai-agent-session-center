import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import CentralPicker, { type CentralPickerProps } from './CentralPicker';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import type { CentralSummary } from '@/types';

const NO_PASSWORD = 'No dashboard password: a central can also reach /api directly.';

const central = (over: Partial<CentralSummary> = {}): CentralSummary => ({
  centralId: 'c1',
  kind: 'global',
  scopeRef: null,
  cli: 'claude',
  sessionId: null,
  toolsets: [],
  createdAt: 1,
  workerCount: 0,
  ...over,
});

const running = (...rows: CentralSummary[]) => useMcpStore.setState({ centrals: new Map(rows.map((r) => [r.centralId, r])) });

function renderPicker(over: Partial<CentralPickerProps> = {}) {
  const onChange = vi.fn();
  const utils = render(<CentralPicker value="off" onChange={onChange} passwordEnabled {...over} />);
  const select = screen.getByRole('combobox', { name: 'Central session' }) as HTMLSelectElement;
  return { ...utils, onChange, select };
}

const labels = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.textContent);
const option = (select: HTMLSelectElement, value: string) =>
  Array.from(select.options).find((o) => o.value === value) as HTMLOptionElement;

describe('CentralPicker', () => {
  beforeEach(() => {
    useMcpStore.setState({ centrals: new Map(), available: true, passwordEnabled: null, revision: 0 });
    useRoomStore.setState({ rooms: [{ id: 'room-1', name: 'Backend', sessionIds: [], collapsed: false, createdAt: 1 }] });
  });

  afterEach(() => {
    // Inside act: the picker is still mounted here, and both stores feed it.
    act(() => {
      useMcpStore.setState({ centrals: new Map(), available: null });
      useRoomStore.setState({ rooms: [] });
    });
  });

  describe('the options a new session has', () => {
    it('offers Off and Global when it has no room and no folder', () => {
      const { select } = renderPicker();
      expect(labels(select)).toEqual(['Off', 'Global']);
    });

    it('adds This room once a room is known', () => {
      const { select } = renderPicker({ roomId: 'room-1' });
      expect(labels(select)).toEqual(['Off', 'Global', 'This room']);
    });

    it('adds This project once a folder is known', () => {
      const { select } = renderPicker({ folder: '/work/app' });
      expect(labels(select)).toEqual(['Off', 'Global', 'This project']);
    });

    it('offers all four with a room and a folder, in that order', () => {
      const { select } = renderPicker({ roomId: 'room-1', folder: '/work/app' });
      expect(labels(select)).toEqual(['Off', 'Global', 'This room', 'This project']);
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['off', 'global', 'room', 'project']);
    });

    it('does not count a blank room or folder as known', () => {
      const { select } = renderPicker({ roomId: '', folder: '   ' });
      expect(labels(select)).toEqual(['Off', 'Global']);
    });

    it('does not count a missing one as known either', () => {
      const { select } = renderPicker({ roomId: null, folder: null });
      expect(labels(select)).toEqual(['Off', 'Global']);
    });
  });

  describe('the field', () => {
    it('is a labelled native select from the shared kit, keyboard reachable', () => {
      const { select } = renderPicker();
      expect(select.tagName).toBe('SELECT');
      select.focus();
      expect(document.activeElement).toBe(select);
      expect(select).not.toBeDisabled();
    });

    it('shows the chosen value', () => {
      const { select } = renderPicker({ value: 'global' });
      expect(select.value).toBe('global');
    });

    it('reports the choice, typed', () => {
      const { select, onChange } = renderPicker({ roomId: 'room-1', folder: '/work/app' });
      fireEvent.change(select, { target: { value: 'room' } });
      expect(onChange).toHaveBeenLastCalledWith('room');
      fireEvent.change(select, { target: { value: 'project' } });
      expect(onChange).toHaveBeenLastCalledWith('project');
      fireEvent.change(select, { target: { value: 'off' } });
      expect(onChange).toHaveBeenLastCalledWith('off');
    });

    it('passes a class to its root, for the form it sits in', () => {
      const { container } = renderPicker({ className: 'host-spacing' });
      expect(container.firstElementChild).toHaveClass('host-spacing');
    });
  });

  describe('the dashboard password warning', () => {
    it('is shown when no password is set', () => {
      renderPicker({ passwordEnabled: false });
      expect(screen.getByText(NO_PASSWORD)).toBeInTheDocument();
    });

    it('is not shown when a password is set', () => {
      renderPicker({ passwordEnabled: true });
      expect(screen.queryByText(NO_PASSWORD)).toBeNull();
    });

    it.each([[null], [undefined]])('is not shown while it is not known (%s): no warning on a guess', (unknown) => {
      renderPicker({ passwordEnabled: unknown });
      expect(screen.queryByText(NO_PASSWORD)).toBeNull();
    });

    it('is shown whatever is chosen, as the spec has it with the picker', () => {
      renderPicker({ passwordEnabled: false, value: 'off' });
      expect(screen.getByText(NO_PASSWORD)).toBeInTheDocument();
    });

    it('describes the select, so a screen reader reads it with the field', () => {
      const { select } = renderPicker({ passwordEnabled: false });
      const warning = screen.getByText(NO_PASSWORD);
      expect(warning.id).not.toBe('');
      expect(select.getAttribute('aria-describedby')?.split(' ')).toContain(warning.id);
    });
  });

  describe('a scope that already has a central', () => {
    it('disables Global, with a hint, while a global central runs', () => {
      running(central({ kind: 'global' }));
      const { select } = renderPicker();

      expect(option(select, 'global').disabled).toBe(true);
      const hint = screen.getByText('A global central is already running.');
      expect(select.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
    });

    it('leaves Global open, with no hint, while none does', () => {
      running(central({ kind: 'room', scopeRef: 'room-1' }));
      const { select } = renderPicker();

      expect(option(select, 'global').disabled).toBe(false);
      expect(screen.queryByText('A global central is already running.')).toBeNull();
    });

    it('disables This room for a room that has a central, with a hint', () => {
      running(central({ kind: 'room', scopeRef: 'room-1' }));
      const { select } = renderPicker({ roomId: 'room-1' });

      expect(option(select, 'room').disabled).toBe(true);
      expect(screen.getByText('A central is already running for this room.')).toBeInTheDocument();
      expect(option(select, 'global').disabled).toBe(false);
    });

    it('leaves This room open for a room another room\'s central does not hold', () => {
      running(central({ kind: 'room', scopeRef: 'room-9' }));
      const { select } = renderPicker({ roomId: 'room-1' });

      expect(option(select, 'room').disabled).toBe(false);
      expect(screen.queryByText('A central is already running for this room.')).toBeNull();
    });

    it('disables This project for a folder that has a central, with a hint', () => {
      running(central({ kind: 'project', scopeRef: '/work/app' }));
      const { select } = renderPicker({ folder: '/work/app/' });

      expect(option(select, 'project').disabled).toBe(true);
      expect(screen.getByText('A central is already running for this project.')).toBeInTheDocument();
    });

    it('leaves This project open for another folder', () => {
      running(central({ kind: 'project', scopeRef: '/work/other' }));
      const { select } = renderPicker({ folder: '/work/app' });

      expect(option(select, 'project').disabled).toBe(false);
    });

    it('says nothing about a room or folder it does not offer', () => {
      running(central({ kind: 'room', scopeRef: 'room-1' }), central({ centralId: 'c2', kind: 'project', scopeRef: '/work/app' }));
      renderPicker();

      expect(screen.queryByText('A central is already running for this room.')).toBeNull();
      expect(screen.queryByText('A central is already running for this project.')).toBeNull();
    });

    it('shows Off when the chosen scope has been taken since (what will be sent is what is shown)', () => {
      running(central({ kind: 'global' }));
      const { select } = renderPicker({ value: 'global' });

      expect(select.value).toBe('off');
    });

    it('follows the store: a central that starts while the form is open closes its scope', () => {
      const { select } = renderPicker();
      expect(option(select, 'global').disabled).toBe(false);

      act(() => running(central({ kind: 'global' })));

      expect(option(select, 'global').disabled).toBe(true);
      expect(screen.getByText('A global central is already running.')).toBeInTheDocument();
    });
  });

  describe('a choice its context no longer supports', () => {
    it('shows Off for This room once the room is gone', () => {
      const { select } = renderPicker({ value: 'room', roomId: null });
      expect(select.value).toBe('off');
    });

    it('shows Off for This project once the folder is gone', () => {
      const { select } = renderPicker({ value: 'project', folder: '' });
      expect(select.value).toBe('off');
    });
  });

  describe('what the choice reaches', () => {
    it('says nothing for Off', () => {
      const { container } = renderPicker({ value: 'off', passwordEnabled: true });
      expect(container.querySelectorAll('p')).toHaveLength(0);
    });

    it('says Global reaches every session', () => {
      renderPicker({ value: 'global' });
      expect(screen.getByText('Can reach every session on this Mac.')).toBeInTheDocument();
    });

    it('names the room, from the room store', () => {
      renderPicker({ value: 'room', roomId: 'room-1' });
      expect(screen.getByText('Can reach the sessions in room "Backend".')).toBeInTheDocument();
    });

    it('names the folder', () => {
      renderPicker({ value: 'project', folder: '/work/app' });
      expect(screen.getByText('Can reach the sessions in /work/app and below.')).toBeInTheDocument();
    });

    it('describes the select too', () => {
      const { select } = renderPicker({ value: 'global' });
      const hint = screen.getByText('Can reach every session on this Mac.');
      expect(select.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
    });

    it('does not describe a room it cannot name', () => {
      renderPicker({ value: 'room', roomId: 'room-unknown' });
      expect(screen.queryByText(/Can reach the sessions in room/)).toBeNull();
    });
  });
});
