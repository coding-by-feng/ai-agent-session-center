import * as robotManager from './robotManager.js';
import { createOrUpdateCard, removeCard, updateDurations, showToast, getSelectedSessionId, deselectSession, archiveAllEnded, isMuted } from './sessionPanel.js';
import * as statsPanel from './statsPanel.js';
import * as wsClient from './wsClient.js';
import * as navController from './navController.js';
import * as historyPanel from './historyPanel.js';
import * as timelinePanel from './timelinePanel.js';
import * as analyticsPanel from './analyticsPanel.js';
import * as settingsManager from './settingsManager.js';
import * as soundManager from './soundManager.js';

let allSessions = {};
const approvalAlarmTimers = new Map(); // sessionId -> intervalId for repeating alarm

async function init() {
  // Load settings first
  await settingsManager.loadSettings();
  settingsManager.initSettingsUI();
  soundManager.init();

  // Connect WebSocket
  wsClient.connect({
    onSnapshotCb(sessions) {
      allSessions = sessions;
      for (const session of Object.values(sessions)) {
        createOrUpdateCard(session);
        robotManager.updateRobot(session);
      }
      statsPanel.update(sessions);
      updateTabTitle(sessions);
      toggleEmptyState(Object.keys(sessions).length === 0);
    },
    onSessionUpdateCb(session) {
      allSessions[session.sessionId] = session;
      createOrUpdateCard(session);
      robotManager.updateRobot(session);
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);

      const lastEvt = session.events[session.events.length - 1];
      if (lastEvt && !isMuted(session.sessionId)) {
        switch (lastEvt.type) {
          case 'SessionStart': soundManager.play('sessionStart'); break;
          case 'UserPromptSubmit': soundManager.play('promptSubmit'); break;
          case 'PreToolUse': {
            const toolMap = {
              Read: 'toolRead', Write: 'toolWrite', Edit: 'toolEdit',
              Bash: 'toolBash', Grep: 'toolGrep', Glob: 'toolGlob',
              WebFetch: 'toolWebFetch', Task: 'toolTask'
            };
            const toolName = lastEvt.tool_name || '';
            soundManager.play(toolMap[toolName] || 'toolOther');
            break;
          }
          case 'Stop': soundManager.play('taskComplete'); break;
          case 'SessionEnd': soundManager.play('sessionEnd'); break;
        }
      }

      // Approval alarm: play urgent sound when session enters approval state
      if (session.status === 'approval' && !isMuted(session.sessionId)) {
        if (!approvalAlarmTimers.has(session.sessionId)) {
          // Play immediately
          soundManager.play('approvalNeeded');
          // Repeat every 10s until cleared
          const intervalId = setInterval(() => {
            const current = allSessions[session.sessionId];
            if (!current || current.status !== 'approval' || isMuted(session.sessionId)) {
              clearInterval(intervalId);
              approvalAlarmTimers.delete(session.sessionId);
              return;
            }
            soundManager.play('approvalNeeded');
          }, 10000);
          approvalAlarmTimers.set(session.sessionId, intervalId);
        }
      } else if (session.status !== 'approval' && approvalAlarmTimers.has(session.sessionId)) {
        // Session left approval state — stop the alarm
        clearInterval(approvalAlarmTimers.get(session.sessionId));
        approvalAlarmTimers.delete(session.sessionId);
      }

      addActivityEntry(session);
      toggleEmptyState(Object.keys(allSessions).length === 0);

      if (session.status === 'ended') {
        setTimeout(() => {
          removeCard(session.sessionId);
          robotManager.removeRobot(session.sessionId);
          delete allSessions[session.sessionId];
          statsPanel.update(allSessions);
          updateTabTitle(allSessions);
          toggleEmptyState(Object.keys(allSessions).length === 0);
        }, 3000);
      }
    },
    onDurationAlertCb(data) {
      showToast('DURATION ALERT', `Session "${data.projectName}" exceeded ${Math.round(data.thresholdMs / 60000)} min (running: ${Math.round(data.elapsedMs / 60000)} min)`);
    }
  });

  // Duration timer + connection status update
  setInterval(() => {
    updateDurations();
    updateConnectionStatus();
  }, 1000);

  // Initialize navigation
  navController.init();

  // Initialize history panel (populate project filter, wire event listeners)
  historyPanel.init();

  // Wire view switching callbacks
  navController.onViewChange('history', () => historyPanel.refresh());
  navController.onViewChange('timeline', () => timelinePanel.refresh());
  navController.onViewChange('analytics', () => analyticsPanel.refresh());

  // Load historical stats after WS connects
  statsPanel.loadHistoricalStats();

  // Wire up keyboard shortcuts
  initKeyboardShortcuts();

  // Wire up quick actions
  initQuickActions();

  // Wire up connection status listener
  initConnectionStatus();
}

