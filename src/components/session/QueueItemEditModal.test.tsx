import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QueueItemEditModal from './QueueItemEditModal';
import type { QueueItem } from '@/stores/queueStore';

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
