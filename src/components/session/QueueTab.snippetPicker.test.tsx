// QueueTab.snippetPicker.test.tsx — the compose row's "Insert a saved prompt" button. It read e.currentTarget inside a
// state updater, and React clears currentTarget once the click is over. When the updater ran after that, the anchor
// came back null and the click did nothing: on a packaged build the picker opened on 2 of 8 rounds (Nov 3 2026).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import QueueTab from './QueueTab';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';

const picker = () => screen.queryByRole('dialog', { name: 'Saved prompts' });

describe('QueueTab saved prompts button', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    usePromptSnippetStore.setState({ snippets: [], loaded: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the picker on every click, and closes it on the next', () => {
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" alwaysOpen />);
    const trigger = screen.getByRole('button', { name: 'Insert a saved prompt' });
    const seen: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      fireEvent.click(trigger);
      seen.push(picker() !== null);
      fireEvent.click(trigger);
      seen.push(picker() === null);
    }
    expect(seen).toEqual(Array(16).fill(true));
  });

  // The same updater, forced to run after the click: a second state update already queued on the component means
  // React can't work it out on the spot. This is the shape that fails in a real window.
  it('opens the picker when the update runs after the click is over', () => {
    render(<QueueTab sessionId="s1" sessionStatus="waiting" terminalId="term-1" alwaysOpen />);
    const trigger = screen.getByRole('button', { name: 'Insert a saved prompt' });
    const box = screen.getByPlaceholderText(/Add a prompt to the queue/i);
    act(() => {
      fireEvent.change(box, { target: { value: 'typed first' } });
      fireEvent.click(trigger);
    });
    expect(picker()).not.toBeNull();
  });
});
