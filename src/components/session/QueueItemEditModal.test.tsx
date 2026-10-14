import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import QueueItemEditModal from './QueueItemEditModal';
import { useSessionStore } from '@/stores/sessionStore';
import type { QueueItem } from '@/stores/queueStore';
import type { Session } from '@/types';

function mkItem(p: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    sessionId: 'sess',
    text: 'main prompt',
    position: 0,
    createdAt: 0,
    ...p,
  };
}

function renderModal(item: QueueItem, onSave = vi.fn()) {
  render(
    <QueueItemEditModal
      item={item}
      autoSendEnabled
      sessionId="sess"
      onClose={vi.fn()}
      onSave={onSave}
      onDelete={vi.fn()}
    />,
  );
  return onSave;
}

describe('QueueItemEditModal — chains are not type-scoped', () => {
  it('offers before/after chain editors for a once item', () => {
    renderModal(mkItem({ type: 'once' }));

    expect(screen.getByText('BEFORE chain')).toBeTruthy();
    expect(screen.getByText('AFTER chain')).toBeTruthy();
  });

  it('offers them for loop and schedule items too', () => {
    for (const type of ['loop', 'schedule'] as const) {
      const { unmount } = render(
        <QueueItemEditModal
          item={mkItem({ type })}
          autoSendEnabled
          sessionId="sess"
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
      expect(screen.getByText('BEFORE chain')).toBeTruthy();
      expect(screen.getByText('AFTER chain')).toBeTruthy();
      unmount();
    }
  });

  it('shows an existing once item’s chain steps for editing', () => {
    renderModal(
      mkItem({
        type: 'once',
        beforeChain: [{ id: 1, text: '/context' }],
        afterChain: [{ id: 2, text: '/compact' }],
      }),
    );

    const before = screen.getByLabelText('Before-chain step') as HTMLTextAreaElement;
    const after = screen.getByLabelText('After-chain step') as HTMLTextAreaElement;
    expect(before.value).toBe('/context');
    expect(after.value).toBe('/compact');
  });

  it('persists an edited chain on a once item instead of dropping it', () => {
    const onSave = renderModal(
      mkItem({ type: 'once', beforeChain: [{ id: 1, text: '/context' }] }),
    );

    fireEvent.change(screen.getByLabelText('Before-chain step'), {
      target: { value: '/context --fresh' },
    });
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const patch = onSave.mock.calls[0][0];
    expect(patch.type).toBe('once');
    expect(patch.beforeChain).toEqual([{ id: 1, text: '/context --fresh' }]);
  });

  it('drops blank chain steps rather than queueing empty prompts', () => {
    const onSave = renderModal(
      mkItem({ type: 'once', beforeChain: [{ id: 1, text: '   ' }] }),
    );

    fireEvent.click(screen.getByText('Save'));
    expect(onSave.mock.calls[0][0].beforeChain).toBeUndefined();
  });
});

function mkSession(p: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess', status: 'idle', animationState: 'Idle', emote: null,
    projectName: 'p', projectPath: '/tmp/p', title: '', source: 'ssh', model: 'opus',
    startedAt: 0, lastActivityAt: 0, endedAt: null, currentPrompt: '', promptHistory: [],
    toolUsage: {}, totalToolCalls: 0, toolLog: [], responseLog: [], events: [],
    pendingTool: null, waitingDetail: null, subagentCount: 0, terminalId: 't',
    cachedPid: null, archived: 0, queueCount: 0,
    ...p,
  };
}

/** The "Set effort…" trigger of one chain section. */
function effortTrigger(which: 'before' | 'after'): HTMLElement {
  const triggers = screen.getAllByRole('button', { name: /set effort/i });
  return triggers[which === 'before' ? 0 : 1];
}

