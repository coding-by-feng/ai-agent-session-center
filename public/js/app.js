import * as robotManager from './robotManager.js';
import { createOrUpdateCard, removeCard, updateDurations, showToast, getSelectedSessionId, setSelectedSessionId, deselectSession, archiveAllEnded, isMuted, toggleMuteAll, initGroups, createOrUpdateTeamCard, removeTeamCard, getTeamsData, getSessionsData, loadQueue } from './sessionPanel.js';
import * as statsPanel from './statsPanel.js';
import * as wsClient from './wsClient.js';
import * as navController from './navController.js';
import * as historyPanel from './historyPanel.js';
import * as timelinePanel from './timelinePanel.js';
import * as analyticsPanel from './analyticsPanel.js';
import * as settingsManager from './settingsManager.js';
import * as soundManager from './soundManager.js';
import * as movementManager from './movementManager.js';
import * as terminalManager from './terminalManager.js';
import { openDB, persistSessionUpdate, put, del, getAll } from './browserDb.js';

let allSessions = {};
const approvalAlarmTimers = new Map(); // sessionId -> intervalId for repeating alarm

// Block accidental refresh/close when terminal sessions are active
window.addEventListener('beforeunload', (e) => {
  if (terminalManager.getActiveTerminalId()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Block refresh keyboard shortcuts (Cmd+R, Ctrl+R, F5) entirely
window.addEventListener('keydown', (e) => {
  const isRefresh =
    e.key === 'F5' ||
    ((e.metaKey || e.ctrlKey) && e.key === 'r');
  if (isRefresh) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

async function init() {
  // Initialize browser IndexedDB (persistence layer)
  await openDB();

  // Load settings first
  await settingsManager.loadSettings();
  settingsManager.initSettingsUI();
  soundManager.init();
  movementManager.init();

  // Load cached sessions from IndexedDB for instant display (before WS connects)
  try {
    const cachedSessions = await getAll('sessions');
    // Only restore non-ended sessions as live cards; ended ones live in history only
    const liveSessions = (cachedSessions || []).filter(s => s.status && s.status !== 'ended');
    if (liveSessions.length > 0) {
      for (const cached of liveSessions) {
        // Convert IndexedDB record to session-like object for createOrUpdateCard
        const session = {
          sessionId: cached.id,
          projectPath: cached.projectPath,
          projectName: cached.projectName || 'Unknown',
          title: cached.title || '',
          status: cached.status || 'ended',
          model: cached.model || '',
          source: cached.source || 'ssh',
          startedAt: cached.startedAt,
          lastActivityAt: cached.lastActivityAt,
          endedAt: cached.endedAt,
          totalToolCalls: cached.totalToolCalls || 0,
          totalPrompts: cached.totalPrompts || 0,
          archived: cached.archived || 0,
          characterModel: cached.characterModel,
          accentColor: cached.accentColor,
          teamId: cached.teamId,
          terminalId: cached.terminalId,
          queueCount: cached.queueCount || 0,
          // Historical sessions have no live data
          promptHistory: [],
          toolUsage: {},
          toolLog: [],
          responseLog: [],
          events: [],
          subagentCount: 0,
          animationState: cached.status === 'ended' ? 'Death' : 'Idle',
          isHistorical: true,
        };
        allSessions[session.sessionId] = session;
        createOrUpdateCard(session);
        robotManager.updateRobot(session);
      }
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      toggleEmptyState(Object.keys(allSessions).length === 0);
    }
  } catch (e) {
    console.warn('[app] Failed to load cached sessions:', e);
  }

  // Connect WebSocket
  // Pass WS reference to terminal manager once connected
  document.addEventListener('ws-status', (e) => {
    if (e.detail === 'connected') {
      terminalManager.setWs(wsClient.getWs());
    }
  });

  wsClient.connect({
    onTerminalOutputCb(terminalId, data) {
      terminalManager.onTerminalOutput(terminalId, data);
    },
    onTerminalReadyCb(terminalId) {
      terminalManager.onTerminalReady(terminalId);
    },
    onTerminalClosedCb(terminalId, reason) {
      terminalManager.onTerminalClosed(terminalId, reason);
    },
    onSnapshotCb(sessions, teams) {
      // Merge live sessions into allSessions (preserves cached/historical sessions)
      for (const [id, session] of Object.entries(sessions)) {
        allSessions[id] = session;
      }
      for (const session of Object.values(sessions)) {
        createOrUpdateCard(session);
        robotManager.updateRobot(session);
        // Persist to IndexedDB (fire-and-forget)
        persistSessionUpdate(session).catch(() => {});
      }
      // Process teams from snapshot
      if (teams) {
        for (const team of Object.values(teams)) {
          createOrUpdateTeamCard(team);
          put('teams', team).catch(() => {});
        }
      }
      statsPanel.update(sessions);
      updateTabTitle(sessions);
      toggleEmptyState(Object.keys(sessions).length === 0);
    },
    onSessionUpdateCb(session, team) {
      // Handle re-keyed terminal sessions (pre-session → real Claude session)
      if (session.replacesId) {
        const wasSelected = getSelectedSessionId() === session.replacesId;
        // Transfer selection BEFORE removing old card so deselectSession() doesn't fire
        if (wasSelected) setSelectedSessionId(session.sessionId);
        delete allSessions[session.replacesId];
        removeCard(session.replacesId);
        robotManager.removeRobot(session.replacesId);
      }
      allSessions[session.sessionId] = session;
      createOrUpdateCard(session);
      robotManager.updateRobot(session);
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      // Persist to IndexedDB (fire-and-forget)
      persistSessionUpdate(session).catch(() => {});

      // Auto-refresh queue panel if this session's detail panel is open on the terminal tab
      if (session.sessionId === getSelectedSessionId()) {
        const activeTab = document.querySelector('.detail-tabs .tab.active');
        if (activeTab && activeTab.dataset.tab === 'terminal') {
          loadQueue(session.sessionId);
        }
      }

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

      // SSH sessions persist as disconnected cards — don't auto-remove
      // Non-SSH sessions auto-remove after a brief delay
      if (session.status === 'ended' && session.source !== 'ssh') {
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
    onSessionRemovedCb(sessionId) {
      // Permanent deletion — remove card, robot, and IndexedDB cache
      removeCard(sessionId, true);
      robotManager.removeRobot(sessionId);
      delete allSessions[sessionId];
      // Remove from IndexedDB
      del('sessions', sessionId).catch(() => {});
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      toggleEmptyState(Object.keys(allSessions).length === 0);
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
    onHookStatsCb(stats) {
      statsPanel.updateHookStats(stats);
    },
    onDurationAlertCb(data) {
      showToast('DURATION ALERT', `Session "${data.projectName}" exceeded ${Math.round(data.thresholdMs / 60000)} min (running: ${Math.round(data.elapsedMs / 60000)} min)`);
    }
  });

  // Duration timer
  setInterval(() => {
    updateDurations();
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

  // Handle card dismiss — clean runtime state, preserve IndexedDB for history
  document.addEventListener('card-dismissed', (e) => {
    const sid = e.detail.sessionId;
    robotManager.removeRobot(sid);
    // Clear approval/input alarm timers
    if (approvalAlarmTimers.has(sid)) {
      clearInterval(approvalAlarmTimers.get(sid));
      approvalAlarmTimers.delete(sid);
    }
    approvalAlarmTimers.delete('input-' + sid);
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

  // Wire up shortcuts panel
  initShortcutsPanel();

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

// ---- Keyboard Shortcuts ----
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd+Enter (Mac) / Ctrl+Enter (Win/Linux) / Alt+Enter → open New Session modal (works even in terminal)
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.altKey)) {
      e.preventDefault();
      const modal = document.getElementById('new-session-modal');
      if (modal) {
        modal.classList.remove('hidden');
        loadSshKeysOnInit().then(restoreLastSession);
      }
      return;
    }

    // Skip if user is typing in an input/textarea
    const tag = e.target.tagName;
    // Never intercept xterm terminal keypresses (xterm uses a hidden textarea)
    if (e.target.classList.contains('xterm-helper-textarea')) return;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
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
        // Close in priority order: kill, alert, summarize, team, shortcuts, settings, detail
        const kill = document.getElementById('kill-modal');
        const alert = document.getElementById('alert-modal');
        const summarizeModal = document.getElementById('summarize-modal');
        const teamModal = document.getElementById('team-modal');
        const newSessionModal = document.getElementById('new-session-modal');
        const shortcutsModal = document.getElementById('shortcuts-modal');
        const settings = document.getElementById('settings-modal');
        const detail = document.getElementById('session-detail-overlay');

        if (kill && !kill.classList.contains('hidden')) {
          kill.classList.add('hidden');
        } else if (alert && !alert.classList.contains('hidden')) {
          alert.classList.add('hidden');
        } else if (summarizeModal && !summarizeModal.classList.contains('hidden')) {
          summarizeModal.classList.add('hidden');
        } else if (newSessionModal && !newSessionModal.classList.contains('hidden')) {
          newSessionModal.classList.add('hidden');
        } else if (teamModal && !teamModal.classList.contains('hidden')) {
          teamModal.classList.add('hidden');
        } else if (shortcutsModal && !shortcutsModal.classList.contains('hidden')) {
          shortcutsModal.classList.add('hidden');
        } else if (settings && !settings.classList.contains('hidden')) {
          settings.classList.add('hidden');
        } else if (detail && !detail.classList.contains('hidden')) {
          deselectSession();
        }
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
      case 't':
      case 'T': {
        if (getSelectedSessionId()) {
          document.getElementById('ctrl-terminal')?.click();
        } else {
          // No session selected — open New Session modal
          document.getElementById('new-session-modal')?.classList.remove('hidden');
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

  // + NEW SESSION button
  const newSessionBtn = document.getElementById('qa-new-session');
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', () => {
      const modal = document.getElementById('new-session-modal');
      modal.classList.remove('hidden');
      loadSshKeysOnInit().then(restoreLastSession);
    });
  }

  // New Session modal buttons
  initNewSessionModal();

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

// ---- Keyboard Shortcuts Panel ----
function initShortcutsPanel() {
  const btn = document.getElementById('shortcuts-btn');
  const modal = document.getElementById('shortcuts-modal');
  const closeBtn = document.getElementById('shortcuts-close');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => modal.classList.toggle('hidden'));
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
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

// ---- New Session Modal ----
async function loadSshKeysOnInit() {
  loadSshKeys();
}

async function loadSshKeys() {
  try {
    const resp = await fetch('/api/ssh-keys');
    const { keys } = await resp.json();
    const select = document.getElementById('ssh-key-select');
    select.innerHTML = '';
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k.path;
      opt.textContent = k.name;
      select.appendChild(opt);
    }
    if (keys.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No keys found in ~/.ssh/';
      select.appendChild(opt);
    }
  } catch (e) {
    console.error('[app] Failed to load SSH keys:', e);
  }
}

function restoreLastSession() {
  try {
    const saved = localStorage.getItem('lastSession');
    if (!saved) return;
    const s = JSON.parse(saved);

    // Restore individual fields
    if (s.host) document.getElementById('ssh-host').value = s.host;
    if (s.port) document.getElementById('ssh-port').value = s.port;
    if (s.username) document.getElementById('ssh-username').value = s.username;
    if (s.authMethod) {
      document.getElementById('ssh-auth-method').value = s.authMethod;
      document.getElementById('ssh-auth-method').dispatchEvent(new Event('change'));
    }
    if (s.privateKeyPath) {
      const keySelect = document.getElementById('ssh-key-select');
      for (const opt of keySelect.options) {
        if (opt.value === s.privateKeyPath) { keySelect.value = s.privateKeyPath; break; }
      }
    }
    if (s.workingDir) document.getElementById('ssh-workdir').value = s.workingDir;
    if (s.command) {
      const presetSelect = document.getElementById('ssh-command-preset');
      let matched = false;
      for (const opt of presetSelect.options) {
        if (opt.value === s.command) { presetSelect.value = s.command; matched = true; break; }
      }
      if (!matched) {
        presetSelect.value = 'custom';
        document.getElementById('ssh-custom-command').value = s.command;
        document.getElementById('ssh-custom-command').classList.remove('hidden');
      }
      presetSelect.dispatchEvent(new Event('change'));
    }
    if (s.terminalTheme) {
      const themeSelect = document.getElementById('ssh-terminal-theme');
      if (themeSelect) themeSelect.value = s.terminalTheme;
    }
  } catch (e) {
    console.warn('[app] Failed to restore last session:', e);
  }
}

function initNewSessionModal() {
  const modal = document.getElementById('new-session-modal');
  if (!modal) return;

  // Close buttons
  document.getElementById('new-session-close')?.addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('ssh-cancel')?.addEventListener('click', () => modal.classList.add('hidden'));

  // Auth method toggle
  document.getElementById('ssh-auth-method')?.addEventListener('change', (e) => {
    const val = e.target.value;
    document.getElementById('ssh-password-row').classList.toggle('hidden', val !== 'password');
    document.getElementById('ssh-key-row').classList.toggle('hidden', val !== 'key');
  });

  // Command preset toggle
  document.getElementById('ssh-command-preset')?.addEventListener('change', (e) => {
    document.getElementById('ssh-custom-row').classList.toggle('hidden', e.target.value !== 'custom');
  });

  // Session mode toggle (New / Attach tmux / Wrap in tmux)
  let selectedTmuxSession = null;
  let currentSshMode = 'new';
  document.querySelectorAll('.ssh-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ssh-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSshMode = btn.dataset.mode;
      const tmuxRow = document.getElementById('ssh-tmux-row');
      tmuxRow.classList.toggle('hidden', currentSshMode !== 'tmux-attach');
      selectedTmuxSession = null;
      // Hide command fields when attaching to existing tmux session
      const commandFields = [document.getElementById('ssh-command-preset')?.closest('.ssh-field'), document.getElementById('ssh-custom-row')];
      commandFields.forEach(el => { if (el) el.classList.toggle('hidden', currentSshMode === 'tmux-attach'); });
    });
  });

  // Tmux refresh
  document.getElementById('ssh-tmux-refresh')?.addEventListener('click', () => fetchTmuxSessions());

  async function fetchTmuxSessions() {
    const listEl = document.getElementById('ssh-tmux-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="ssh-tmux-loading">Loading...</div>';
    selectedTmuxSession = null;
    try {
      const body = {
        host: document.getElementById('ssh-host').value,
        port: parseInt(document.getElementById('ssh-port').value) || 22,
        username: document.getElementById('ssh-username').value,
        authMethod: document.getElementById('ssh-auth-method').value,
        password: document.getElementById('ssh-password').value || undefined,
        privateKeyPath: document.getElementById('ssh-key-select').value,
      };
      const resp = await fetch('/api/tmux-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to list tmux sessions');
      if (!data.sessions || data.sessions.length === 0) {
        listEl.innerHTML = '<div class="ssh-tmux-empty">No tmux sessions found</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const s of data.sessions) {
        const item = document.createElement('div');
        item.className = 'ssh-tmux-item';
        item.dataset.name = s.name;
        const age = formatAge(s.created);
        item.innerHTML = `
          <span class="ssh-tmux-name">${escapeHtml(s.name)}</span>
          <span class="ssh-tmux-meta">${s.windows} win${s.windows !== 1 ? 's' : ''} · ${s.attached ? 'attached' : 'detached'} · ${age}</span>
        `;
        item.addEventListener('click', () => {
          listEl.querySelectorAll('.ssh-tmux-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          selectedTmuxSession = s.name;
        });
        listEl.appendChild(item);
      }
    } catch (e) {
      listEl.innerHTML = `<div class="ssh-tmux-empty ssh-tmux-error">${escapeHtml(e.message)}</div>`;
    }
  }

  function formatAge(ts) {
    if (!ts) return '';
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // Connect & Launch
  document.getElementById('ssh-connect')?.addEventListener('click', async () => {
    const connectBtn = document.getElementById('ssh-connect');

    // Validate tmux-attach mode
    if (currentSshMode === 'tmux-attach' && !selectedTmuxSession) {
      showToast('ERROR', 'Select a tmux session to attach');
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'CONNECTING...';
    try {
      const body = {
        host: document.getElementById('ssh-host').value,
        port: parseInt(document.getElementById('ssh-port').value) || 22,
        username: document.getElementById('ssh-username').value,
        authMethod: document.getElementById('ssh-auth-method').value,
        password: document.getElementById('ssh-password').value || undefined,
        privateKeyPath: document.getElementById('ssh-key-select').value,
        workingDir: document.getElementById('ssh-workdir').value,
        command: getSelectedCommand(),
        apiKey: document.getElementById('ssh-api-key')?.value || undefined,
        terminalTheme: document.getElementById('ssh-terminal-theme')?.value || 'default',
        sessionTitle: document.getElementById('ssh-session-title')?.value || undefined,
      };

      // Add tmux params based on mode
      if (currentSshMode === 'tmux-attach') {
        body.tmuxSession = selectedTmuxSession;
      } else if (currentSshMode === 'tmux-wrap') {
        body.useTmux = true;
      }
      const resp = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Connection failed');

      // Save last used settings to localStorage for next time
      try {
        localStorage.setItem('lastSession', JSON.stringify({
          host: body.host,
          port: body.port,
          username: body.username,
          authMethod: body.authMethod,
          privateKeyPath: body.privateKeyPath,
          workingDir: body.workingDir,
          command: getSelectedCommand(),
          terminalTheme: body.terminalTheme,
        }));
      } catch (_) {}

      modal.classList.add('hidden');
      showToast('CONNECTED', `Terminal ${result.terminalId} launched`);

      // Store theme preference for this terminal
      const theme = document.getElementById('ssh-terminal-theme')?.value || 'default';
      terminalManager.setTerminalTheme(result.terminalId, theme);
    } catch (e) {
      showToast('ERROR', e.message);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'CONNECT & LAUNCH';
    }
  });
}

function getSelectedCommand() {
  const preset = document.getElementById('ssh-command-preset').value;
  if (preset === 'custom') {
    return document.getElementById('ssh-custom-command').value || 'claude';
  }
  return preset;
}

init().catch(console.error);
