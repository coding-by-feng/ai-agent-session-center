/**
 * Where focus goes when the picker opens and closes. A browser refuses to focus a `visibility: hidden` element and
 * jsdom does not, so `focus` is wrapped to refuse the same way: without that these pass with the bug still in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import PromptSnippetPicker, { SNIPPET_TRIGGER_ATTR } from './PromptSnippetPicker';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';

const platform = vi.hoisted(() => ({ isMobile: false }));

vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

vi.mock('@/lib/db', () => ({
  db: {
    promptSnippets: {
      add: vi.fn(async () => 99),
      update: vi.fn(async () => 1),
      delete: vi.fn(async () => undefined),
      orderBy: vi.fn(() => ({ reverse: () => ({ toArray: async () => [] }) })),
    },
  },
}));

let anchor: HTMLButtonElement;
let elsewhere: HTMLButtonElement;

function renderPicker(onClose = vi.fn()) {
  render(<PromptSnippetPicker anchor={anchor} onInsert={vi.fn()} onClose={onClose} />);
  return { filter: screen.getByPlaceholderText('Filter…'), onClose };
}

beforeEach(() => {
  platform.isMobile = false;
  anchor = document.createElement('button');
  anchor.setAttribute(SNIPPET_TRIGGER_ATTR, 'compose');
  elsewhere = document.createElement('button');
  document.body.append(anchor, elsewhere);
  usePromptSnippetStore.setState({
    snippets: [{ id: 1, text: '/compact', label: 'compact run', useCount: 1, lastUsedAt: null, createdAt: 1 }],
    loaded: true,
  });

  const realFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focusLikeABrowser(this: HTMLElement, options) {
    if (getComputedStyle(this).visibility === 'hidden') return;
    realFocus.call(this, options);
  });
});

afterEach(() => {
  cleanup();
  anchor.remove();
  elsewhere.remove();
  vi.restoreAllMocks();
});

describe('PromptSnippetPicker focus', () => {
  it('puts focus in the filter on open, so typing goes straight into it', () => {
    const { filter } = renderPicker();
    expect(filter).toHaveFocus();
  });

  it('hands focus back to the trigger on Escape', () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(anchor).toHaveFocus();
  });

  it('hands focus back to the trigger after a pick', () => {
    const { onClose } = renderPicker();
    fireEvent.click(screen.getByText('compact run'));
    expect(onClose).toHaveBeenCalled();
    expect(anchor).toHaveFocus();
  });

  it('leaves focus where the user put it on an outside click', () => {
    const { onClose } = renderPicker();
    elsewhere.focus();
    fireEvent.mouseDown(elsewhere);
    expect(onClose).toHaveBeenCalled();
    expect(elsewhere).toHaveFocus();
  });

  it('does not throw when the trigger is gone by the time it closes', () => {
    const { onClose } = renderPicker();
    anchor.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  describe('on a phone', () => {
    beforeEach(() => {
      platform.isMobile = true;
    });

    // Focus in the filter would raise the keyboard over the list that just opened.
    it('does not focus the filter on open', () => {
      const { filter } = renderPicker();
      expect(filter).not.toHaveFocus();
    });

    // Moving focus to the trigger would take it from the prompt box and close a keyboard that is already up.
    it('does not move focus on close', () => {
      const box = document.createElement('textarea');
      document.body.append(box);
      box.focus();
      renderPicker();
      fireEvent.click(screen.getByText('compact run'));
      expect(box).toHaveFocus();
      box.remove();
    });
  });
});
