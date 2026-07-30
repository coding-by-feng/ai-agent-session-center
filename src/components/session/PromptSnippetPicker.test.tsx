import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PromptSnippetPicker, { SNIPPET_TRIGGER_ATTR } from './PromptSnippetPicker';
import { usePromptSnippetStore, type PromptSnippet } from '@/stores/promptSnippetStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

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

function snippet(over: Partial<PromptSnippet> & { id: number; text: string }): PromptSnippet {
  return {
    label: '',
    useCount: 0,
    lastUsedAt: null,
    createdAt: 1_000,
    ...over,
  };
}

/** Minimal session shaped just enough for the RECENT pooling selector. */
function session(id: string, projectName: string, prompts: Array<[string, number]>): Session {
  return {
    sessionId: id,
    projectName,
    promptHistory: prompts.map(([text, timestamp]) => ({ text, timestamp })),
  } as unknown as Session;
}

/** A detached trigger button to hang the picker off. */
function makeAnchor(): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute(SNIPPET_TRIGGER_ATTR, 'compose');
  document.body.appendChild(el);
  return el;
}

let anchor: HTMLElement;

beforeEach(() => {
  anchor = makeAnchor();
  usePromptSnippetStore.setState({
    snippets: [
      snippet({ id: 1, text: '/compact', label: 'compact run', useCount: 12 }),
      snippet({ id: 2, text: '/ascii-review-first', useCount: 5 }),
      snippet({ id: 3, text: 'add tests for the matcher', useCount: 0 }),
    ],
    loaded: true,
  });
  useSessionStore.setState({
    sessions: new Map([
      ['s1', session('s1', 'agent-manager', [['fix the queue motion', 300], ['/compact', 100]])],
      ['s2', session('s2', 'thesis', [['bump the thesis intro', 400]])],
    ]),
  });
});

afterEach(() => {
  anchor.remove();
  vi.clearAllMocks();
});