// ---- Tab Title ----
function updateTabTitle(sessions) {
  const list = Object.values(sessions);
  const activeCount = list.filter(s => s.status !== 'ended').length;
  if (activeCount > 0) {
    document.title = `(${activeCount}) Claude Command Center`;
  } else {
    document.title = 'Claude Command Center';
  }
}

// ---- Connection Status Indicator ----
function initConnectionStatus() {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot || !label) return;

  document.addEventListener('ws-status', (e) => {
    if (e.detail === 'connected') {
      dot.className = 'conn-dot connected';
      label.textContent = 'Live';
    } else {
      dot.className = 'conn-dot disconnected';
      label.textContent = 'Disconnected';
    }
  });
}

function updateConnectionStatus() {
  const label = document.getElementById('conn-label');
  if (!label) return;
  if (!wsClient.connected) {
    const remaining = wsClient.getReconnectRemaining();
    if (remaining > 0) {
      label.textContent = `Reconnecting in ${remaining}s...`;
    } else {
      label.textContent = 'Reconnecting...';
    }
  }
}

// ---- Keyboard Shortcuts ----
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Skip if user is typing in an input/textarea
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
      // Only handle Escape in inputs
      if (e.key === 'Escape') {
        e.target.blur();
      }
      return;
    }

    // Don't intercept when modifiers are held (Ctrl, Meta, Alt)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case '/': {
        e.preventDefault();
        const searchInput = document.getElementById('live-search');
        if (searchInput) searchInput.focus();
        break;
      }
      case 'Escape': {
        // Close in priority order: shortcuts modal, kill modal, alert modal, settings modal, detail panel
        const shortcuts = document.getElementById('shortcuts-modal');
        const kill = document.getElementById('kill-modal');
        const alert = document.getElementById('alert-modal');
        const settings = document.getElementById('settings-modal');
        const detail = document.getElementById('session-detail-overlay');

        if (shortcuts && !shortcuts.classList.contains('hidden')) {
          shortcuts.classList.add('hidden');
        } else if (kill && !kill.classList.contains('hidden')) {
          kill.classList.add('hidden');
        } else if (alert && !alert.classList.contains('hidden')) {
          alert.classList.add('hidden');
        } else if (settings && !settings.classList.contains('hidden')) {
          settings.classList.add('hidden');
        } else if (detail && !detail.classList.contains('hidden')) {
          deselectSession();
        }
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
      case 'e':
      case 'E': {
        if (getSelectedSessionId()) {
          document.getElementById('ctrl-export')?.click();
        }
        break;
      }
      case 'n':
      case 'N': {
        if (getSelectedSessionId()) {
          document.getElementById('ctrl-notes')?.click();
        }
        break;
      }
      case '?': {
        e.preventDefault();
        const shortcutsModal = document.getElementById('shortcuts-modal');
        if (shortcutsModal) shortcutsModal.classList.toggle('hidden');
        break;
      }
    }
  });

  // Shortcuts modal close button
  const shortcutsClose = document.getElementById('shortcuts-close');
  if (shortcutsClose) {
    shortcutsClose.addEventListener('click', () => {
      document.getElementById('shortcuts-modal').classList.add('hidden');
    });
  }

  // Close shortcuts modal on backdrop click
  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal) {
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) shortcutsModal.classList.add('hidden');
    });
  }
}

// ---- Quick Actions ----
function initQuickActions() {
  const refreshBtn = document.getElementById('qa-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => window.location.reload());
  }

  const archiveBtn = document.getElementById('qa-archive-ended');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => archiveAllEnded());
  }

  const shortcutsBtn = document.getElementById('qa-shortcuts');
  if (shortcutsBtn) {
    shortcutsBtn.addEventListener('click', () => {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) modal.classList.remove('hidden');
    });
  }
}

function toggleEmptyState(show) {
  document.getElementById('empty-state').classList.toggle('hidden', !show);
  document.getElementById('sessions-grid').classList.toggle('hidden', show);
}

function addActivityEntry(session) {
  const feed = document.getElementById('feed-entries');
  const lastEvent = session.events[session.events.length - 1];
  if (!lastEvent) return;

  const time = new Date(lastEvent.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = `<span class="feed-time">${time}</span> ` +
    `<span class="feed-project">[${session.projectName}]</span> ` +
    `<span class="feed-detail">${lastEvent.type}: ${lastEvent.detail}</span>`;
  feed.appendChild(entry);

  // Keep last 100
  while (feed.children.length > 100) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

init().catch(console.error);
