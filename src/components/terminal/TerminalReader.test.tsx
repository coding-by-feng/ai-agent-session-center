/**
 * Reader view is usable, not read-only (Nov 18 2026): the phone Chat's footer (waiting card
 * + composer) sits under the chat, and a character typed on the chat itself goes back to
 * the live terminal, typed there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

type Open = (path: string, options?: { kind?: 'dir'; outside?: boolean; anchor?: { x: number; y: number } }) => void;
vi.mock('@/components/mobile/chat/ChatView', () => ({
  default: ({ composer, onOpenFile, openOutsideFiles }: { composer?: boolean; onOpenFile?: Open; openOutsideFiles?: boolean }) => (
    <div data-testid="chat-view" data-composer={composer ? 'on' : 'off'} data-outside={openOutsideFiles ? 'on' : 'off'}>
      <button type="button" onClick={() => onOpenFile?.('/docs/plan.md', { anchor: { x: 40, y: 50 } })}>inside file</button>
      <button type="button" onClick={() => onOpenFile?.('/docs', { kind: 'dir', anchor: { x: 1, y: 2 } })}>inside folder</button>
      <button type="button" onClick={() => onOpenFile?.('/elsewhere/x.md', { outside: true, anchor: { x: 1, y: 2 } })}>outside file</button>
    </div>
  ),
}));
vi.mock('@/components/mobile/chat/ChatFooter', () => ({
  default: () => <textarea data-testid="chat-footer-box" />,
}));

import TerminalReader from './TerminalReader';
import { READER_BODY_CLASS } from '@/lib/readerMode';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

const SID = 'reader-1';

beforeEach(() => {
  cleanup();
  const sessions = new Map([[SID, { sessionId: SID, status: 'waiting', events: [], projectPath: '/Users/me/proj' } as unknown as Session]]);
  useUiStore.setState({ pendingFileChooser: null });
  useSessionStore.setState({ sessions } as never);
});

const renderReader = (onTypeToTerminal = vi.fn()) => {
  render(<TerminalReader sessionId={SID} onTerminal={vi.fn()} onTypeToTerminal={onTypeToTerminal} />);
  return onTypeToTerminal;
};

describe('TerminalReader — interact without leaving Reader', () => {
  it('draws the composer footer under the chat, and tells the chat a composer is there', async () => {
    renderReader();
    expect(await screen.findByTestId('chat-footer-box')).toBeTruthy();
    expect((await screen.findByTestId('chat-view')).dataset.composer).toBe('on');
  });

  it('puts the phone tokens on <body> while open, for the portaled sheets', () => {
    renderReader();
    expect(document.body.classList.contains(READER_BODY_CLASS)).toBe(true);
    cleanup();
    expect(document.body.classList.contains(READER_BODY_CLASS)).toBe(false);
  });

  it('a character typed on the chat goes to the terminal', () => {
    const onType = renderReader();
    fireEvent.keyDown(screen.getByTestId('terminal-reader'), { key: 'h' });
    expect(onType).toHaveBeenCalledWith('h');
  });

  it('the typed key goes to the terminal only, not also to the page shortcuts (`[` / `]` switch sessions)', () => {
    const onType = renderReader();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener('keydown', listener);
    fireEvent.keyDown(screen.getByTestId('terminal-reader'), { key: ']' });
    document.removeEventListener('keydown', listener);
    expect(onType).toHaveBeenCalledWith(']');
    expect(seen).toEqual([]);
  });

  it('typing in the composer, shortcuts and Space stay in Reader', async () => {
    const onType = renderReader();
    const reader = screen.getByTestId('terminal-reader');
    fireEvent.keyDown(await screen.findByTestId('chat-footer-box'), { key: 'h' });
    fireEvent.keyDown(reader, { key: 'c', metaKey: true });
    fireEvent.keyDown(reader, { key: ' ' });
    fireEvent.keyDown(reader, { key: 'ArrowDown' });
    expect(onType).not.toHaveBeenCalled();
  });
});

// Nov 18 2026: Reader had no file links at all; they open the desktop's chooser, as CONVERSATION's do.
describe('TerminalReader — files the chat names', () => {
  it('lets the chat link paths outside the project too', async () => {
    renderReader();
    expect((await screen.findByTestId('chat-view')).dataset.outside).toBe('on');
  });

  it('a file opens the chooser where it was clicked, relative to the session folder', async () => {
    renderReader();
    fireEvent.click(await screen.findByText('inside file'));
    expect(useUiStore.getState().pendingFileChooser).toEqual({ filePath: 'docs/plan.md', projectPath: '/Users/me/proj', anchor: { x: 40, y: 50 } });
  });

  it('a folder opens it as a folder, rooted at itself', async () => {
    renderReader();
    fireEvent.click(await screen.findByText('inside folder'));
    expect(useUiStore.getState().pendingFileChooser).toMatchObject({ kind: 'dir', projectPath: '/Users/me/proj/docs', filePath: '/', hostProjectPath: '/Users/me/proj' });
  });

  it('a file outside the project is rooted at its own folder', async () => {
    renderReader();
    fireEvent.click(await screen.findByText('outside file'));
    expect(useUiStore.getState().pendingFileChooser).toMatchObject({ filePath: 'x.md', projectPath: '/elsewhere', hostProjectPath: '/Users/me/proj' });
  });
});
