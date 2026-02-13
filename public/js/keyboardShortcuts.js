/**
 * @module keyboardShortcuts
 * Global keyboard shortcut handlers. Maps keys to actions: / (search), Escape (close modals/panel),
 * ? (shortcuts help), S (settings), K (kill), A (archive), T (new session), M (mute all).
 */
import { getSelectedSessionId } from './sessionPanel.js';

export function initKeyboardShortcuts() {
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
      case 'n':
      case 'N': {
        e.preventDefault();
        import('./agendaManager.js').then(am => am.openAgendaItemModal());
        break;
      }
    }
  });
}
