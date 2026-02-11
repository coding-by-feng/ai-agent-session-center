import * as robotManager from './robotManager.js';
import { createOrUpdateCard, removeCard, updateDurations, showToast, getSelectedSessionId, deselectSession, archiveAllEnded, isMuted, toggleMuteAll, initGroups, createOrUpdateTeamCard, removeTeamCard, getTeamsData, getSessionsData } from './sessionPanel.js';
import * as statsPanel from './statsPanel.js';
import * as wsClient from './wsClient.js';
import * as navController from './navController.js';
import * as historyPanel from './historyPanel.js';
import * as timelinePanel from './timelinePanel.js';
import * as analyticsPanel from './analyticsPanel.js';
import * as settingsManager from './settingsManager.js';
import * as soundManager from './soundManager.js';
import * as movementManager from './movementManager.js';

let allSessions = {};
const approvalAlarmTimers = new Map(); // sessionId -> intervalId for repeating alarm

async function init() {
  // Load settings first
  await settingsManager.loadSettings();
  settingsManager.initSettingsUI();
  soundManager.init();
  movementManager.init();

  // Connect WebSocket
  wsClient.connect({
    onSnapshotCb(sessions, teams) {
      allSessions = sessions;
      for (const session of Object.values(sessions)) {
        createOrUpdateCard(session);
        robotManager.updateRobot(session);
      }
      // Process teams from snapshot
      if (teams) {
        for (const team of Object.values(teams)) {
          createOrUpdateTeamCard(team);
        }
      }
      statsPanel.update(sessions);
      updateTabTitle(sessions);
      toggleEmptyState(Object.keys(sessions).length === 0);
    },
    onSessionUpdateCb(session, team) {
      allSessions[session.sessionId] = session;
      createOrUpdateCard(session);
      robotManager.updateRobot(session);
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);

      // If session belongs to a team, refresh the team card
      if (team) {
        createOrUpdateTeamCard(team);
      } else if (session.teamId) {
        const existingTeam = getTeamsData().get(session.teamId);
        if (existingTeam) createOrUpdateTeamCard(existingTeam);
      }

      const lastEvt = session.events[session.events.length - 1];
      if (lastEvt && !isMuted(session.sessionId)) {
        switch (lastEvt.type) {
          case 'SessionStart':
            soundManager.play('sessionStart');
            movementManager.trigger('sessionStart', session.sessionId);
            break;
          case 'UserPromptSubmit':
            soundManager.play('promptSubmit');
            movementManager.trigger('promptSubmit', session.sessionId);
            break;
          case 'PreToolUse': {
            const toolMap = {
              Read: 'toolRead', Write: 'toolWrite', Edit: 'toolEdit',
              Bash: 'toolBash', Grep: 'toolGrep', Glob: 'toolGlob',
              WebFetch: 'toolWebFetch', Task: 'toolTask'
            };
            const toolName = lastEvt.tool_name || '';
            const action = toolMap[toolName] || 'toolOther';
            soundManager.play(action);
            movementManager.trigger(action, session.sessionId);
            break;
          }
          case 'Stop':
            soundManager.play('taskComplete');
            movementManager.trigger('taskComplete', session.sessionId);
            break;
          case 'SessionEnd':
            soundManager.play('sessionEnd');
            movementManager.trigger('sessionEnd', session.sessionId);
            break;
        }
      }

      // Approval alarm: play urgent sound when session enters approval state (repeats every 10s)
      if (session.status === 'approval' && !isMuted(session.sessionId)) {
        if (!approvalAlarmTimers.has(session.sessionId)) {
          soundManager.play('approvalNeeded');
          movementManager.trigger('approvalNeeded', session.sessionId);
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
        clearInterval(approvalAlarmTimers.get(session.sessionId));
        approvalAlarmTimers.delete(session.sessionId);
      }

      // Input notification: play a softer sound once when Claude is asking a question (no repeat)
      if (session.status === 'input' && !isMuted(session.sessionId)) {
        if (!approvalAlarmTimers.has('input-' + session.sessionId)) {
          soundManager.play('inputNeeded');
          approvalAlarmTimers.set('input-' + session.sessionId, true);
        }
      } else if (session.status !== 'input' && approvalAlarmTimers.has('input-' + session.sessionId)) {
        approvalAlarmTimers.delete('input-' + session.sessionId);
      }

      addActivityEntry(session);
      toggleEmptyState(Object.keys(allSessions).length === 0);

      if (session.status === 'ended') {
        // Auto-remove ended sessions after a brief delay with fade-out
        setTimeout(() => {
          removeCard(session.sessionId, true);
          robotManager.removeRobot(session.sessionId);
          delete allSessions[session.sessionId];
          statsPanel.update(allSessions);
          updateTabTitle(allSessions);
          toggleEmptyState(Object.keys(allSessions).length === 0);
        }, 2000);
      }
    },
    onTeamUpdateCb(team) {
      if (team) {
        createOrUpdateTeamCard(team);
        // Check if all members ended — remove team card
        const allIds = [team.parentSessionId, ...(team.childSessionIds || [])];
        const allEnded = allIds.every(sid => {
          const s = allSessions[sid];
          return !s || s.status === 'ended';
        });
        if (allEnded) {
          setTimeout(() => removeTeamCard(team.teamId), 3000);
        }
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

  // Initialize session groups (localStorage-based, drag-and-drop)
  initGroups();

  // Initialize history panel (populate project filter, wire event listeners)
  historyPanel.init();

  // Wire view switching callbacks
  navController.onViewChange('history', () => historyPanel.refresh());
  navController.onViewChange('timeline', () => timelinePanel.refresh());
  navController.onViewChange('analytics', () => analyticsPanel.refresh());

  // Handle card dismiss — remove robot too
  document.addEventListener('card-dismissed', (e) => {
    const sid = e.detail.sessionId;
    robotManager.removeRobot(sid);
    delete allSessions[sid];
    statsPanel.update(allSessions);
    updateTabTitle(allSessions);
    toggleEmptyState(Object.keys(allSessions).length === 0);
  });

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
    document.title = `(${activeCount}) Claude Session Center`;
  } else {
    document.title = 'Claude Session Center';
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
      label.textContent = 'Connected';
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
        // Close in priority order: kill, alert, summarize, team, settings, detail
        const kill = document.getElementById('kill-modal');
        const alert = document.getElementById('alert-modal');
        const summarizeModal = document.getElementById('summarize-modal');
        const teamModal = document.getElementById('team-modal');
        const settings = document.getElementById('settings-modal');
        const detail = document.getElementById('session-detail-overlay');

        if (kill && !kill.classList.contains('hidden')) {
          kill.classList.add('hidden');
        } else if (alert && !alert.classList.contains('hidden')) {
          alert.classList.add('hidden');
        } else if (summarizeModal && !summarizeModal.classList.contains('hidden')) {
          summarizeModal.classList.add('hidden');
        } else if (teamModal && !teamModal.classList.contains('hidden')) {
          teamModal.classList.add('hidden');
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
      case 'm':
      case 'M': {
        document.getElementById('qa-mute-all')?.click();
        break;
      }
    }
  });

}

// ---- Quick Actions (in nav bar) ----
function initQuickActions() {
  const muteAllBtn = document.getElementById('qa-mute-all');
  if (muteAllBtn) {
    muteAllBtn.addEventListener('click', () => {
      const muted = toggleMuteAll();
      muteAllBtn.innerHTML = muted ? '&#9835; UNMUTE ALL' : '&#9835; MUTE ALL';
      muteAllBtn.title = muted ? 'Unmute all sessions' : 'Mute all sessions';
      muteAllBtn.classList.toggle('active', muted);
    });
  }

  const archiveBtn = document.getElementById('qa-archive-ended');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => archiveAllEnded());
  }

  // Nav actions collapse/expand toggle
  const navActionsToggle = document.getElementById('nav-actions-toggle');
  const navActions = document.getElementById('nav-actions');
  if (navActionsToggle && navActions) {
    navActionsToggle.addEventListener('click', () => {
      navActions.classList.toggle('collapsed');
    });
  }

  // Activity feed collapse/expand toggle
  const feedCollapseBtn = document.getElementById('feed-collapse-btn');
  const feedEl = document.getElementById('activity-feed');
  if (feedCollapseBtn && feedEl) {
    feedCollapseBtn.addEventListener('click', () => {
      feedEl.classList.toggle('collapsed');
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
  // Team role prefix
  let rolePrefix = '';
  if (session.teamRole === 'leader') {
    rolePrefix = '<span class="feed-role">[Leader]</span>';
  } else if (session.teamRole === 'member' && session.agentType) {
    rolePrefix = `<span class="feed-role">[${session.agentType}]</span>`;
  }
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = `<span class="feed-time">${time}</span> ` +
    `<span class="feed-project">[${session.projectName}]</span> ` +
    `${rolePrefix}` +
    `<span class="feed-detail">${lastEvent.type}: ${lastEvent.detail}</span>`;
  feed.appendChild(entry);

  // Keep last 100
  while (feed.children.length > 100) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

init().catch(console.error);
