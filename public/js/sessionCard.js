/**
 * @module sessionCard
 * Creates and updates HTML session cards in the grid. Handles card rendering,
 * status badge updates, click-to-select, drag-and-drop reordering, and team card rendering.
 */
import * as settingsManager from './settingsManager.js';
import * as db from './browserDb.js';
import { escapeHtml, escapeAttr, sanitizeColor, formatDuration, formatTime } from './utils.js';
import { STORAGE_KEYS } from './constants.js';

// Dependencies injected via initDeps()
let _selectSession = null;
let _deselectSession = null;
let _getSelectedSessionId = null;
let _setSelectedSessionId = null;
let _showToast = null;
let _populateDetailPanel = null;
let _findGroupForSession = null;
let _addSessionToGroup = null;
let _removeSessionFromGroup = null;
let _updateGroupCounts = null;
let _updateCardGroupBadge = null;
let _showCardGroupDropdown = null;
let _isMoveModeActive = null;
let _completeQueueMove = null;
let _getLastUsedGroupId = null;
let _assignSessionToGroupAndMove = null;

export function initDeps(deps) {
  _selectSession = deps.selectSession;
  _deselectSession = deps.deselectSession;
  _getSelectedSessionId = deps.getSelectedSessionId;
  _setSelectedSessionId = deps.setSelectedSessionId;
  _showToast = deps.showToast;
  _populateDetailPanel = deps.populateDetailPanel;
  _findGroupForSession = deps.findGroupForSession;
  _addSessionToGroup = deps.addSessionToGroup;
  _removeSessionFromGroup = deps.removeSessionFromGroup;
  _updateGroupCounts = deps.updateGroupCounts;
  _updateCardGroupBadge = deps.updateCardGroupBadge;
  _showCardGroupDropdown = deps.showCardGroupDropdown;
  _isMoveModeActive = deps.isMoveModeActive;
  _completeQueueMove = deps.completeQueueMove;
  _getLastUsedGroupId = deps.getLastUsedGroupId;
  _assignSessionToGroupAndMove = deps.assignSessionToGroupAndMove;
}

// Shared state
const sessionsData = new Map();
const teamsData = new Map();
let selectedSessionId = null;

// Debounce DOM updates: if multiple updates arrive for the same session within 100ms,
// only apply the last one
const pendingCardUpdates = new Map(); // sessionId -> { session, timerId }

export function getSelectedSessionId() { return selectedSessionId; }
export function setSelectedSessionId(id) { selectedSessionId = id; }
export function getSessionsData() { return sessionsData; }
export function getTeamsData() { return teamsData; }

// ---- Pinned Sessions ----
function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEYS.PINNED_SESSIONS) || '[]')); } catch { return new Set(); }
}
function savePinned(pinned) {
  localStorage.setItem(STORAGE_KEYS.PINNED_SESSIONS, JSON.stringify([...pinned]));
}
export const pinnedSessions = loadPinned();

export function reorderPinnedCards() {
  for (const grid of [document.getElementById('sessions-grid'), ...document.querySelectorAll('.group-grid')]) {
    if (!grid) continue;
    const cards = [...grid.querySelectorAll('.session-card')];
    const pinned = cards.filter(c => c.classList.contains('pinned'));
    for (const card of pinned.reverse()) {
      grid.insertBefore(card, grid.firstElementChild);
    }
  }
}

export function pinSession(sessionId) {
  if (pinnedSessions.has(sessionId)) return;
  pinnedSessions.add(sessionId);
  savePinned(pinnedSessions);
  const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
  if (card) {
    card.classList.add('pinned');
    const pinBtn = card.querySelector('.pin-btn');
    if (pinBtn) { pinBtn.classList.add('active'); pinBtn.title = 'Unpin'; }
  }
  reorderPinnedCards();
}

// ---- Muted Sessions ----
function loadMuted() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.MUTED_SESSIONS) || '[]');
    return new Set(saved);
  } catch { return new Set(); }
}
function saveMuted(muted) {
  localStorage.setItem(STORAGE_KEYS.MUTED_SESSIONS, JSON.stringify([...muted]));
}
const mutedSessions = loadMuted();
let globalMuted = false;

export function isMuted(sessionId) { return globalMuted || mutedSessions.has(sessionId); }

