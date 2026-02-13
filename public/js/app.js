import * as robotManager from './robotManager.js';
import { createOrUpdateCard, removeCard, updateDurations, showToast, getSelectedSessionId, setSelectedSessionId, deselectSession, archiveAllEnded, isMuted, toggleMuteAll, initGroups, createOrUpdateTeamCard, removeTeamCard, getTeamsData, getSessionsData, loadQueue, tryAutoSend, pinSession, isMoveModeActive, exitQueueMoveMode, renderQueueView, initQueueView } from './sessionPanel.js';
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
import { openDB, persistSessionUpdate, put, del, getAll, clear, getQueue } from './browserDb.js';
import { escapeHtml as utilEscapeHtml, debugLog, debugWarn } from './utils.js';
import { initKeyboardShortcuts } from './keyboardShortcuts.js';
import { initQuickActions, initShortcutsPanel } from './quickActions.js';
import { handleEventSounds, checkAlarms, handleLabelAlerts, clearAlarm } from './alarmManager.js';
import * as agendaManager from './agendaManager.js';

let allSessions = {};

// Sync all queue counts from IndexedDB to server after WS snapshot
async function syncAllQueueCounts(sessionIds) {
  const ws = wsClient.getWs();
  if (!ws || ws.readyState !== 1) return;
  for (const sid of sessionIds) {
    try {
      const items = await getQueue(sid);
      if (items.length > 0) {
        ws.send(JSON.stringify({ type: 'update_queue_count', sessionId: sid, count: items.length }));
      }
    } catch {}
  }
}

// Block all page refresh: keyboard shortcuts (F5, Cmd+R, Ctrl+R) and pull-to-refresh
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || (e.key === 'r' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

document.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    window._pullToRefreshStartY = e.touches[0].clientY;
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (window._pullToRefreshStartY !== undefined) {
    const y = e.touches[0].clientY;
    const scrollTop = document.scrollingElement.scrollTop;
    if (scrollTop <= 0 && y > window._pullToRefreshStartY) {
      e.preventDefault();
    }
  }
}, { passive: false });

document.addEventListener('touchend', () => {
  window._pullToRefreshStartY = undefined;
}, { passive: true });

// Block accidental close when there are active sessions or terminals
window.addEventListener('beforeunload', (e) => {
  const hasActiveSessions = Object.values(allSessions).some(s => s.status && s.status !== 'ended');
  const hasActiveTerminal = terminalManager.getActiveTerminalId();
  if (hasActiveSessions || hasActiveTerminal) {
    e.preventDefault();
    e.returnValue = '';
  }
});