describe('QueueItemEditModal — predefined effort steps', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map([['sess', mkSession()]]) });
  });
  afterEach(() => {
    // Wrapped: the picker's session selector re-renders a still-mounted modal.
    act(() => { useSessionStore.setState({ sessions: new Map() }); });
  });

  it('offers a Set effort… picker in both the BEFORE and the AFTER chain', () => {
    renderModal(mkItem());
    expect(screen.getAllByRole('button', { name: /set effort/i })).toHaveLength(2);
  });

  it('opens a menu of every effort level from the BEFORE chain', () => {
    renderModal(mkItem());
    fireEvent.click(effortTrigger('before'));

    const menu = screen.getByRole('menu', { name: /effort/i });
    const levels = within(menu).getAllByRole('menuitem').map((el) => el.textContent ?? '');
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
      expect(levels.some((t) => t.includes(level))).toBe(true);
    }
  });

  it('a BEFORE pick appends an ordinary /effort step and saves it in beforeChain', () => {
    const onSave = renderModal(mkItem());
    fireEvent.click(effortTrigger('before'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^max/ }));

    expect((screen.getByLabelText('Before-chain step') as HTMLTextAreaElement).value).toBe('/effort max');
    expect(screen.queryByLabelText('After-chain step')).toBeNull();

    fireEvent.click(screen.getByText('Save'));
    const patch = onSave.mock.calls[0][0];
    expect(patch.beforeChain.map((s: { text: string }) => s.text)).toEqual(['/effort max']);
    expect(patch.afterChain).toBeUndefined();
  });

  it('picking again in the AFTER chain puts the level back after the main prompt', () => {
    const onSave = renderModal(mkItem());
    fireEvent.click(effortTrigger('before'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^max/ }));
    fireEvent.click(effortTrigger('after'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^high/ }));

    fireEvent.click(screen.getByText('Save'));
    const patch = onSave.mock.calls[0][0];
    expect(patch.beforeChain.map((s: { text: string }) => s.text)).toEqual(['/effort max']);
    expect(patch.afterChain.map((s: { text: string }) => s.text)).toEqual(['/effort high']);
  });

  it('appends after the steps already there instead of replacing them', () => {
    const onSave = renderModal(mkItem({ beforeChain: [{ id: 1, text: '/context' }] }));
    fireEvent.click(effortTrigger('before'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^low/ }));

    fireEvent.click(screen.getByText('Save'));
    expect(onSave.mock.calls[0][0].beforeChain.map((s: { text: string }) => s.text)).toEqual([
      '/context',
      '/effort low',
    ]);
  });

  it('the added step stays an editable text box', () => {
    const onSave = renderModal(mkItem());
    fireEvent.click(effortTrigger('after'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^xhigh/ }));
    fireEvent.change(screen.getByLabelText('After-chain step'), { target: { value: '/effort xhigh' } });
    fireEvent.change(screen.getByLabelText('After-chain step'), { target: { value: '/effort medium' } });

    fireEvent.click(screen.getByText('Save'));
    expect(onSave.mock.calls[0][0].afterChain[0].text).toBe('/effort medium');
  });

  it('closes the menu after a pick', () => {
    renderModal(mkItem());
    fireEvent.click(effortTrigger('before'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^high/ }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('clicking the trigger again closes the menu instead of reopening it', () => {
    renderModal(mkItem());
    fireEvent.click(effortTrigger('before'));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.mouseDown(effortTrigger('before'));
    fireEvent.click(effortTrigger('before'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('jumping from the BEFORE menu to the AFTER trigger moves focus into the new menu', () => {
    renderModal(mkItem());
    fireEvent.click(effortTrigger('before'));

    // A real click focuses the trigger it lands on, then toggles.
    act(() => { effortTrigger('after').focus(); });
    fireEvent.mouseDown(effortTrigger('after'));
    fireEvent.click(effortTrigger('after'));

    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
  });

  it('Escape closes the menu first and leaves the modal open', () => {
    const onClose = vi.fn();
    render(
      <QueueItemEditModal
        item={mkItem()}
        autoSendEnabled
        sessionId="sess"
        onClose={onClose}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(effortTrigger('before'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('only one picker is open at a time: opening effort closes the saved-prompts menu', () => {
    renderModal(mkItem());
    fireEvent.click(screen.getAllByRole('button', { name: /from saved/i })[0]);
    expect(screen.queryByRole('dialog', { name: /saved prompts/i })).not.toBeNull();

    fireEvent.mouseDown(effortTrigger('before'));
    fireEvent.click(effortTrigger('before'));
    expect(screen.queryByRole('dialog', { name: /saved prompts/i })).toBeNull();
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('works for loop items too — chains are not type-scoped', () => {
    const onSave = renderModal(mkItem({ type: 'loop', intervalMs: 600_000, nextFireAt: Date.now() + 1 }));
    fireEvent.click(effortTrigger('before'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^ultracode/ }));
    fireEvent.click(screen.getByText('Save'));
    expect(onSave.mock.calls[0][0].beforeChain[0].text).toBe('/effort ultracode');
  });

  it('hides the picker for a Codex session — Codex has no /effort', () => {
    act(() => {
      useSessionStore.setState({
        sessions: new Map([['sess', mkSession({ cliSource: 'codex', model: 'gpt-5' })]]),
      });
    });
    renderModal(mkItem());
    expect(screen.queryByRole('button', { name: /set effort/i })).toBeNull();
    // The rest of the chain editor is untouched.
    expect(screen.getAllByRole('button', { name: /from saved/i })).toHaveLength(2);
  });

  it('shows the picker when the session is not in the store yet (defaults to Claude, like autocomplete)', () => {
    useSessionStore.setState({ sessions: new Map() });
    renderModal(mkItem());
    expect(screen.getAllByRole('button', { name: /set effort/i })).toHaveLength(2);
  });
});