export function toggleMuteAll() {
  globalMuted = !globalMuted;
  document.querySelectorAll('.session-card .mute-btn').forEach(btn => {
    if (globalMuted) {
      btn.classList.add('muted');
      btn.innerHTML = 'M';
    } else {
      const card = btn.closest('.session-card');
      const sid = card?.dataset?.sessionId;
      if (sid && mutedSessions.has(sid)) {
        btn.classList.add('muted');
        btn.innerHTML = 'M';
      } else {
        btn.classList.remove('muted');
        btn.innerHTML = '&#9835;';
      }
    }
  });
  return globalMuted;
}

function clearAllDropIndicators() {
  document.querySelectorAll('.session-card.drag-over-left, .session-card.drag-over-right').forEach(c => {
    c.classList.remove('drag-over-left', 'drag-over-right');
  });
  document.querySelectorAll('.group-grid.drag-over').forEach(g => g.classList.remove('drag-over'));
  document.getElementById('sessions-grid')?.classList.remove('drag-over');
}

// ---- Tool Bars ----
function renderToolBars(toolUsage) {
  if (!toolUsage || Object.keys(toolUsage).length === 0) return '';
  const max = Math.max(...Object.values(toolUsage), 1);
  return Object.entries(toolUsage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) =>
      `<div class="tool-bar">
        <span class="tool-name">${escapeHtml(name)}</span>
        <div class="tool-bar-fill" style="width:${(count / max) * 100}%"></div>
        <span class="tool-count">${count}</span>
      </div>`
    ).join('');
}

// ---- Toast ----
const ERROR_TOAST_PATTERN = /error|failed/i;

export function showToast(title, message) {
  // Always show error/failed toasts; skip info toasts when disabled
  const isError = ERROR_TOAST_PATTERN.test(title);
  if (!isError && settingsManager.get('toastEnabled') !== 'true') return;

  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<button class="toast-close">&times;</button><div class="toast-title">${escapeHtml(title)}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
  toast.querySelector('.toast-close').addEventListener('click', () => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  });
  container.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); } }, 5000);
}

// ---- Create/Update Card ----
const CARD_UPDATE_DEBOUNCE_MS = 100;

export function createOrUpdateCard(session) {
  sessionsData.set(session.sessionId, session);

  // If card doesn't exist yet, create immediately (no debounce for initial render)
  const existingCard = document.querySelector(`.session-card[data-session-id="${session.sessionId}"]`);
  if (!existingCard) {
    // Cancel any pending debounced update for this session
    const pending = pendingCardUpdates.get(session.sessionId);
    if (pending) { clearTimeout(pending.timerId); pendingCardUpdates.delete(session.sessionId); }
    _applyCardUpdate(session);
    return;
  }

  // Debounce subsequent updates
  const existing = pendingCardUpdates.get(session.sessionId);
  if (existing) { clearTimeout(existing.timerId); }
  const timerId = setTimeout(() => {
    pendingCardUpdates.delete(session.sessionId);
    _applyCardUpdate(session);
  }, CARD_UPDATE_DEBOUNCE_MS);
  pendingCardUpdates.set(session.sessionId, { session, timerId });
}

