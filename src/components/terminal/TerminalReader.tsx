/**
 * TerminalReader — the desktop terminal's Formatted view (Nov 16 2026; labelled "Reader view"
 * until Nov 18 2026, renamed because it has a composer and isn't read-only).
 *
 *   [toolbar … 📖 Reader …]
 *   ┌──────────────────────────────┐
 *   │  ## heading · lists · `code` │  the phone Chat's rows (ChatView): formatted
 *   │  ┌────┬────┐ tables fit      │  Markdown from the transcript
 *   │ ┌ ⚠ Allow Bash? [Deny][Allow]┐│  ChatFooter (Nov 18 2026): the waiting card
 *   │ └ Reply to Claude…   [Send ↑]┘│  and the composer, so Reader is usable
 *   └──────────────────────────────┘
 *
 * Typing a character while the chat itself has focus (not the composer) goes back
 * to the live terminal and types it there (`onTypeToTerminal`).
 *
 * Drawn over the terminal area, never instead of it: xterm stays mounted and laid
 * out underneath, so the PTY width is never re-fitted from a hidden element.
 * The phone tokens (--ph-*) are remapped to the desktop theme in the module, on the
 * reader and (while one is open) on <body>, where the kit's sheets are portaled.
 */
import { lazy, Suspense, useEffect, useCallback, type KeyboardEvent } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { READER_BODY_CLASS, isTypeThrough } from '@/lib/readerMode';
import { dirLinkTarget, linkTarget } from '@/lib/filePathLink';
import type { OpenFileOptions } from '@/components/mobile/chat/fileLinkContext';
import styles from '@/styles/modules/TerminalReader.module.css';

const ChatView = lazy(() => import('@/components/mobile/chat/ChatView'));
const ChatFooter = lazy(() => import('@/components/mobile/chat/ChatFooter'));

let openReaders = 0;

interface TerminalReaderProps {
  sessionId: string;
  /** Back to the live terminal (the chat's own "Open Terminal" buttons). */
  onTerminal: () => void;
  /** Back to the live terminal with this character typed into it. */
  onTypeToTerminal?: (key: string) => void;
}

export default function TerminalReader({ sessionId, onTerminal, onTypeToTerminal }: TerminalReaderProps) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));

  useEffect(() => {
    openReaders += 1;
    document.body.classList.add(READER_BODY_CLASS);
    return () => {
      openReaders -= 1;
      if (openReaders === 0) document.body.classList.remove(READER_BODY_CLASS);
    };
  }, []);

  // A file or folder the chat names (Nov 18 2026: Reader had no file links at all) opens the
  // desktop's chooser where it was clicked, as CONVERSATION's links do.
  const projectPath = session?.projectPath ?? '';
  const openFile = useCallback((path: string, options?: OpenFileOptions) => {
    if (!projectPath) return;
    const absolute = options?.outside ? path : `${projectPath.replace(/\/+$/, '')}${path === '/' ? '' : path}`;
    const target = options?.kind === 'dir' ? dirLinkTarget(absolute, projectPath) : linkTarget(absolute, projectPath);
    const anchor = options?.anchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    useUiStore.getState().openFileChooser(target.filePath, target.projectPath, anchor, target.hostProjectPath, target.kind);
  }, [projectPath]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (!onTypeToTerminal || !isTypeThrough(e)) return;
    e.preventDefault();
    // The key is the terminal's now: not also `[` / `]` (switch session) for the page's shortcuts.
    e.stopPropagation();
    onTypeToTerminal(e.key);
  }, [onTypeToTerminal]);

  return (
    // tabIndex -1: a click on the chat's text focuses the reader, so typing reaches onKeyDown.
    <div className={styles.reader} data-testid="terminal-reader" data-desktop-reader="" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className={styles.column}>
        {session ? (
          <Suspense fallback={<div className={styles.note}>Loading…</div>}>
            <div className={styles.chat}>
              <ChatView session={session} onTerminal={onTerminal} onOpenFile={openFile} openOutsideFiles composer />
            </div>
            <ChatFooter session={session} onTerminal={onTerminal} />
          </Suspense>
        ) : (
          <div className={styles.note}>This session is no longer available.</div>
        )}
      </div>
    </div>
  );
}
