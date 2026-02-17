/**
 * useKeyboardShortcuts — global keyboard shortcut handler.
 * Shortcuts are suppressed when focus is in an input, textarea, or contenteditable.
 *
 * Bindings:
 *   /       Focus search
 *   Escape  Close modal / deselect session
 *   ?       Toggle shortcuts panel
 *   S       Toggle settings
 *   K       Kill selected session
 *   A       Archive selected session
 *   T       Open new terminal modal
 *   M       Toggle global mute
 */
import { useEffect, useCallback } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTyping(e: KeyboardEvent): boolean {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((e.target as HTMLElement)?.isContentEditable) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Mute state (module-level since it's toggled from multiple places)
// ---------------------------------------------------------------------------

let globalMuted = false;
const muteListeners = new Set<(muted: boolean) => void>();

export function getGlobalMuted(): boolean {
  return globalMuted;
}

export function toggleGlobalMuted(): boolean {
  globalMuted = !globalMuted;
  for (const fn of muteListeners) fn(globalMuted);
  return globalMuted;
}

export function onMuteChange(fn: (muted: boolean) => void): () => void {
  muteListeners.add(fn);
  return () => muteListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useKeyboardShortcuts(): void {
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const activeModal = useUiStore((s) => s.activeModal);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const deselectSession = useSessionStore((s) => s.deselectSession);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Always allow Escape
      if (e.key === 'Escape') {
        if (activeModal) {
          closeModal();
        } else if (selectedSessionId) {
          deselectSession();
        }
        return;
      }

      // Don't intercept when typing in form fields
      if (isTyping(e)) return;

      // Don't intercept with modifier keys (Ctrl, Cmd, Alt)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case '/': {
          e.preventDefault();
          const searchInput = document.querySelector<HTMLInputElement>(
            '[data-search-input]',
          );
          searchInput?.focus();
          break;
        }

        case '?':
          e.preventDefault();
          if (activeModal === 'shortcuts') {
            closeModal();
          } else {
            openModal('shortcuts');
          }
          break;

        case 'S':
        case 's':
          e.preventDefault();
          if (activeModal === 'settings') {
            closeModal();
          } else {
            openModal('settings');
          }
          break;

        case 'T':
        case 't':
          e.preventDefault();
          openModal('new-session');
          break;

        case 'K':
        case 'k':
          if (selectedSessionId) {
            e.preventDefault();
            killSelectedSession(selectedSessionId);
          }
          break;

        case 'A':
        case 'a':
          if (selectedSessionId) {
            e.preventDefault();
            archiveSelectedSession(selectedSessionId);
          }
          break;

        case 'M':
        case 'm': {
          e.preventDefault();
          const muted = toggleGlobalMuted();
          showToast(muted ? 'Sound muted' : 'Sound unmuted', 'info', 1500);
          break;
        }
      }
    },
    [activeModal, selectedSessionId, openModal, closeModal, deselectSession],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

// ---------------------------------------------------------------------------
// Session control helpers (API calls)
// ---------------------------------------------------------------------------

async function killSelectedSession(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Session killed', 'info');
    } else {
      showToast(data.error || 'Failed to kill session', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  }
}

async function archiveSelectedSession(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Session archived', 'info');
    } else {
      showToast(data.error || 'Failed to archive session', 'error');
    }
  } catch {
    showToast('Network error', 'error');
  }
}
