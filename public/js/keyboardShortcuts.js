/**
 * @module keyboardShortcuts
 * Global keyboard shortcut handlers. Maps keys to actions: / (search), Escape (send to terminal),
 * ? (shortcuts help), S (settings), K (kill), A (archive), T (new session), M (mute all).
 */
import { getSelectedSessionId } from './sessionPanel.js';
import { sendEscape as terminalSendEscape } from './terminalManager.js';

export function initKeyboardShortcuts() {
  // Capture-phase Escape handler — fires BEFORE the browser can blur the
  // xterm textarea, so a single Escape press reliably sends \x1b to SSH.
  // Capture phase runs before bubble phase and before default browser actions.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const activeTab = document.querySelector('.detail-tabs .tab.active');
    if (activeTab && activeTab.dataset.tab === 'terminal') {
      e.preventDefault();
      e.stopPropagation();
      terminalSendEscape();
    }
  }, true); // <-- capture phase

  // Bubble-phase handler for all other shortcuts
  document.addEventListener('keydown', (e) => {
    // Skip if user is typing in an input/textarea
    const tag = e.target.tagName;
    // Never intercept xterm terminal keypresses
    if (e.target.classList.contains('xterm-helper-textarea')) return;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
      return;
    }

    // Don't intercept when modifiers are held
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case '/': {
        e.preventDefault();
        const searchInput = document.getElementById('live-search');
        if (searchInput) searchInput.focus();
        break;
      }
      case '?': {
        e.preventDefault();
        const scModal = document.getElementById('shortcuts-modal');
        if (scModal) scModal.classList.toggle('hidden');
        break;
      }
      case 's':
      case 'S': {
        e.preventDefault();
        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal) settingsModal.classList.toggle('hidden');
        break;
      }
      case 'k':
      case 'K': {
        if (getSelectedSessionId()) {
          document.getElementById('ctrl-kill')?.click();
        }
        break;
      }
      case 'a':
      case 'A': {
        if (getSelectedSessionId()) {
          document.getElementById('ctrl-archive')?.click();
        }
        break;
      }
      case 't':
      case 'T': {
        document.getElementById('new-session-modal')?.classList.remove('hidden');
        break;
      }
      case 'm':
      case 'M': {
        document.getElementById('qa-mute-all')?.click();
        break;
      }
    }
  });
}
