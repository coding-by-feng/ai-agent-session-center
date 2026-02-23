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
  // Read modal state reactively (changes the shortcuts panel visibility)
  const openModal = useUiStore((s) => s.openModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const activeModal = useUiStore((s) => s.activeModal);

  // IMPORTANT: Do NOT subscribe to selectedSessionId via useSessionStore((s) => s.selectedSessionId).
  // That subscription forces AppLayout to re-render on every selection change, which cascades
  // through Canvas → SceneContent → all SessionRobots → drei <Html> portals, triggering
  // React Error #185 (maximum update depth exceeded). Instead, read from getState() at
  // event-handler time so the keyboard handler always gets the latest value without
  // causing re-renders.

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const currentModal = useUiStore.getState().activeModal;
      const selectedId = useSessionStore.getState().selectedSessionId;

      // Always allow Escape — but pass it through to the terminal when focused
      if (e.key === 'Escape') {
        if (currentModal) {
          closeModal();
        } else if ((e.target as HTMLElement)?.closest?.('.xterm')) {
          // Terminal has focus — let xterm handle Escape (sends \x1b to SSH)
          return;
        } else if (selectedId) {
          useSessionStore.getState().deselectSession();
        }
        return;
      }

      // Don't intercept when typing in form fields
      if (isTyping(e)) return;

      // Alt+F11: toggle browser fullscreen
      if (e.key === 'F11' && e.altKey) {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        return;
      }

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
          if (currentModal === 'shortcuts') {
            closeModal();
          } else {
            openModal('shortcuts');
          }
          break;

        case 'S':
        case 's':
          e.preventDefault();
          if (currentModal === 'settings') {
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
          if (selectedId) {
            e.preventDefault();
            killSelectedSession(selectedId);
          }
          break;

        case 'A':
        case 'a':
          if (selectedId) {
            e.preventDefault();
            archiveSelectedSession(selectedId);
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
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openModal, closeModal, activeModal]);
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
