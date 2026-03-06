/**
 * useKeyboardShortcuts — global keyboard shortcut handler.
 * Reads bindings from shortcutStore so users can customize keybindings.
 */
import { useEffect } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useShortcutStore } from '@/stores/shortcutStore';
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

      // Escape is always special: close modal -> pass to terminal -> deselect
      if (e.key === 'Escape') {
        if (currentModal) {
          closeModal();
        } else if ((e.target as HTMLElement)?.closest?.('.xterm')) {
          return; // let xterm handle Escape (sends \x1b to SSH)
        } else if (selectedId) {
          useSessionStore.getState().deselectSession();
        }
        return;
      }

      // Don't intercept when typing in form fields.
      // Exception: Alt+1-9 session-switch shortcuts fire even when xterm is
      // focused — xterm uses a hidden <textarea> so isTyping() returns true,
      // but we still want these hotkeys to work from the terminal.
      if (isTyping(e)) {
        const inXterm = !!(e.target as HTMLElement)?.closest?.('.xterm');
        const isAltDigit = e.altKey && (e.metaKey || e.ctrlKey) && /^Digit[0-9]$/.test(e.code);
        if (!inXterm || !isAltDigit) return;
        // fall through to shortcut lookup
      }

      // Look up action from store bindings
      const actionId = useShortcutStore.getState().findActionForEvent(e);
      if (!actionId) return;

      e.preventDefault();
      dispatchAction(actionId, currentModal, selectedId, openModal, closeModal);
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openModal, closeModal, activeModal]);
}

// ---------------------------------------------------------------------------
// Action dispatcher
// ---------------------------------------------------------------------------

function dispatchAction(
  actionId: string,
  currentModal: string | null,
  selectedId: string | null,
  openModal: (id: string) => void,
  closeModal: () => void,
): void {
  switch (actionId) {
    case 'focusSearch': {
      const searchInput = document.querySelector<HTMLInputElement>('[data-search-input]');
      searchInput?.focus();
      break;
    }
    case 'toggleShortcuts':
      if (currentModal === 'shortcuts') closeModal();
      else openModal('shortcuts');
      break;
    case 'toggleSettings':
      if (currentModal === 'settings') closeModal();
      else openModal('settings');
      break;
    case 'newTerminal':
      openModal('new-session');
      break;
    case 'killSession':
      if (selectedId) killSelectedSession(selectedId);
      break;
    case 'archiveSession':
      if (selectedId) archiveSelectedSession(selectedId);
      break;
    case 'toggleMute': {
      const muted = toggleGlobalMuted();
      showToast(muted ? 'Sound muted' : 'Sound unmuted', 'info', 1500);
      break;
    }
    case 'toggleFullscreen':
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      break;
    default:
      // Handle switchSession1..switchSession9
      if (actionId.startsWith('switchSession')) {
        const idx = parseInt(actionId.replace('switchSession', ''), 10) - 1;
        switchToSessionByIndex(idx);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Session switching helper
// ---------------------------------------------------------------------------

const SWITCH_STATUS_ORDER: Record<string, number> = {
  working: 0, prompting: 1, approval: 2, input: 2,
  waiting: 3, idle: 4, connecting: 5, ended: 6,
};

function switchToSessionByIndex(index: number): void {
  const sessions = useSessionStore.getState().sessions;
  const filterMode = useUiStore.getState().sidebarFilterMode;
  // Sort matching sidebar/tab-strip order: status first, then title
  const active = [...sessions.values()]
    .filter((s) => {
      if (s.status === 'ended') return false;
      if (filterMode === 'ssh' && s.source !== 'ssh') return false;
      if (filterMode === 'others' && s.source === 'ssh') return false;
      return true;
    })
    .sort((a, b) => {
      const oa = SWITCH_STATUS_ORDER[a.status] ?? 5;
      const ob = SWITCH_STATUS_ORDER[b.status] ?? 5;
      if (oa !== ob) return oa - ob;
      return (a.title || 'Unnamed').localeCompare(b.title || 'Unnamed');
    });
  if (index >= 0 && index < active.length) {
    const target = active[index];
    useSessionStore.getState().selectSession(target.sessionId);
    const name = target.title || target.projectName || `session ${index + 1}`;
    showToast(`Switched to ${name}`, 'info', 1500);
  }
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