function renderPicker(props: Partial<React.ComponentProps<typeof PromptSnippetPicker>> = {}) {
  return render(
    <PromptSnippetPicker
      anchor={anchor}
      onInsert={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe('PromptSnippetPicker', () => {
  // The whole reason this component exists as a portal: every trigger sits
  // inside a scroll box (.queueBody at 250px, .chainModalBody), which would clip
  // an absolutely-positioned menu on BOTH axes. Nesting it back in the tree
  // silently reintroduces the crop, and no linter catches it.
  it('portals the menu to document.body rather than nesting it at the call site', () => {
    const { container } = renderPicker();

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const menu = screen.getByRole('dialog', { name: 'Saved prompts' });
    expect(menu.parentElement).toBe(document.body);
  });

  it('opens on the SAVED tab and lists every kept snippet', () => {
    renderPicker();

    expect(screen.getByRole('tab', { name: /SAVED \(3\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('compact run')).toBeTruthy();
    expect(screen.getByText('add tests for the matcher')).toBeTruthy();
  });

  it('orders SAVED by most used', () => {
    renderPicker();

    const titles = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.includes('/') || t.includes('add tests'));
    expect(titles[0]).toContain('compact run');
  });

  it('falls back to the first line when a snippet has no name', () => {
    usePromptSnippetStore.setState({
      snippets: [snippet({ id: 1, text: 'line one\nline two' })],
      loaded: true,
    });
    renderPicker();
    expect(screen.getByText('line one')).toBeTruthy();
  });

  it('inserts the snippet text and closes', () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();
    renderPicker({ onInsert, onClose });

    fireEvent.click(screen.getByText('compact run'));

    expect(onInsert).toHaveBeenCalledWith('/compact');
    expect(onClose).toHaveBeenCalled();
  });

  it('filters SAVED by text and by name', () => {
    renderPicker();
    const filter = screen.getByPlaceholderText('Filter…');

    fireEvent.change(filter, { target: { value: 'ascii' } });
    expect(screen.getByText('/ascii-review-first')).toBeTruthy();
    expect(screen.queryByText('compact run')).toBeNull();

    fireEvent.change(filter, { target: { value: 'compact run' } });
    expect(screen.getByText('compact run')).toBeTruthy();
  });

  it('tells the user how to populate an empty library', () => {
    usePromptSnippetStore.setState({ snippets: [], loaded: true });
    renderPicker();
    expect(screen.getByText(/No saved prompts yet/)).toBeTruthy();
  });

  it('distinguishes "no matches" from "nothing saved"', () => {
    renderPicker();
    fireEvent.change(screen.getByPlaceholderText('Filter…'), {
      target: { value: 'zzzznope' },
    });
    expect(screen.getByText('No saved prompts match the filter.')).toBeTruthy();
  });

  describe('RECENT tab', () => {
    it('pools prompt history from every session, newest first', () => {
      renderPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'RECENT' }));

      expect(screen.getByText('bump the thesis intro')).toBeTruthy();
      expect(screen.getByText('fix the queue motion')).toBeTruthy();
    });

    it('shows the source session as a breadcrumb on every row', () => {
      renderPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'RECENT' }));

      expect(screen.getByText('thesis')).toBeTruthy();
      // s1 contributes two rows, so its breadcrumb legitimately repeats.
      expect(screen.getAllByText('agent-manager')).toHaveLength(2);
    });

    // The curation rule: history is browsable, but a row already in the library
    // offers no second keep button.
    it('marks an already-kept prompt instead of offering to keep it again', () => {
      renderPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'RECENT' }));

      // '/compact' is in both the library and s1's history.
      expect(screen.getByTitle('Already in saved prompts')).toBeTruthy();
      const keepButtons = screen.getAllByLabelText('Keep prompt for reuse');
      // Two unkept history rows → two keep buttons, not three.
      expect(keepButtons).toHaveLength(2);
    });

    it('keeps a history row into the library', () => {
      // Spy BEFORE render: the component captures `save` from the store via a
      // selector at render time, so a spy installed afterwards is a different
      // reference and would never be called.
      const saveSpy = vi
        .spyOn(usePromptSnippetStore.getState(), 'save')
        .mockResolvedValue({ id: 42, duplicate: false });
      renderPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'RECENT' }));

      fireEvent.click(screen.getAllByLabelText('Keep prompt for reuse')[0]);
      expect(saveSpy).toHaveBeenCalledWith('bump the thesis intro');
    });

    it('inserts a history row without keeping it', () => {
      const onInsert = vi.fn();
      renderPicker({ onInsert });
      fireEvent.click(screen.getByRole('tab', { name: 'RECENT' }));

      fireEvent.click(screen.getByText('fix the queue motion'));
      expect(onInsert).toHaveBeenCalledWith('fix the queue motion');
      expect(usePromptSnippetStore.getState().snippets).toHaveLength(3);
    });
  });

  describe('rename', () => {
    it('renames a snippet on Enter', () => {
      const setLabel = vi.spyOn(usePromptSnippetStore.getState(), 'setLabel');
      renderPicker();

      fireEvent.click(screen.getAllByLabelText('Rename saved prompt')[0]);
      const input = screen.getByPlaceholderText('Name this prompt…');
      fireEvent.change(input, { target: { value: 'squash it' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(setLabel).toHaveBeenCalledWith(1, 'squash it');
    });

    // Escape inside the rename input must cancel the rename, NOT the picker —
    // the picker's own Escape listener is on `document`.
    it('cancels the rename on Escape without closing the picker', () => {
      const onClose = vi.fn();
      const setLabel = vi.spyOn(usePromptSnippetStore.getState(), 'setLabel');
      renderPicker({ onClose });

      fireEvent.click(screen.getAllByLabelText('Rename saved prompt')[0]);
      const input = screen.getByPlaceholderText('Name this prompt…');
      fireEvent.change(input, { target: { value: 'discard me' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(setLabel).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.queryByPlaceholderText('Name this prompt…')).toBeNull();
    });
  });

  it('forgets a snippet', () => {
    const remove = vi.spyOn(usePromptSnippetStore.getState(), 'remove');
    renderPicker();

    fireEvent.click(screen.getAllByLabelText('Forget saved prompt')[0]);
    expect(remove).toHaveBeenCalledWith(1);
  });

  describe('dismissal', () => {
    it('closes on Escape and on an outside mousedown', () => {
      const onClose = vi.fn();
      renderPicker({ onClose });

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);

      fireEvent.mouseDown(document.body);
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('ignores mousedown on a trigger so the button keeps its own toggle', () => {
      const onClose = vi.fn();
      renderPicker({ onClose });

      fireEvent.mouseDown(anchor);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not close on a click inside the menu', () => {
      const onClose = vi.fn();
      renderPicker({ onClose });

      fireEvent.mouseDown(screen.getByPlaceholderText('Filter…'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