async function init() {
  await openDB();

  await settingsManager.loadSettings();
  settingsManager.initSettingsUI();
  soundManager.init();
  movementManager.init();

  // Load cached sessions from IndexedDB for instant display
  try {
    const cachedSessions = await getAll('sessions');
    const liveSessions = (cachedSessions || []).filter(s => s.status && s.status !== 'ended');
    if (liveSessions.length > 0) {
      for (const cached of liveSessions) {
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
          teamRole: cached.teamRole,
          agentName: cached.agentName,
          agentType: cached.agentType,
          backendType: cached.backendType,
          terminalId: cached.terminalId,
          queueCount: cached.queueCount || 0,
          label: cached.label || null,
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
    debugWarn('[app] Failed to load cached sessions:', e);
  }

  // Connect WebSocket
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
      const serverIds = new Set(Object.keys(sessions));
      for (const cachedId of Object.keys(allSessions)) {
        if (!serverIds.has(cachedId)) {
          removeCard(cachedId);
          robotManager.removeRobot(cachedId);
          del('sessions', cachedId).catch(() => {});
          delete allSessions[cachedId];
        }
      }
      for (const [id, session] of Object.entries(sessions)) {
        allSessions[id] = session;
      }
      for (const session of Object.values(sessions)) {
        createOrUpdateCard(session);
        robotManager.updateRobot(session);
        persistSessionUpdate(session).catch(() => {});
      }
      if (teams) {
        for (const team of Object.values(teams)) {
          createOrUpdateTeamCard(team);
          put('teams', team).catch(() => {});
        }
      }
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      toggleEmptyState(Object.keys(allSessions).length === 0);
      syncAllQueueCounts(Object.keys(sessions));
    },
    onSessionUpdateCb(session, team) {
      if (session.replacesId) {
        const wasSelected = getSelectedSessionId() === session.replacesId;
        if (wasSelected) setSelectedSessionId(session.sessionId);
        delete allSessions[session.replacesId];
        removeCard(session.replacesId);
        robotManager.removeRobot(session.replacesId);
        del('sessions', session.replacesId).catch(() => {});
      }
      const prevSession = allSessions[session.sessionId];
      const prevStatus = prevSession ? prevSession.status : null;
      allSessions[session.sessionId] = session;
      createOrUpdateCard(session);
      robotManager.updateRobot(session);
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      persistSessionUpdate(session).catch(() => {});

      if (session.sessionId === getSelectedSessionId()) {
        const activeTab = document.querySelector('.detail-tabs .tab.active');
        if (activeTab && activeTab.dataset.tab === 'terminal') {
          loadQueue(session.sessionId);
        }
      }

      if (team) {
        createOrUpdateTeamCard(team);
      } else if (session.teamId) {
        const existingTeam = getTeamsData().get(session.teamId);
        if (existingTeam) createOrUpdateTeamCard(existingTeam);
      }

      // Event sounds and movement triggers
      handleEventSounds(session);

      // Approval/input alarms
      checkAlarms(session, allSessions);

      // Auto-send first queued prompt when session transitions TO waiting
      if (session.status === 'waiting' && prevStatus && prevStatus !== 'waiting' && session.terminalId) {
        tryAutoSend(session.sessionId, session.terminalId);
      }

      addActivityEntry(session);
      toggleEmptyState(Object.keys(allSessions).length === 0);

      // Label completion alerts
      handleLabelAlerts(session, allSessions, robotManager, removeCard, statsPanel, updateTabTitle, toggleEmptyState);

      // SSH sessions persist as disconnected cards; non-SSH auto-remove
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
      removeCard(sessionId, true);
      robotManager.removeRobot(sessionId);
      delete allSessions[sessionId];
      del('sessions', sessionId).catch(() => {});
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      toggleEmptyState(Object.keys(allSessions).length === 0);
    },
    onTeamUpdateCb(team) {
      if (team) {
        createOrUpdateTeamCard(team);
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
    },
    async onClearBrowserDbCb() {
      for (const id of Object.keys(allSessions)) {
        removeCard(id, true);
        robotManager.removeRobot(id);
      }
      allSessions = {};
      const stores = ['sessions', 'prompts', 'responses', 'toolCalls', 'events', 'notes', 'promptQueue', 'alerts', 'teams'];
      for (const store of stores) {
        await clear(store).catch(() => {});
      }
      statsPanel.update(allSessions);
      updateTabTitle(allSessions);
      toggleEmptyState(true);
      showToast('RESET', 'All browser data cleared');
    }
  });

  // Duration timer
  setInterval(() => {
    updateDurations();
  }, 1000);

  // Initialize navigation
  navController.init();

  // Initialize session groups
  initGroups();


  // Initialize history panel
  historyPanel.init();

  // Wire view switching callbacks
  navController.onViewChange('history', () => historyPanel.refresh());
  navController.onViewChange('timeline', () => timelinePanel.refresh());
  navController.onViewChange('analytics', () => analyticsPanel.refresh());
  navController.onViewChange('queue', () => {
    // Render whichever sub-tab is active
    const activeTab = document.querySelector('.qa-tab.active');
    if (activeTab?.dataset.qaTab === 'agenda') {
      agendaManager.renderAgendaView();
    } else {
      renderQueueView();
    }
  });
  initQueueView();

  // Initialize agenda
  agendaManager.initDeps({ showToast, getSelectedSessionId, getSessionsData });
  agendaManager.initAgenda();

  // Agenda/Queue sub-tab switching
  document.querySelector('.queue-agenda-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.qa-tab');
    if (!tab) return;
    const tabName = tab.dataset.qaTab;
    document.querySelectorAll('.qa-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.qa-tab-content').forEach(tc => {
      tc.classList.toggle('active', tc.id === `qa-tab-${tabName}`);
    });
    if (tabName === 'agenda') {
      agendaManager.renderAgendaView();
    } else {
      renderQueueView();
    }
  });

  // Handle card dismiss
  document.addEventListener('card-dismissed', (e) => {
    const sid = e.detail.sessionId;
    robotManager.removeRobot(sid);
    clearAlarm(sid);
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
    document.title = `(${activeCount}) AI Agent Session Center`;
  } else {
    document.title = 'AI Agent Session Center';
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
  let rolePrefix = '';
  if (session.teamRole === 'leader') {
    rolePrefix = '<span class="feed-role">[Leader]</span>';
  } else if (session.teamRole === 'member' && session.agentType) {
    rolePrefix = `<span class="feed-role">[${utilEscapeHtml(session.agentType)}]</span>`;
  }
  const entry = document.createElement('div');
  entry.className = 'feed-entry';
  entry.innerHTML = `<span class="feed-time">${time}</span> ` +
    `<span class="feed-project">[${utilEscapeHtml(session.projectName)}]</span> ` +
    `${rolePrefix}` +
    `<span class="feed-detail">${utilEscapeHtml(lastEvent.type)}: ${utilEscapeHtml(lastEvent.detail)}</span>`;
  feed.appendChild(entry);

  while (feed.children.length > 100) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

init().catch(console.error);
