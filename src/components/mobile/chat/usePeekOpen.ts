/**
 * usePeekOpen — this phone's "show the terminal's last lines" switch (peekPreference),
 * shared by the composer's status chip, full-screen Chat's strip and the peek ChatView draws.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { getPeekOpen, setPeekOpen, subscribePeekOpen } from '@/lib/chat/peekPreference';

const closedOnServer = () => false;

/** The id of a session's open peek above the composer, for the chip's aria-controls. */
export function peekPanelId(sessionId: string): string {
  return `${sessionId}-terminal-peek`;
}

export function usePeekOpen(): [open: boolean, toggle: () => void] {
  const open = useSyncExternalStore(subscribePeekOpen, getPeekOpen, closedOnServer);
  const toggle = useCallback(() => setPeekOpen(!getPeekOpen()), []);
  return [open, toggle];
}
