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
// Hook
// ---------------------------------------------------------------------------

export function useKeyboardShortcuts(): void {
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);
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

      // Cmd+Shift+F (macOS) / Ctrl+Shift+F — open global session content search
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        if (currentModal === 'global-search') {
          closeModal();
        } else {
          openModal('global-search');
        }
        return;
      }

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
      // Exception: Alt+1-9 session-switch shortcuts fire even when xterm is focused
      //   (xterm uses a hidden <textarea> so isTyping() returns true)
      if (isTyping(e)) {
        const inXterm = !!(e.target as HTMLElement)?.closest?.('.xterm');
        const isModifierSwitch = e.altKey && (e.metaKey || e.ctrlKey);
        if (!inXterm || !isModifierSwitch) return;
        // fall through to shortcut lookup
      }

      // Look up action from store bindings
      const actionId = useShortcutStore.getState().findActionForEvent(e);
      if (!actionId) return;

      e.preventDefault();
      dispatchAction(actionId);
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeModal, openModal, activeModal]);
}

// ---------------------------------------------------------------------------
// Action dispatcher
// ---------------------------------------------------------------------------

function dispatchAction(actionId: string): void {
  switch (actionId) {
    case 'toggleFullscreen':
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      break;
    case 'scrollToBottom':
      document.dispatchEvent(new CustomEvent('terminal:scrollToBottom'));
      break;
    case 'switchLatestSession':
      switchToPreviousSession();
      break;
    default:
      if (actionId.startsWith('fileBrowser')) {
        document.dispatchEvent(
          new CustomEvent('fileBrowser:action', { detail: { actionId } }),
        );
        return;
      }
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

function switchToPreviousSession(): void {
  const { sessions, previousSessionId, selectedSessionId } = useSessionStore.getState();
  if (!previousSessionId) return;
  // Make sure the previous session still exists and is not ended
  const prev = sessions.get(previousSessionId);
  if (!prev || prev.status === 'ended') return;
  // Don't switch to same session
  if (previousSessionId === selectedSessionId) return;
  useSessionStore.getState().selectSession(previousSessionId);
  const name = prev.title || prev.projectName || 'previous session';
  showToast(`Switched to ${name}`, 'info', 1500);
}

function switchToSessionByIndex(index: number): void {
  const sessions = useSessionStore.getState().sessions;
  // Sort matching SessionSwitcher order: pinned first, then status, then title
  const active = [...sessions.values()]
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      const oa = SWITCH_STATUS_ORDER[a.status] ?? 5;
      const ob = SWITCH_STATUS_ORDER[b.status] ?? 5;
      if (oa !== ob) return oa - ob;
      return (a.title || a.projectName || '').localeCompare(b.title || b.projectName || '');
    });
  if (index >= 0 && index < active.length) {
    const target = active[index];
    useSessionStore.getState().selectSession(target.sessionId);
    const name = target.title || target.projectName || `session ${index + 1}`;
    showToast(`Switched to ${name}`, 'info', 1500);
  }
}