function _applyCardUpdate(session) {
  sessionsData.set(session.sessionId, session);

  let card = document.querySelector(`.session-card[data-session-id="${session.sessionId}"]`);
  if (!card) {
    const isDisplayOnly = session.source && session.source !== 'ssh';
    card = document.createElement('div');
    card.className = 'session-card' + (isDisplayOnly ? ' display-only' : '');
    card.dataset.sessionId = session.sessionId;
    card.draggable = !isDisplayOnly;
    card.innerHTML = `
      <button class="close-btn" title="Dismiss card">&times;</button>
      <button class="pin-btn" title="Pin to top">&#9650;</button>
      <button class="summarize-card-btn" title="Summarize & Archive">&#8681;AI</button>
      <button class="mute-btn" title="Mute sounds">&#9835;</button>
      <button class="resume-card-btn hidden" title="Resume Claude">&#9654; RESUME</button>
      <div class="robot-viewport"></div>
      <div class="card-info">
        <div class="card-title" title="Click to rename"></div>
        <div class="card-header">
          <span class="project-name"></span>
          <span class="card-label-badge"></span>
          <span class="card-group-badge" title="Assign group"></span>
          <span class="source-badge"></span>
          <span class="status-badge"></span>
        </div>
        <div class="waiting-banner">NEEDS YOUR INPUT</div>
        <div class="card-prompt"></div>
        <div class="card-stats">
          <span class="duration"></span>
          <span class="tool-count"></span>
          <span class="subagent-count" title="Active subagents"></span>
          <span class="queue-count" title="Queued prompts"></span>
        </div>
        <div class="tool-bars"></div>
      </div>
    `;
    if (!isDisplayOnly) {
      card.addEventListener('click', (e) => {
        if (_isMoveModeActive && _isMoveModeActive()) {
          if (session.sessionId !== selectedSessionId) {
            if (_completeQueueMove) _completeQueueMove(session.sessionId);
          }
          return;
        }
        if (selectedSessionId === session.sessionId) {
          if (_deselectSession) _deselectSession();
        } else {
          if (_selectSession) _selectSession(session.sessionId);
        }
      });
    }

    // Mute button toggle
    card.querySelector('.mute-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = session.sessionId;
      const btn = e.currentTarget;
      if (mutedSessions.has(sid)) {
        mutedSessions.delete(sid);
        btn.classList.remove('muted');
        btn.innerHTML = '&#9835;';
        btn.title = 'Mute sounds';
      } else {
        mutedSessions.add(sid);
        btn.classList.add('muted');
        btn.innerHTML = 'M';
        btn.title = 'Unmute sounds';
      }
      saveMuted(mutedSessions);
    });

    // Close button
    card.querySelector('.close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = session.sessionId;
      const sess = sessionsData.get(sid);
      if (sess && sess.terminalId) {
        fetch(`/api/terminals/${sess.terminalId}`, { method: 'DELETE' }).catch(() => {});
      }
      db.get('sessions', sid).then(record => {
        if (record && record.status !== 'ended') {
          record.status = 'ended';
          record.endedAt = record.endedAt || Date.now();
          db.put('sessions', record);
        }
      }).catch(() => {});
      fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
      mutedSessions.delete(sid);
      saveMuted(mutedSessions);
      pinnedSessions.delete(sid);
      savePinned(pinnedSessions);
      if (_removeSessionFromGroup) _removeSessionFromGroup(sid);
      if (_updateGroupCounts) _updateGroupCounts();
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9)';
      setTimeout(() => {
        removeCard(sid);
        const event = new CustomEvent('card-dismissed', { detail: { sessionId: sid } });
        document.dispatchEvent(event);
      }, 300);
    });

    // Group badge
    card.querySelector('.card-group-badge').addEventListener('click', (e) => {
      e.stopPropagation();
      if (_showCardGroupDropdown) _showCardGroupDropdown(e.currentTarget, session.sessionId);
    });

    // Resume button
    card.querySelector('.resume-card-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = session.sessionId;
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'RESUMING...';
      try {
        const resp = await fetch(`/api/sessions/${sid}/resume`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          showToast('RESUMING', 'Resuming Claude session in terminal');
          if (_selectSession) _selectSession(sid);
          const termTab = document.querySelector('.detail-tabs .tab[data-tab="terminal"]');
          if (termTab) termTab.click();
        } else {
          showToast('RESUME FAILED', data.error || 'Unknown error');
        }
      } catch (err) {
        showToast('RESUME ERROR', err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '\u25B6 RESUME';
      }
    });

    if (!isDisplayOnly) {
      // Pin button
      const pinBtn = card.querySelector('.pin-btn');
      if (pinnedSessions.has(session.sessionId)) {
        card.classList.add('pinned');
        pinBtn.classList.add('active');
        pinBtn.title = 'Unpin';
      }
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = session.sessionId;
        if (pinnedSessions.has(sid)) {
          pinnedSessions.delete(sid);
          card.classList.remove('pinned');
          pinBtn.classList.remove('active');
          pinBtn.title = 'Pin to top';
        } else {
          pinnedSessions.add(sid);
          card.classList.add('pinned');
          pinBtn.classList.add('active');
          pinBtn.title = 'Unpin';
        }
        savePinned(pinnedSessions);
        reorderPinnedCards();
      });

      // Summarize & archive button on card
      card.querySelector('.summarize-card-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        const sid = session.sessionId;
        btn.disabled = true;
        btn.textContent = '...';
        btn.classList.add('loading');
        try {
          const detail = await db.getSessionDetail(sid);
          let context = '';
          if (detail) {
            context += `Project: ${detail.session.projectName || detail.session.projectPath || 'Unknown'}\n`;
            context += `Status: ${detail.session.status}\n`;
            context += `Started: ${new Date(detail.session.startedAt).toISOString()}\n`;
            if (detail.session.endedAt) context += `Ended: ${new Date(detail.session.endedAt).toISOString()}\n`;
            context += `\n--- PROMPTS ---\n`;
            for (const p of detail.prompts) {
              context += `[${new Date(p.timestamp).toISOString()}] ${p.text}\n\n`;
            }
            context += `\n--- TOOL CALLS ---\n`;
            for (const t of detail.tool_calls) {
              context += `[${new Date(t.timestamp).toISOString()}] ${t.toolName}: ${t.toolInputSummary || ''}\n`;
            }
            context += `\n--- RESPONSES ---\n`;
            for (const r of detail.responses) {
              context += `[${new Date(r.timestamp).toISOString()}] ${r.textExcerpt || ''}\n\n`;
            }
          }
          const allPrompts = await db.getAll('summaryPrompts');
          const defaultTmpl = allPrompts.find(p => p.isDefault);
          const promptTemplate = defaultTmpl ? defaultTmpl.prompt : '';

          const resp = await fetch(`/api/sessions/${sid}/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, promptTemplate })
          });
          const data = await resp.json();
          if (data.ok) {
            const s = sessionsData.get(sid);
            if (s) { s.archived = 1; s.summary = data.summary; }
            const dbSession = await db.get('sessions', sid);
            if (dbSession) { dbSession.summary = data.summary; dbSession.archived = 1; await db.put('sessions', dbSession); }
            showToast('SUMMARIZED', 'Session summarized & archived');
            btn.textContent = '\u2713';
            btn.classList.remove('loading');
            btn.classList.add('done');
          } else {
            showToast('SUMMARIZE FAILED', data.error || 'Unknown error');
            btn.textContent = '\u2193AI';
            btn.classList.remove('loading');
            btn.disabled = false;
          }
        } catch(err) {
          showToast('SUMMARIZE ERROR', err.message);
          btn.textContent = '\u2193AI';
          btn.classList.remove('loading');
          btn.disabled = false;
        }
      });
    }

    // Inline rename on click (stop propagation to prevent opening detail panel)
    card.querySelector('.card-title').addEventListener('click', (e) => {
      e.stopPropagation();
      const titleEl = e.currentTarget;
      if (titleEl.contentEditable === 'true') return;
      titleEl.contentEditable = 'true';
      titleEl.classList.add('editing');
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const save = async () => {
        titleEl.contentEditable = 'false';
        titleEl.classList.remove('editing');
        const newTitle = titleEl.textContent.trim();
        if (newTitle) {
          fetch(`/api/sessions/${session.sessionId}/title`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle })
          });
          const s = await db.get('sessions', session.sessionId);
          if (s) { s.title = newTitle; await db.put('sessions', s); }
        }
      };
      titleEl.addEventListener('blur', save, { once: true });
      titleEl.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); titleEl.blur(); }
        if (ke.key === 'Escape') { titleEl.textContent = session.title || ''; titleEl.blur(); }
      });
    });

    // Drag-and-drop reordering
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', session.sessionId);
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      clearAllDropIndicators();
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const dragging = document.querySelector('.session-card.dragging');
      if (!dragging || dragging === card) return;
      const rect = card.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        card.classList.add('drag-over-left');
        card.classList.remove('drag-over-right');
      } else {
        card.classList.add('drag-over-right');
        card.classList.remove('drag-over-left');
      }
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over-left', 'drag-over-right');
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dropLeft = card.classList.contains('drag-over-left');
      card.classList.remove('drag-over-left', 'drag-over-right');
      const draggedId = e.dataTransfer.getData('text/plain');
      const draggedCard = document.querySelector(`.session-card[data-session-id="${draggedId}"]`);
      if (!draggedCard || draggedCard === card) return;
      const parentGrid = card.parentElement;
      if (dropLeft) {
        parentGrid.insertBefore(draggedCard, card);
      } else {
        parentGrid.insertBefore(draggedCard, card.nextSibling);
      }
      const groupEl = parentGrid.closest('.session-group');
      if (groupEl) {
        if (_addSessionToGroup) _addSessionToGroup(groupEl.id, draggedId);
      } else {
        if (_removeSessionFromGroup) _removeSessionFromGroup(draggedId);
      }
      if (_updateGroupCounts) _updateGroupCounts();
      if (pinnedSessions.size > 0) reorderPinnedCards();
    });

    // Place card into its group or ungrouped grid
    const group = _findGroupForSession ? _findGroupForSession(session.sessionId) : null;
    if (group) {
      const groupGrid = document.querySelector(`#${group.id} .group-grid`);
      if (groupGrid) { groupGrid.appendChild(card); if (_updateGroupCounts) _updateGroupCounts(); }
      else document.getElementById('sessions-grid').appendChild(card);
    } else {
      // Auto-assign to last used group for non-historical sessions
      const lastGroupId = _getLastUsedGroupId ? _getLastUsedGroupId() : null;
      if (lastGroupId && !session.isHistorical && _assignSessionToGroupAndMove) {
        document.getElementById('sessions-grid').appendChild(card);
        _assignSessionToGroupAndMove(lastGroupId, session.sessionId);
      } else {
        document.getElementById('sessions-grid').appendChild(card);
      }
    }
    if (pinnedSessions.has(session.sessionId)) {
      reorderPinnedCards();
    }
    document.dispatchEvent(new CustomEvent('session-card-created', {
      detail: { sessionId: session.sessionId }
    }));
  }

  // Update status attribute
  const prevStatus = card.dataset.status;
  card.dataset.status = session.status;
  const activeStatuses = new Set(['working', 'prompting', 'approval', 'input']);
  if (activeStatuses.has(session.status) && prevStatus !== session.status && !card.classList.contains('pinned')) {
    const grid = card.parentElement;
    if (grid) {
      const firstUnpinned = [...grid.children].find(c => !c.classList.contains('pinned'));
      if (firstUnpinned && firstUnpinned !== card) {
        grid.insertBefore(card, firstUnpinned);
      } else if (!firstUnpinned) {
        grid.appendChild(card);
      }
    }
  }
  // Ensure pinned cards always stay at the top after any reorder
  if (pinnedSessions.size > 0) {
    reorderPinnedCards();
  }

  // Update fields
  card.querySelector('.project-name').textContent = session.projectName;
  const cardTitle = card.querySelector('.card-title');
  if (cardTitle && cardTitle.contentEditable !== 'true') {
    cardTitle.textContent = session.title || '';
    cardTitle.style.display = session.title ? '' : 'none';
  }
  const badge = card.querySelector('.status-badge');
  const isDisconnected = session.status === 'ended';
  const statusLabel = isDisconnected ? 'DISCONNECTED'
    : session.status === 'approval' ? 'APPROVAL NEEDED'
    : session.status === 'input' ? 'WAITING FOR INPUT'
    : session.status === 'waiting' ? 'WAITING'
    : session.status.toUpperCase();
  badge.textContent = statusLabel;
  badge.className = `status-badge ${isDisconnected ? 'disconnected' : session.status}`;
  card.classList.toggle('disconnected', isDisconnected);

  const resumeCardBtn = card.querySelector('.resume-card-btn');
  if (resumeCardBtn) {
    const canResume = isDisconnected;
    resumeCardBtn.classList.toggle('hidden', !canResume);
  }

  const labelBadge = card.querySelector('.card-label-badge');
  if (labelBadge) {
    const lbl = session.label || '';
    labelBadge.textContent = lbl;
    labelBadge.style.display = lbl ? '' : 'none';
  }

  if (_updateCardGroupBadge) _updateCardGroupBadge(session.sessionId);

  const isHeavy = (session.label || '').toUpperCase() === 'HEAVY';
  card.classList.toggle('heavy-session', isHeavy);
  const isOneoff = (session.label || '').toUpperCase() === 'ONEOFF';
  card.classList.toggle('oneoff-session', isOneoff);
  const isImportant = (session.label || '').toUpperCase() === 'IMPORTANT';
  card.classList.toggle('important-session', isImportant);

  const labelUpper = (session.label || '').toUpperCase();
  if (labelUpper === 'ONEOFF' || labelUpper === 'HEAVY' || labelUpper === 'IMPORTANT') {
    const labelCfg = settingsManager.getLabelSettings();
    const frameName = labelCfg[labelUpper]?.frame || 'none';
    if (frameName && frameName !== 'none') {
      card.dataset.frame = frameName;
    } else {
      delete card.dataset.frame;
    }
  } else {
    delete card.dataset.frame;
  }

  const sourceBadge = card.querySelector('.source-badge');
  if (sourceBadge) {
    const src = session.source || 'ssh';
    if (src !== 'ssh') {
      const sourceLabels = {
        vscode: 'VS Code', jetbrains: 'JetBrains', iterm: 'iTerm',
        warp: 'Warp', kitty: 'Kitty', ghostty: 'Ghostty',
        alacritty: 'Alacritty', wezterm: 'WezTerm', hyper: 'Hyper',
        terminal: 'Terminal', tmux: 'tmux',
      };
      sourceBadge.textContent = sourceLabels[src] || src;
      sourceBadge.className = `source-badge source-${src}`;
    } else {
      sourceBadge.textContent = '';
      sourceBadge.className = 'source-badge';
    }
  }

  const banner = card.querySelector('.waiting-banner');
  if (banner) {
    banner.textContent = session.waitingDetail
      || (session.status === 'input' ? 'WAITING FOR YOUR ANSWER' : 'NEEDS YOUR APPROVAL');
  }

  const promptArr = session.promptHistory || [];
  const prompt = session.currentPrompt || (promptArr.length > 0 ? promptArr[promptArr.length - 1].text : '');
  card.querySelector('.card-prompt').textContent =
    prompt.length > 120 ? prompt.substring(0, 120) + '...' : prompt;

  const durText = formatDuration(Date.now() - session.startedAt);
  const durCard = card.querySelector('.duration');
  durCard.textContent = durText;
  durCard.style.display = durText ? '' : 'none';
  card.querySelector('.tool-count').textContent = `Tools: ${session.totalToolCalls}`;
  card.querySelector('.subagent-count').textContent =
    session.subagentCount > 0 ? `Agents: ${session.subagentCount}` : '';

  card.querySelector('.tool-bars').innerHTML = renderToolBars(session.toolUsage);

  const queueN = session.queueCount || 0;
  card.classList.toggle('has-queue', queueN > 0);
  card.querySelector('.queue-count').textContent = queueN > 0 ? `Queue: ${queueN}` : '';
  card.classList.toggle('has-terminal', !!session.terminalId);

  // If selected, update the detail panel too
  if (selectedSessionId === session.sessionId && _populateDetailPanel) {
    _populateDetailPanel(session);
  }
}

