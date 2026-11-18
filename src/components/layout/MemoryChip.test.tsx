import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MemoryChip from './MemoryChip';
import { useSessionMemoryStore } from '@/stores/sessionMemoryStore';
import { useUiStore, CLOSE_SUGGESTIONS_MODAL_ID } from '@/stores/uiStore';

vi.mock('@/hooks/useSessionMemoryPoll', () => ({ useSessionMemoryPoll: () => {} }));
vi.mock('@/components/modals/CloseSuggestionsModal', () => ({
  default: () => <div role="dialog" aria-label="Sessions to close" />,
}));

const GB = 1024 ** 3;

afterEach(() => {
  cleanup();
  useSessionMemoryStore.setState({ sample: null });
  useUiStore.setState({ activeModal: null });
});

describe('MemoryChip', () => {
  it('renders nothing before the first reading', () => {
    const { container } = render(<MemoryChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a button that opens the sessions-to-close list', async () => {
    useSessionMemoryStore.setState({
      sample: { at: 1, totalBytes: 2 * GB, appBytes: GB / 2, bySession: { a: GB }, asleep: 3 },
    });
    render(<MemoryChip />);
    const chip = screen.getByRole('button', { name: /Memory in use: ≈ 2\.0 GB\. Show sessions to close/ });
    expect(chip).toHaveTextContent('z 3');
    expect(chip.title).toContain('Click to list sessions to close');
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(chip);
    expect(useUiStore.getState().activeModal).toBe(CLOSE_SUGGESTIONS_MODAL_ID);
    expect(await screen.findByRole('dialog', { name: 'Sessions to close' })).toBeInTheDocument();
  });
});