export function removeCard(sessionId, animate = false) {
  const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
  if (!card) {
    sessionsData.delete(sessionId);
    return;
  }
  if (animate) {
    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    setTimeout(() => {
      card.remove();
      sessionsData.delete(sessionId);
      if (selectedSessionId === sessionId && _deselectSession) _deselectSession();
      if (_updateGroupCounts) _updateGroupCounts();
    }, 500);
  } else {
    card.remove();
    sessionsData.delete(sessionId);
    if (selectedSessionId === sessionId && _deselectSession) _deselectSession();
    if (_updateGroupCounts) _updateGroupCounts();
  }
}

export function updateDurations() {
  for (const [sessionId, session] of sessionsData) {
    const card = document.querySelector(`.session-card[data-session-id="${sessionId}"] .duration`);
    if (card) {
      card.textContent = formatDuration(Date.now() - session.startedAt);
    }
  }
  if (selectedSessionId) {
    const session = sessionsData.get(selectedSessionId);
    if (session) {
      const el = document.getElementById('detail-duration');
      if (el) el.textContent = formatDuration(Date.now() - session.startedAt);
    }
  }
}

// ---- Archive All Ended Sessions ----
export async function archiveAllEnded() {
  let count = 0;
  for (const [sessionId, session] of sessionsData) {
    if (session.status === 'ended' && !session.archived) {
      try {
        session.archived = 1;
        const s = await db.get('sessions', sessionId);
        if (s) { s.archived = 1; await db.put('sessions', s); }
        count++;
      } catch(e) { /* continue */ }
    }
  }
  if (count > 0) {
    showToast('ARCHIVED', `Archived ${count} ended session${count > 1 ? 's' : ''}`);
  } else {
    showToast('ARCHIVE', 'No ended sessions to archive');
  }
}

// ---- Team Data (kept for team context) ----

export function updateTeamData(team) {
  if (!team || !team.teamId) return;
  teamsData.set(team.teamId, team);
}
