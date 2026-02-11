import * as soundManager from './soundManager.js';
import * as settingsManager from './settingsManager.js';
import * as db from './browserDb.js';

// Load muted sessions from localStorage
function loadMuted() {
  try {
    const saved = JSON.parse(localStorage.getItem('muted-sessions') || '[]');
    return new Set(saved);
  } catch { return new Set(); }
}
function saveMuted(muted) {
  localStorage.setItem('muted-sessions', JSON.stringify([...muted]));
}

const mutedSessions = loadMuted();
let globalMuted = false;
export function isMuted(sessionId) { return globalMuted || mutedSessions.has(sessionId); }

export function toggleMuteAll() {
  globalMuted = !globalMuted;
  // Update all per-session mute buttons to reflect global state
  document.querySelectorAll('.session-card .mute-btn').forEach(btn => {
    if (globalMuted) {
      btn.classList.add('muted');
      btn.innerHTML = 'M';
    } else {
      // Restore per-session state
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

// ---- Pinned Sessions (persisted in localStorage) ----
function loadPinned() {
  try { return new Set(JSON.parse(localStorage.getItem('pinned-sessions') || '[]')); } catch { return new Set(); }
}
function savePinned(pinned) {
  localStorage.setItem('pinned-sessions', JSON.stringify([...pinned]));
}
const pinnedSessions = loadPinned();

function reorderPinnedCards() {
  // Move pinned cards to the front of their parent grid
  for (const grid of [document.getElementById('sessions-grid'), ...document.querySelectorAll('.group-grid')]) {
    if (!grid) continue;
    const cards = [...grid.querySelectorAll('.session-card')];
    const pinned = cards.filter(c => c.classList.contains('pinned'));
    for (const card of pinned.reverse()) {
      grid.insertBefore(card, grid.firstElementChild);
    }
  }
}

const sessionsData = new Map(); // sessionId -> session object (for duration updates + detail panel)
const teamsData = new Map();    // teamId -> team object (for team cards)
let selectedSessionId = null;
export function getSelectedSessionId() { return selectedSessionId; }
export function setSelectedSessionId(id) { selectedSessionId = id; }
export function getSessionsData() { return sessionsData; }
export function getTeamsData() { return teamsData; }
export { deselectSession };

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

// ---- Session Groups (persisted in localStorage) ----
// Structure: [{ id, name, sessionIds: [] }, ...]
function loadGroups() {
  try { return JSON.parse(localStorage.getItem('session-groups') || '[]'); } catch { return []; }
}
function saveGroups(groups) {
  localStorage.setItem('session-groups', JSON.stringify(groups));
}
function findGroupForSession(sessionId) {
  return loadGroups().find(g => g.sessionIds.includes(sessionId));
}

export function createGroup(name) {
  const groups = loadGroups();
  const id = 'grp-' + Date.now();
  groups.push({ id, name: name || 'New Group', sessionIds: [] });
  saveGroups(groups);
  renderGroups();
  return id;
}

function renameGroup(groupId, newName) {
  const groups = loadGroups();
  const g = groups.find(g => g.id === groupId);
  if (g) { g.name = newName; saveGroups(groups); }
}

function deleteGroup(groupId) {
  const groups = loadGroups().filter(g => g.id !== groupId);
  saveGroups(groups);
  // Move cards back to ungrouped grid
  const container = document.getElementById(groupId);
  if (container) {
    const grid = document.getElementById('sessions-grid');
    container.querySelectorAll('.session-card').forEach(card => grid.appendChild(card));
    container.remove();
  }
  refreshAllGroupSelects();
}

function addSessionToGroup(groupId, sessionId) {
  const groups = loadGroups();
  // Remove from any existing group first
  for (const g of groups) {
    g.sessionIds = g.sessionIds.filter(id => id !== sessionId);
  }
  const target = groups.find(g => g.id === groupId);
  if (target) target.sessionIds.push(sessionId);
  saveGroups(groups);
}

function removeSessionFromGroup(sessionId) {
  const groups = loadGroups();
  for (const g of groups) {
    g.sessionIds = g.sessionIds.filter(id => id !== sessionId);
  }
  saveGroups(groups);
}

export function renderGroups() {
  const container = document.getElementById('groups-container');
  if (!container) return;
  const groups = loadGroups();
  // Remove stale group elements
  container.querySelectorAll('.session-group').forEach(el => {
    if (!groups.find(g => g.id === el.id)) el.remove();
  });
  for (const group of groups) {
    let groupEl = document.getElementById(group.id);
    if (!groupEl) {
      groupEl = document.createElement('div');
      groupEl.className = 'session-group';
      groupEl.id = group.id;
      groupEl.innerHTML = `
        <div class="group-header">
          <span class="group-collapse" title="Collapse/expand">&#9660;</span>
          <span class="group-name">${group.name}</span>
          <span class="group-count">0</span>
          <button class="group-delete" title="Delete group">&times;</button>
        </div>
        <div class="group-grid"></div>
      `;
      // Collapse/expand
      groupEl.querySelector('.group-collapse').addEventListener('click', () => {
        groupEl.classList.toggle('collapsed');
        groupEl.querySelector('.group-collapse').innerHTML =
          groupEl.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
      });
      // Rename on double-click
      groupEl.querySelector('.group-name').addEventListener('dblclick', (e) => {
        const nameEl = e.currentTarget;
        nameEl.contentEditable = 'true';
        nameEl.classList.add('editing');
        nameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const save = () => {
          nameEl.contentEditable = 'false';
          nameEl.classList.remove('editing');
          const newName = nameEl.textContent.trim();
          if (newName) renameGroup(group.id, newName);
        };
        nameEl.addEventListener('blur', save, { once: true });
        nameEl.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') { ke.preventDefault(); nameEl.blur(); }
          if (ke.key === 'Escape') { nameEl.textContent = group.name; nameEl.blur(); }
        });
      });
      // Delete group
      groupEl.querySelector('.group-delete').addEventListener('click', () => {
        deleteGroup(group.id);
      });
      // Drop zone: group grid accepts card drops (only when not dropped on a specific card)
      const groupGrid = groupEl.querySelector('.group-grid');
      groupGrid.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!e.target.closest('.session-card')) {
          groupGrid.classList.add('drag-over');
        }
      });
      groupGrid.addEventListener('dragleave', (e) => {
        if (!groupGrid.contains(e.relatedTarget)) {
          groupGrid.classList.remove('drag-over');
        }
      });
      groupGrid.addEventListener('drop', (e) => {
        if (e.target.closest('.session-card')) return; // card handles its own drop
        e.preventDefault();
        groupGrid.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        const card = document.querySelector(`.session-card[data-session-id="${draggedId}"]`);
        if (card) {
          groupGrid.appendChild(card);
          addSessionToGroup(group.id, draggedId);
          updateGroupCounts();
        }
      });
      container.appendChild(groupEl);
    }
    // Move cards that belong to this group into it
    const groupGrid = groupEl.querySelector('.group-grid');
    for (const sid of group.sessionIds) {
      const card = document.querySelector(`.session-card[data-session-id="${sid}"]`);
      if (card && card.parentElement !== groupGrid) {
        groupGrid.appendChild(card);
      }
    }
  }
  updateGroupCounts();
  refreshAllGroupSelects();
}

function updateGroupCounts() {
  document.querySelectorAll('.session-group').forEach(groupEl => {
    const count = groupEl.querySelectorAll('.session-card').length;
    const countEl = groupEl.querySelector('.group-count');
    if (countEl) countEl.textContent = count;
  });
}

function refreshAllGroupSelects() {
  // Update the detail panel group select if it exists
  const sel = document.getElementById('detail-group-select');
  if (!sel) return;
  const groups = loadGroups();
  const sid = selectedSessionId;
  const currentGroup = sid ? groups.find(g => g.sessionIds.includes(sid)) : null;
  const currentValue = currentGroup ? currentGroup.id : '';
  sel.innerHTML = '<option value="">No group</option>' +
    groups.map(g => `<option value="${g.id}"${g.id === currentValue ? ' selected' : ''}>${g.name}</option>`).join('');
}

export function initGroups() {
  // Make ungrouped grid a drop zone to pull cards out of groups
  const grid = document.getElementById('sessions-grid');
  grid.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    grid.classList.add('drag-over');
  });
  grid.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('drag-over');
  });
  grid.addEventListener('drop', (e) => {
    // Only handle if dropped on the grid itself, not on a card (card has its own drop)
    if (e.target.closest('.session-card')) return;
    e.preventDefault();
    grid.classList.remove('drag-over');
    const draggedId = e.dataTransfer.getData('text/plain');
    const card = document.querySelector(`.session-card[data-session-id="${draggedId}"]`);
    if (card) {
      grid.appendChild(card);
      removeSessionFromGroup(draggedId);
      updateGroupCounts();
    }
  });

  // Auto-scroll while dragging near edges of the view panel
  const viewPanel = document.getElementById('view-live');
  if (viewPanel) {
    let scrollRaf = null;
    viewPanel.addEventListener('dragover', (e) => {
      const rect = viewPanel.getBoundingClientRect();
      const edgeZone = 60;
      const topDist = e.clientY - rect.top;
      const bottomDist = rect.bottom - e.clientY;
      cancelAnimationFrame(scrollRaf);
      if (topDist < edgeZone) {
        const speed = ((edgeZone - topDist) / edgeZone) * 12;
        scrollRaf = requestAnimationFrame(() => { viewPanel.scrollTop -= speed; });
      } else if (bottomDist < edgeZone) {
        const speed = ((edgeZone - bottomDist) / edgeZone) * 12;
        scrollRaf = requestAnimationFrame(() => { viewPanel.scrollTop += speed; });
      }
    });
    viewPanel.addEventListener('dragend', () => cancelAnimationFrame(scrollRaf));
  }

  // Wire up "New Group" button
  const btn = document.getElementById('qa-new-group');
  if (btn) btn.addEventListener('click', () => createGroup());

  // Render existing groups from localStorage
  renderGroups();
}

// ---- Team Card Functions ----

export function createOrUpdateTeamCard(team) {
  if (!team || !team.teamId) return;
  teamsData.set(team.teamId, team);

  const allMemberIds = [team.parentSessionId, ...team.childSessionIds];

  // Hide individual session cards for team members
  for (const sid of allMemberIds) {
    const card = document.querySelector(`.session-card[data-session-id="${sid}"]`);
    if (card) card.classList.add('in-team');
  }

  let teamCard = document.querySelector(`.team-card[data-team-id="${team.teamId}"]`);
  if (!teamCard) {
    teamCard = document.createElement('div');
    teamCard.className = 'team-card';
    teamCard.dataset.teamId = team.teamId;
    teamCard.innerHTML = `
      <div class="team-card-header">
        <span class="team-icon">&#9733;</span>
        <span class="team-name"></span>
        <span class="team-member-count"></span>
        <span class="status-badge team-status-badge"></span>
      </div>
      <div class="team-characters"></div>
      <div class="team-card-footer">
        <span class="team-duration"></span>
        <span class="team-tools"></span>
      </div>
    `;
    teamCard.addEventListener('click', () => openTeamModal(team.teamId));
    document.getElementById('sessions-grid').prepend(teamCard);
  }

  // Update team card info
  teamCard.querySelector('.team-name').textContent = team.teamName || 'Team';
  teamCard.querySelector('.team-member-count').textContent = `${allMemberIds.length} member${allMemberIds.length !== 1 ? 's' : ''}`;

  // Compute aggregate status (worst wins)
  const statusPriority = { approval: 6, input: 5, working: 4, prompting: 3, waiting: 2, idle: 1, ended: 0 };
  let worstStatus = 'idle';
  let totalTools = 0;
  let earliestStart = Infinity;
  for (const sid of allMemberIds) {
    const s = sessionsData.get(sid);
    if (!s) continue;
    if ((statusPriority[s.status] || 0) > (statusPriority[worstStatus] || 0)) {
      worstStatus = s.status;
    }
    totalTools += s.totalToolCalls || 0;
    if (s.startedAt < earliestStart) earliestStart = s.startedAt;
  }
  teamCard.dataset.status = worstStatus;
  const badge = teamCard.querySelector('.team-status-badge');
  badge.textContent = worstStatus === 'approval' ? 'APPROVAL NEEDED'
    : worstStatus === 'input' ? 'WAITING FOR INPUT'
    : worstStatus.toUpperCase();
  badge.className = `status-badge team-status-badge ${worstStatus}`;
  teamCard.querySelector('.team-duration').textContent = earliestStart < Infinity ? formatDuration(Date.now() - earliestStart) : '';
  teamCard.querySelector('.team-tools').textContent = `Tools: ${totalTools}`;

  // Render mini character previews
  renderTeamCharacters(teamCard, allMemberIds);
}

function renderTeamCharacters(teamCard, sessionIds) {
  const container = teamCard.querySelector('.team-characters');
  container.innerHTML = '';
  const count = sessionIds.length;
  // Layout: 1-3 single row, 4-6 two rows, 7+ three rows
  const rows = count <= 3 ? 1 : count <= 6 ? 2 : 3;
  const perRow = Math.ceil(count / rows);

  sessionIds.forEach((sid, i) => {
    const s = sessionsData.get(sid);
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const itemsInRow = Math.min(perRow, count - row * perRow);

    const charEl = document.createElement('div');
    charEl.className = 'team-member-char';
    charEl.dataset.status = s?.status || 'idle';

    // Position in grid
    const leftPct = itemsInRow > 1 ? (col / (itemsInRow - 1)) * 80 + 10 : 50;
    const topPct = rows > 1 ? (row / (rows - 1)) * 60 + 10 : 30;
    const scale = count > 4 ? 0.7 : count > 2 ? 0.85 : 1;
    charEl.style.left = `${leftPct}%`;
    charEl.style.top = `${topPct}%`;
    charEl.style.transform = `translate(-50%, -50%) scale(${scale})`;

    // Build mini character using robotManager templates
    const model = s?.characterModel || 'robot';
    const accentColor = s?.accentColor || 'var(--accent-cyan)';
    charEl.innerHTML = `<div class="css-robot char-${model} mini" data-status="${s?.status || 'idle'}" style="--robot-color:${accentColor}"></div>`;

    // Role badge
    const badge = document.createElement('div');
    badge.className = 'team-role-badge';
    if (s?.teamRole === 'leader') {
      badge.textContent = 'L';
      badge.classList.add('leader');
    } else {
      badge.textContent = (s?.agentType || 'M').charAt(0).toUpperCase();
    }
    charEl.appendChild(badge);

    container.appendChild(charEl);
  });

  // Also fill in the mini robot content from templates
  import('./robotManager.js').then(rm => {
    const templates = rm._getTemplates ? rm._getTemplates() : null;
    if (!templates) return;
    container.querySelectorAll('.css-robot').forEach(el => {
      const model = [...el.classList].find(c => c.startsWith('char-'))?.replace('char-', '') || 'robot';
      const color = el.style.getPropertyValue('--robot-color') || 'var(--accent-cyan)';
      if (templates[model]) {
        el.innerHTML = templates[model](color);
      }
    });
  });
}

export function removeTeamCard(teamId) {
  const card = document.querySelector(`.team-card[data-team-id="${teamId}"]`);
  if (card) {
    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    setTimeout(() => card.remove(), 500);
  }
  // Unhide member cards
  const team = teamsData.get(teamId);
  if (team) {
    const allIds = [team.parentSessionId, ...team.childSessionIds];
    for (const sid of allIds) {
      const sCard = document.querySelector(`.session-card[data-session-id="${sid}"]`);
      if (sCard) sCard.classList.remove('in-team');
    }
  }
  teamsData.delete(teamId);
}

function openTeamModal(teamId) {
  const team = teamsData.get(teamId);
  if (!team) return;

  const modal = document.getElementById('team-modal');
  const nameEl = document.getElementById('team-modal-name');
  const countEl = document.getElementById('team-modal-count');
  const grid = document.getElementById('team-modal-grid');

  const allMemberIds = [team.parentSessionId, ...team.childSessionIds];
  nameEl.textContent = team.teamName || 'Team';
  countEl.textContent = `${allMemberIds.length} member${allMemberIds.length !== 1 ? 's' : ''}`;

  grid.innerHTML = '';
  for (const sid of allMemberIds) {
    const s = sessionsData.get(sid);
    if (!s) continue;

    const card = document.createElement('div');
    card.className = 'team-modal-card';
    card.dataset.status = s.status;

    const roleLabel = s.teamRole === 'leader'
      ? '<span class="team-role-label leader">TEAM LEAD</span>'
      : `<span class="team-role-label">${escapeHtml(s.agentType || 'member').toUpperCase()}</span>`;

    const prompt = s.currentPrompt || '';
    const promptExcerpt = prompt.length > 100 ? prompt.substring(0, 100) + '...' : prompt;

    card.innerHTML = `
      <div class="team-modal-card-header">
        <div class="team-modal-char-preview">
          <div class="css-robot char-${s.characterModel || 'robot'} mini" data-status="${s.status}" style="--robot-color:${s.accentColor || 'var(--accent-cyan)'}"></div>
        </div>
        <div class="team-modal-card-info">
          <div class="team-modal-card-title">${escapeHtml(s.projectName)}</div>
          ${roleLabel}
          <span class="status-badge ${s.status}">${s.status === 'approval' ? 'APPROVAL NEEDED' : s.status === 'input' ? 'WAITING FOR INPUT' : s.status.toUpperCase()}</span>
        </div>
      </div>
      <div class="team-modal-card-prompt">${escapeHtml(promptExcerpt)}</div>
      <div class="team-modal-card-stats">
        <span>${formatDuration(Date.now() - s.startedAt)}</span>
        <span>Tools: ${s.totalToolCalls || 0}</span>
      </div>
    `;

    card.addEventListener('click', () => {
      modal.classList.add('hidden');
      // Toggle: close if already selected, otherwise open
      if (selectedSessionId === sid) {
        deselectSession();
      } else {
        selectSession(sid);
      }
    });

    grid.appendChild(card);
  }

  // Fill in robot templates
  import('./robotManager.js').then(rm => {
    const templates = rm._getTemplates ? rm._getTemplates() : null;
    if (!templates) return;
    grid.querySelectorAll('.css-robot').forEach(el => {
      const model = [...el.classList].find(c => c.startsWith('char-'))?.replace('char-', '') || 'robot';
      const color = el.style.getPropertyValue('--robot-color') || 'var(--accent-cyan)';
      if (templates[model]) {
        el.innerHTML = templates[model](color);
      }
    });
  });

  modal.classList.remove('hidden');
}

// Wire up team modal close
document.getElementById('team-modal-close')?.addEventListener('click', () => {
  document.getElementById('team-modal').classList.add('hidden');
});
document.getElementById('team-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'team-modal') document.getElementById('team-modal').classList.add('hidden');
});

export function createOrUpdateCard(session) {
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
      <div class="robot-viewport"></div>
      <div class="card-info">
        <div class="card-title" title="Double-click to rename"></div>
        <div class="card-header">
          <span class="project-name"></span>
          <span class="card-label-badge"></span>
          <span class="source-badge"></span>
          <span class="status-badge"></span>
        </div>
        <div class="waiting-banner">NEEDS YOUR INPUT</div>
        <div class="card-prompt"></div>
        <div class="card-stats">
          <span class="duration"></span>
          <span class="tool-count"></span>
          <span class="subagent-count" title="Active subagents"></span>
        </div>
        <div class="tool-bars"></div>
      </div>
    `;
    // Only allow click-to-detail for SSH (manually created) sessions
    if (!isDisplayOnly) {
      card.addEventListener('click', (e) => {
        // Toggle: close if already selected, otherwise open
        if (selectedSessionId === session.sessionId) {
          deselectSession();
        } else {
          selectSession(session.sessionId);
        }
      });
    }

    // Mute button toggle (works for all sessions)
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

    // Close button — dismiss card from live view (works for all sessions)
    card.querySelector('.close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = session.sessionId;
      const sess = sessionsData.get(sid);
      // Close associated SSH terminal if present
      if (sess && sess.terminalId) {
        fetch(`/api/terminals/${sess.terminalId}`, { method: 'DELETE' }).catch(() => {});
      }
      // Mark as ended in IndexedDB so it won't reload as a live card
      db.get('sessions', sid).then(record => {
        if (record && record.status !== 'ended') {
          record.status = 'ended';
          record.endedAt = record.endedAt || Date.now();
          db.put('sessions', record);
        }
      }).catch(() => {});
      // Remove from server memory so it won't come back on WS reconnect
      fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
      // Clean up runtime caches (IndexedDB data preserved for history)
      mutedSessions.delete(sid);
      saveMuted(mutedSessions);
      pinnedSessions.delete(sid);
      savePinned(pinnedSessions);
      removeSessionFromGroup(sid);
      updateGroupCounts();
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9)';
      setTimeout(() => {
        removeCard(sid);
        const event = new CustomEvent('card-dismissed', { detail: { sessionId: sid } });
        document.dispatchEvent(event);
      }, 300);
    });

    // Only enable interactive buttons for SSH (manually created) sessions
    if (!isDisplayOnly) {
      // Pin button — pin card to top of its grid
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
          // Build context client-side from IndexedDB
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
          // Use default summary prompt template
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
            // Store in IndexedDB
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
    } // End of !isDisplayOnly block

    // Inline rename on double-click
    card.querySelector('.card-title').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const titleEl = e.currentTarget;
      if (titleEl.contentEditable === 'true') return;
      titleEl.contentEditable = 'true';
      titleEl.classList.add('editing');
      titleEl.focus();
      // Select all text
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
          // Also update IndexedDB
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
      // Use setTimeout so the browser captures the un-shrunk card as drag image
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
      // Determine left vs right half
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
      // Insert into the same parent grid as the target card
      const parentGrid = card.parentElement;
      if (dropLeft) {
        parentGrid.insertBefore(draggedCard, card);
      } else {
        parentGrid.insertBefore(draggedCard, card.nextSibling);
      }
      // Sync group membership
      const groupEl = parentGrid.closest('.session-group');
      if (groupEl) {
        addSessionToGroup(groupEl.id, draggedId);
      } else {
        removeSessionFromGroup(draggedId);
      }
      updateGroupCounts();
    });
    // Place card into its group or ungrouped grid
    const group = findGroupForSession(session.sessionId);
    if (group) {
      const groupGrid = document.querySelector(`#${group.id} .group-grid`);
      if (groupGrid) { groupGrid.appendChild(card); updateGroupCounts(); }
      else document.getElementById('sessions-grid').appendChild(card);
    } else {
      document.getElementById('sessions-grid').appendChild(card);
    }
    // Ensure pinned cards stay at top
    if (pinnedSessions.has(session.sessionId)) {
      reorderPinnedCards();
    }
  }

  // Update status attribute — promote active cards to front
  const prevStatus = card.dataset.status;
  card.dataset.status = session.status;
  const activeStatuses = new Set(['working', 'prompting', 'approval', 'input']);
  if (activeStatuses.has(session.status) && prevStatus !== session.status) {
    const grid = card.parentElement;
    if (grid) {
      // Insert after pinned cards
      const firstUnpinned = [...grid.children].find(c => !c.classList.contains('pinned'));
      if (firstUnpinned && firstUnpinned !== card) {
        grid.insertBefore(card, firstUnpinned);
      } else if (!firstUnpinned) {
        grid.appendChild(card);
      }
    }
  }

  // Update fields
  card.querySelector('.project-name').textContent = session.projectName;
  const cardTitle = card.querySelector('.card-title');
  if (cardTitle && cardTitle.contentEditable !== 'true') {
    cardTitle.textContent = session.title || '';
    cardTitle.style.display = session.title ? '' : 'none';
  }
  const badge = card.querySelector('.status-badge');
  const isDisconnected = session.source === 'ssh' && session.status === 'ended';
  const statusLabel = isDisconnected ? 'DISCONNECTED'
    : session.status === 'approval' ? 'APPROVAL NEEDED'
    : session.status === 'input' ? 'WAITING FOR INPUT'
    : session.status === 'waiting' ? 'WAITING'
    : session.status.toUpperCase();
  badge.textContent = statusLabel;
  badge.className = `status-badge ${isDisconnected ? 'disconnected' : session.status}`;
  // Add/remove disconnected class on card for dimming
  card.classList.toggle('disconnected', isDisconnected);

  // Label badge
  const labelBadge = card.querySelector('.card-label-badge');
  if (labelBadge) {
    const lbl = session.label || '';
    labelBadge.textContent = lbl;
    labelBadge.style.display = lbl ? '' : 'none';
  }

  // HEAVY card styling — bold highlighted frame
  const isHeavy = (session.label || '').toUpperCase() === 'HEAVY';
  card.classList.toggle('heavy-session', isHeavy);

  // ONEOFF card styling
  const isOneoff = (session.label || '').toUpperCase() === 'ONEOFF';
  card.classList.toggle('oneoff-session', isOneoff);

  // IMPORTANT card styling — purple bold frame
  const isImportant = (session.label || '').toUpperCase() === 'IMPORTANT';
  card.classList.toggle('important-session', isImportant);

  // Apply card frame effect from label settings (persistent animated border)
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

  // Source badge — show for non-SSH (display-only) sessions
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


  // Update approval banner with detail about what needs approval
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

  card.classList.toggle('has-queue', (session.queueCount || 0) > 0);
  card.classList.toggle('has-terminal', !!session.terminalId);

  // If this session is selected, update the detail panel too
  if (selectedSessionId === session.sessionId) {
    populateDetailPanel(session);
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
      if (selectedSessionId === sessionId) deselectSession();
      updateGroupCounts();
    }, 500);
  } else {
    card.remove();
    sessionsData.delete(sessionId);
    if (selectedSessionId === sessionId) deselectSession();
    updateGroupCounts();
  }
}

export function updateDurations() {
  for (const [sessionId, session] of sessionsData) {
    const card = document.querySelector(`.session-card[data-session-id="${sessionId}"] .duration`);
    if (card) {
      card.textContent = formatDuration(Date.now() - session.startedAt);
    }
  }
  // Also update detail panel duration if open
  if (selectedSessionId) {
    const session = sessionsData.get(selectedSessionId);
    if (session) {
      const el = document.getElementById('detail-duration');
      if (el) el.textContent = formatDuration(Date.now() - session.startedAt);
    }
  }
}

export function showToast(title, message) {
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

async function loadNotes(sessionId) {
  const list = document.getElementById('notes-list');
  try {
    const notes = await db.getNotes(sessionId);
    list.innerHTML = notes.map(n => `
      <div class="note-entry">
        <div class="note-meta">
          <span class="note-time">${formatTime(n.createdAt)}</span>
          <button class="note-delete" data-note-id="${n.id}">DELETE</button>
        </div>
        <div class="note-text">${escapeHtml(n.text)}</div>
      </div>
    `).join('') || '<div class="tab-empty">No notes yet</div>';
  } catch(e) {
    list.innerHTML = '<div class="tab-empty">Failed to load notes</div>';
  }
}

// Track known queue item IDs to detect newly added items
let _knownQueueIds = new Set();

export async function loadQueue(sessionId) {
  const list = document.getElementById('queue-list');
  const countBadge = document.getElementById('terminal-queue-count');
  try {
    const items = await db.getQueue(sessionId);
    if (countBadge) countBadge.textContent = items.length > 0 ? `(${items.length})` : '';

    const newIds = new Set(items.map(item => item.id));
    list.innerHTML = items.map((item, i) => {
      const isNew = !_knownQueueIds.has(item.id);
      return `
      <div class="queue-item${isNew ? ' entering' : ''}" draggable="true" data-queue-id="${item.id}">
        <span class="queue-pos">${i + 1}</span>
        <div class="queue-text">${escapeHtml(item.text)}</div>
        <div class="queue-actions">
          <button class="queue-send" data-queue-id="${item.id}" title="Send to terminal">SEND</button>
          <button class="queue-edit" data-queue-id="${item.id}" title="Edit">EDIT</button>
          <button class="queue-delete" data-queue-id="${item.id}" title="Delete">DEL</button>
        </div>
      </div>`;
    }).join('') || '<div class="tab-empty">No prompts queued</div>';
    _knownQueueIds = newIds;

    // Remove entering class after animation completes
    list.querySelectorAll('.queue-item.entering').forEach(el => {
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    });

    // Wire up drag-to-reorder
    wireQueueDrag(sessionId);
  } catch(e) {
    list.innerHTML = '<div class="tab-empty">Failed to load queue</div>';
  }
}

function wireQueueDrag(sessionId) {
  const list = document.getElementById('queue-list');
  let dragItem = null;
  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'copyMove';
      // Set data for drag-to-terminal
      const text = item.querySelector('.queue-text')?.textContent || '';
      e.dataTransfer.setData('text/queue-prompt', text);
      e.dataTransfer.setData('text/queue-id', item.dataset.queueId);
    });
    item.addEventListener('dragend', async () => {
      item.classList.remove('dragging');
      dragItem = null;
      // Collect new order and persist to IndexedDB
      const orderedIds = [...list.querySelectorAll('.queue-item')].map(el => parseInt(el.dataset.queueId));
      await db.reorderQueue(sessionId, orderedIds);
      loadQueue(sessionId);
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragItem || dragItem === item) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        list.insertBefore(dragItem, item);
      } else {
        list.insertBefore(dragItem, item.nextSibling);
      }
    });
  });
}

function selectSession(sessionId) {
  selectedSessionId = sessionId;
  const session = sessionsData.get(sessionId);
  if (!session) return;

  // Populate and show detail panel
  populateDetailPanel(session);
  const overlay = document.getElementById('session-detail-overlay');
  overlay.classList.remove('hidden');
}

function deselectSession() {
  selectedSessionId = null;
  document.getElementById('session-detail-overlay').classList.add('hidden');
  // Keep terminal alive — content is preserved when panel reopens
}

function populateDetailPanel(session) {
  document.getElementById('detail-project-name').textContent = session.projectName;
  const badge = document.getElementById('detail-status-badge');
  const detailLabel = session.status === 'approval' ? 'APPROVAL NEEDED'
    : session.status === 'input' ? 'WAITING FOR INPUT'
    : session.status === 'waiting' ? 'WAITING'
    : session.status.toUpperCase();
  badge.textContent = detailLabel;
  badge.className = `status-badge ${session.status}`;
  document.getElementById('detail-model').textContent = session.model || '';
  const durationText = formatDuration(Date.now() - session.startedAt);
  const durationEl = document.getElementById('detail-duration');
  durationEl.textContent = durationText;
  durationEl.style.display = durationText ? '' : 'none';

  // Character model selector
  const charSelect = document.getElementById('detail-char-model');
  if (charSelect) {
    charSelect.value = session.characterModel || '';
    charSelect.dataset.sessionId = session.sessionId;
  }

  // Mini character preview in header — use the session's actual accent color
  import('./robotManager.js').then(rm => {
    const color = rm.getSessionColor(session.sessionId) || session.accentColor || null;
    updateDetailCharPreview(session.characterModel || '', session.status, color);
  });

  // Session title
  const titleInput = document.getElementById('detail-title');
  if (titleInput) {
    titleInput.value = session.title || '';
    titleInput.dataset.sessionId = session.sessionId;
  }

  // Session label
  const labelInput = document.getElementById('detail-label');
  if (labelInput) {
    labelInput.value = session.label || '';
    labelInput.dataset.sessionId = session.sessionId;
  }

  // Label quick-select chips
  populateDetailLabelChips(session);

  // Prompt History tab — show only user prompts in chronological order
  const convContainer = document.getElementById('detail-conversation');
  const prompts = (session.promptHistory || []).slice().sort((a, b) => b.timestamp - a.timestamp);
  convContainer.innerHTML = prompts.length > 0
    ? prompts.map((p, i) => `<div class="conv-entry conv-user">
        <div class="conv-header"><span class="conv-role">#${prompts.length - i}</span><span class="conv-time">${formatTime(p.timestamp)}</span><button class="conv-copy" title="Copy">COPY</button></div>
        <div class="conv-text">${escapeHtml(p.text)}</div>
      </div>`).join('')
    : '<div class="tab-empty">No prompts yet</div>';

  // Activity tab — merge events, tool calls, and responses chronologically
  const activityLog = document.getElementById('detail-activity-log');
  const activityItems = [];
  for (const e of (session.events || [])) {
    activityItems.push({ kind: 'event', type: e.type, detail: e.detail, timestamp: e.timestamp });
  }
  for (const t of (session.toolLog || [])) {
    activityItems.push({ kind: 'tool', tool: t.tool, input: t.input, timestamp: t.timestamp });
  }
  for (const r of (session.responseLog || [])) {
    activityItems.push({ kind: 'response', text: r.text, timestamp: r.timestamp });
  }
  activityItems.sort((a, b) => b.timestamp - a.timestamp);
  activityLog.innerHTML = activityItems.length > 0
    ? activityItems.map(item => {
        if (item.kind === 'tool') {
          return `<div class="activity-entry activity-tool">
            <span class="activity-time">${formatTime(item.timestamp)}</span>
            <span class="activity-badge activity-badge-tool">${escapeHtml(item.tool)}</span>
            <span class="activity-detail">${escapeHtml(item.input)}</span>
          </div>`;
        } else if (item.kind === 'response') {
          return `<div class="activity-entry activity-response">
            <span class="activity-time">${formatTime(item.timestamp)}</span>
            <span class="activity-badge activity-badge-response">RESPONSE</span>
            <span class="activity-detail">${escapeHtml(item.text)}</span>
          </div>`;
        } else {
          return `<div class="activity-entry activity-event">
            <span class="activity-time">${formatTime(item.timestamp)}</span>
            <span class="activity-badge activity-badge-event">${escapeHtml(item.type)}</span>
            <span class="activity-detail">${escapeHtml(item.detail)}</span>
          </div>`;
        }
      }).join('')
    : '<div class="tab-empty">No activity yet</div>';

  // Summary tab
  const summaryEl = document.getElementById('summary-content');
  if (summaryEl) {
    if (session.summary) {
      summaryEl.innerHTML = `<div class="summary-text">${escapeHtml(session.summary).replace(/\n/g, '<br>')}</div>`;
    } else {
      summaryEl.innerHTML = '<div class="tab-empty">No summary yet — click SUMMARIZE to generate one with AI</div>';
    }
  }

  // Update summarize button state
  const sumBtn = document.getElementById('ctrl-summarize');
  if (sumBtn) {
    sumBtn.disabled = false;
    sumBtn.textContent = session.summary ? 'RE-SUMMARIZE' : 'SUMMARIZE';
  }

  // Group select — populate with all groups, highlight current
  refreshAllGroupSelects();

  // Load notes & queue
  loadNotes(session.sessionId);
  loadQueue(session.sessionId);
  // Auto-attach terminal if Terminal tab is the default active tab
  const activeTab = document.querySelector('.detail-tabs .tab.active');
  if (activeTab && activeTab.dataset.tab === 'terminal' && session.terminalId) {
    import('./terminalManager.js').then(tm => {
      if (tm.getActiveTerminalId() === session.terminalId) {
        // Same terminal already active — just refit after panel becomes visible
        requestAnimationFrame(() => tm.refitTerminal());
      } else {
        tm.attachToSession(session.sessionId, session.terminalId);
      }
    });
  } else if (activeTab && activeTab.dataset.tab === 'terminal' && !session.terminalId) {
    // Switching to a session with no terminal — detach the old one
    import('./terminalManager.js').then(tm => tm.detachTerminal());
  }

}

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

function formatDuration(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function openSessionDetailFromHistory(sessionId) {
  const data = await db.getSessionDetail(sessionId);
  if (!data) { showToast('ERROR', 'Session not found in local database'); return; }

  // Populate detail header
  document.getElementById('detail-project-name').textContent = data.session.projectName || data.session.projectPath || 'Unknown';
  const badge = document.getElementById('detail-status-badge');
  badge.textContent = data.session.status.toUpperCase();
  badge.className = `status-badge ${data.session.status}`;
  document.getElementById('detail-model').textContent = data.session.model || '';
  const duration = data.session.endedAt
    ? formatDuration(data.session.endedAt - data.session.startedAt)
    : formatDuration(Date.now() - data.session.startedAt);
  const durEl = document.getElementById('detail-duration');
  durEl.textContent = duration;
  durEl.style.display = duration ? '' : 'none';

  // Session title
  const titleInput = document.getElementById('detail-title');
  if (titleInput) {
    titleInput.value = data.session.title || '';
    titleInput.dataset.sessionId = sessionId;
  }

  // Character model selector + preview
  const charSelect = document.getElementById('detail-char-model');
  if (charSelect) {
    charSelect.value = data.session.characterModel || '';
    charSelect.dataset.sessionId = sessionId;
  }
  updateDetailCharPreview(
    data.session.characterModel || '',
    data.session.status,
    data.session.accentColor || null
  );

  // Populate conversation tab — interleave prompts, tool calls, and responses
  const histConvItems = [];
  for (const p of (data.prompts || [])) {
    histConvItems.push({ type: 'user', text: p.text, timestamp: p.timestamp });
  }
  for (const t of (data.tool_calls || [])) {
    histConvItems.push({ type: 'tool', tool: t.toolName, input: t.toolInputSummary, timestamp: t.timestamp });
  }
  for (const r of (data.responses || [])) {
    histConvItems.push({ type: 'claude', text: r.textExcerpt, timestamp: r.timestamp });
  }
  histConvItems.sort((a, b) => b.timestamp - a.timestamp);
  const histConvContainer = document.getElementById('detail-conversation');
  histConvContainer.innerHTML = histConvItems.length > 0
    ? histConvItems.map(item => {
        if (item.type === 'user') {
          return `<div class="conv-entry conv-user">
            <div class="conv-header"><span class="conv-role">USER</span><span class="conv-time">${formatTime(item.timestamp)}</span><button class="conv-copy" title="Copy">COPY</button></div>
            <div class="conv-text">${escapeHtml(item.text)}</div>
          </div>`;
        } else if (item.type === 'tool') {
          return `<div class="conv-entry conv-tool">
            <div class="conv-header"><span class="conv-role">TOOL</span><span class="conv-time">${formatTime(item.timestamp)}</span><button class="conv-copy" title="Copy">COPY</button></div>
            <span class="conv-tool-name">${escapeHtml(item.tool)}</span>
            <span class="conv-tool-input">${escapeHtml(item.input)}</span>
          </div>`;
        } else {
          return `<div class="conv-entry conv-claude">
            <div class="conv-header"><span class="conv-role">CLAUDE</span><span class="conv-time">${formatTime(item.timestamp)}</span><button class="conv-copy" title="Copy">COPY</button></div>
            <div class="conv-text">${escapeHtml(item.text)}</div>
          </div>`;
        }
      }).join('')
    : '<div class="tab-empty">No conversation recorded</div>';

  // Populate activity tab (merged tool calls + events + responses)
  const histActivityItems = [];
  for (const t of (data.tool_calls || [])) {
    histActivityItems.push({ kind: 'tool', tool: t.toolName, input: t.toolInputSummary, timestamp: t.timestamp });
  }
  for (const e of (data.events || [])) {
    histActivityItems.push({ kind: 'event', type: e.eventType, detail: e.detail, timestamp: e.timestamp });
  }
  for (const r of (data.responses || [])) {
    histActivityItems.push({ kind: 'response', text: r.textExcerpt || r.text, timestamp: r.timestamp });
  }
  histActivityItems.sort((a, b) => b.timestamp - a.timestamp);
  const actEl = document.getElementById('detail-activity-log');
  if (actEl) {
    actEl.innerHTML = histActivityItems.length > 0
      ? histActivityItems.map(item => {
          if (item.kind === 'tool') {
            return `<div class="activity-entry activity-tool">
              <span class="activity-time">${formatTime(item.timestamp)}</span>
              <span class="activity-badge activity-badge-tool">${escapeHtml(item.tool)}</span>
              <span class="activity-detail">${escapeHtml(item.input)}</span>
            </div>`;
          } else if (item.kind === 'response') {
            return `<div class="activity-entry activity-response">
              <span class="activity-time">${formatTime(item.timestamp)}</span>
              <span class="activity-badge activity-badge-response">RESPONSE</span>
              <span class="activity-detail">${escapeHtml(item.text)}</span>
            </div>`;
          } else {
            return `<div class="activity-entry activity-event">
              <span class="activity-time">${formatTime(item.timestamp)}</span>
              <span class="activity-badge activity-badge-event">${escapeHtml(item.type)}</span>
              <span class="activity-detail">${escapeHtml(item.detail)}</span>
            </div>`;
          }
        }).join('')
      : '<div class="tab-empty">No activity recorded</div>';
  }

  // Summary tab
  const summaryEl = document.getElementById('summary-content');
  if (summaryEl) {
    if (data.session.summary) {
      summaryEl.innerHTML = `<div class="summary-text">${escapeHtml(data.session.summary).replace(/\n/g, '<br>')}</div>`;
    } else {
      summaryEl.innerHTML = '<div class="tab-empty">No summary yet — click SUMMARIZE to generate one with AI</div>';
    }
  }

  // Update summarize button state
  const sumBtn = document.getElementById('ctrl-summarize');
  if (sumBtn) {
    sumBtn.disabled = false;
    sumBtn.textContent = data.session.summary ? 'RE-SUMMARIZE' : 'SUMMARIZE';
  }

  // Store sessionId for the summarize button handler
  selectedSessionId = sessionId;

  // Group select — populate with all groups, highlight current
  refreshAllGroupSelects();

  // Load notes for this session
  loadNotes(sessionId);
  // Show overlay
  document.getElementById('session-detail-overlay').classList.remove('hidden');
}

// Character model mini preview in detail panel
function updateDetailCharPreview(modelName, status, color) {
  const container = document.getElementById('detail-char-preview');
  if (!container) return;
  const model = modelName || 'robot';
  const accentColor = color || 'var(--accent-cyan)';
  // Dynamically import to get the template
  import('./robotManager.js').then(rm => {
    // Build a mini robot element
    container.innerHTML = '';
    const mini = document.createElement('div');
    mini.className = `css-robot char-${model}`;
    mini.dataset.status = status || 'idle';
    mini.style.setProperty('--robot-color', accentColor);
    // Use the template from robotManager
    const templates = rm._getTemplates ? rm._getTemplates() : null;
    if (templates && templates[model]) {
      mini.innerHTML = templates[model](accentColor);
    } else {
      // Fallback - just show model name
      mini.textContent = model;
    }
    container.appendChild(mini);
  });
}

// Per-session character model change
const charModelSelect = document.getElementById('detail-char-model');
if (charModelSelect) {
  charModelSelect.addEventListener('change', async (e) => {
    const model = e.target.value;
    const sessionId = e.target.dataset.sessionId;
    if (!sessionId) return;

    // Update in-memory session data
    const session = sessionsData.get(sessionId);
    if (session) session.characterModel = model;

    // Save to IndexedDB
    try {
      const s = await db.get('sessions', sessionId);
      if (s) { s.characterModel = model; await db.put('sessions', s); }
    } catch(e) {
      console.error('[sessionPanel] Failed to save character model:', e.message);
    }

    // Update the robot on the card
    import('./robotManager.js').then(rm => {
      rm.switchSessionCharacter(sessionId, model);
    });

    // Update mini preview with session's accent color
    import('./robotManager.js').then(rm => {
      const color = rm.getSessionColor(sessionId) || session?.accentColor || null;
      updateDetailCharPreview(model, session?.status || 'idle', color);
    });
  });
}

// Wire up close button and overlay backdrop click
document.getElementById('close-detail').addEventListener('click', deselectSession);
document.getElementById('session-detail-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'session-detail-overlay') deselectSession();
});

// Conversation copy button (event delegation)
document.getElementById('detail-conversation').addEventListener('click', async (e) => {
  const btn = e.target.closest('.conv-copy');
  if (!btn) return;
  const entry = btn.closest('.conv-entry');
  if (!entry) return;
  // Extract text content from the entry (skip the header row)
  const textEl = entry.querySelector('.conv-text');
  const text = textEl
    ? textEl.textContent
    : (entry.querySelector('.conv-tool-name')?.textContent || '') + ' ' + (entry.querySelector('.conv-tool-input')?.textContent || '');
  try {
    await navigator.clipboard.writeText(text.trim());
    btn.textContent = 'COPIED';
    setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
  } catch {
    showToast('COPY', 'Failed to copy to clipboard');
  }
});

// Tab switching
document.querySelector('.detail-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  const tabName = btn.dataset.tab;

  // Toggle active on buttons
  document.querySelectorAll('.detail-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');

  // Toggle active on content
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');

  // Terminal tab: refit or attach; switching away just leaves terminal in background
  if (tabName === 'terminal' && selectedSessionId) {
    const session = sessionsData.get(selectedSessionId);
    if (session && session.terminalId) {
      import('./terminalManager.js').then(tm => {
        if (tm.getActiveTerminalId() === session.terminalId) {
          requestAnimationFrame(() => tm.refitTerminal());
        } else {
          tm.attachToSession(selectedSessionId, session.terminalId);
        }
      });
    }
  }
});

// ---- Control Button Handlers ----

// Kill button
document.getElementById('ctrl-kill').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const session = sessionsData.get(selectedSessionId);
  const msg = document.getElementById('kill-modal-msg');
  msg.textContent = `Kill session for "${session ? session.projectName : selectedSessionId}"? This will terminate the Claude process (SIGTERM → SIGKILL).`;
  document.getElementById('kill-modal').classList.remove('hidden');
});

document.getElementById('kill-cancel').addEventListener('click', () => {
  document.getElementById('kill-modal').classList.add('hidden');
});

document.getElementById('kill-confirm').addEventListener('click', async () => {
  document.getElementById('kill-modal').classList.add('hidden');
  if (!selectedSessionId) return;
  const session = sessionsData.get(selectedSessionId);
  try {
    const resp = await fetch(`/api/sessions/${selectedSessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    });
    const data = await resp.json();
    if (data.ok) {
      // Close associated SSH terminal if present
      if (session && session.terminalId) {
        fetch(`/api/terminals/${session.terminalId}`, { method: 'DELETE' }).catch(() => {});
      }
      showToast('PROCESS KILLED', `PID ${data.pid || 'N/A'} terminated`);
      soundManager.play('kill');
      // Auto-close detail panel and remove card
      deselectSession();
    } else {
      showToast('KILL FAILED', data.error || 'Unknown error');
    }
  } catch(e) {
    showToast('KILL ERROR', e.message);
  }
});

// Group select (detail panel)
document.getElementById('detail-group-select').addEventListener('change', (e) => {
  if (!selectedSessionId) return;
  const groupId = e.target.value;
  const card = document.querySelector(`.session-card[data-session-id="${selectedSessionId}"]`);
  if (!card) return;
  if (groupId) {
    const groupGrid = document.querySelector(`#${groupId} .group-grid`);
    if (groupGrid) {
      groupGrid.appendChild(card);
      addSessionToGroup(groupId, selectedSessionId);
    }
  } else {
    document.getElementById('sessions-grid').appendChild(card);
    removeSessionFromGroup(selectedSessionId);
  }
  updateGroupCounts();
  if (pinnedSessions.has(selectedSessionId)) reorderPinnedCards();
  showToast('GROUP', groupId ? `Moved to group` : 'Removed from group');
});

// Archive button — move session from live dashboard to history
document.getElementById('ctrl-archive').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const sid = selectedSessionId;
  try {
    // Mark as ended + archived in IndexedDB
    const s = await db.get('sessions', sid);
    if (s) {
      s.status = 'ended';
      s.archived = 1;
      if (!s.endedAt) s.endedAt = Date.now();
      await db.put('sessions', s);
    }
    // Remove from server memory
    await fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
    // Close detail panel and remove live card
    deselectSession();
    removeCard(sid);
    sessionsData.delete(sid);
    import('./robotManager.js').then(rm => rm.removeRobot(sid));
    // Dispatch card-dismissed for group count update
    document.dispatchEvent(new CustomEvent('card-dismissed', { detail: { sessionId: sid } }));
    showToast('ARCHIVED', 'Session moved to history');
  } catch(err) {
    showToast('ARCHIVE ERROR', err.message);
  }
});

// ---- Permanent Delete ----
document.getElementById('ctrl-delete').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const session = sessionsData.get(selectedSessionId);
  const label = session?.title || session?.projectName || selectedSessionId.slice(0, 8);
  if (!confirm(`Permanently delete session "${label}"?\nThis cannot be undone.`)) return;
  const sid = selectedSessionId;
  try {
    // Server-side removal (closes terminal if active, broadcasts session_removed)
    await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    // Also remove from browser IndexedDB
    await db.del('sessions', sid);
    deselectSession();
    showToast('DELETED', `Session "${label}" permanently removed`);
  } catch (err) {
    showToast('DELETE ERROR', err.message);
  }
});

// ---- Summarize Prompt Selector Modal ----

let selectedPromptId = null;
let summaryPromptsCache = [];

async function loadSummaryPrompts() {
  try {
    const prompts = await db.getAll('summaryPrompts');
    summaryPromptsCache = prompts || [];
    return summaryPromptsCache;
  } catch(e) {
    return [];
  }
}

function renderSummaryPromptList(prompts) {
  const list = document.getElementById('summarize-prompt-list');
  if (!list) return;
  selectedPromptId = null;
  const runBtn = document.getElementById('summarize-run');
  if (runBtn) runBtn.disabled = true;

  list.innerHTML = prompts.map(p => `
    <div class="summarize-prompt-item${p.isDefault ? ' default' : ''}" data-prompt-id="${p.id}">
      <div class="summarize-prompt-item-header">
        <span class="summarize-prompt-name">${escapeHtml(p.name)}</span>
        ${p.isDefault ? '<span class="summarize-prompt-default-badge">DEFAULT</span>' : ''}
        <div class="summarize-prompt-actions">
          <button class="summarize-prompt-default-btn" data-id="${p.id}" title="Set as default">&#9733;</button>
          <button class="summarize-prompt-edit-btn" data-id="${p.id}" title="Edit">&#9998;</button>
          <button class="summarize-prompt-delete-btn" data-id="${p.id}" title="Delete">&times;</button>
        </div>
      </div>
      <div class="summarize-prompt-preview">${escapeHtml(p.prompt).substring(0, 150)}${p.prompt.length > 150 ? '...' : ''}</div>
    </div>
  `).join('');

  // Select handler
  list.querySelectorAll('.summarize-prompt-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.summarize-prompt-actions')) return;
      list.querySelectorAll('.summarize-prompt-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      selectedPromptId = parseInt(item.dataset.promptId, 10);
      if (runBtn) runBtn.disabled = false;
    });
  });

  // Set default button
  list.querySelectorAll('.summarize-prompt-default-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      // Clear isDefault on all prompts, then set on the chosen one
      const allPrompts = await db.getAll('summaryPrompts');
      for (const p of allPrompts) {
        if (p.isDefault && p.id !== id) {
          p.isDefault = 0;
          await db.put('summaryPrompts', p);
        }
      }
      const item = await db.get('summaryPrompts', id);
      if (item) {
        item.isDefault = 1;
        await db.put('summaryPrompts', item);
      }
      const prompts = await loadSummaryPrompts();
      renderSummaryPromptList(prompts);
      showToast('DEFAULT SET', 'Summary prompt set as default');
    });
  });

  // Edit button
  list.querySelectorAll('.summarize-prompt-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const p = summaryPromptsCache.find(x => x.id === id);
      if (!p) return;
      const nameInput = document.getElementById('summarize-custom-name');
      const promptInput = document.getElementById('summarize-custom-prompt');
      const form = document.getElementById('summarize-custom-form');
      nameInput.value = p.name;
      promptInput.value = p.prompt;
      form.classList.remove('hidden');
      form.dataset.editId = id;
    });
  });

  // Delete button
  list.querySelectorAll('.summarize-prompt-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      await db.del('summaryPrompts', id);
      const prompts = await loadSummaryPrompts();
      renderSummaryPromptList(prompts);
      showToast('DELETED', 'Prompt template removed');
    });
  });

  // Auto-select the default prompt
  const defaultPrompt = prompts.find(p => p.isDefault);
  if (defaultPrompt) {
    const defaultItem = list.querySelector(`[data-prompt-id="${defaultPrompt.id}"]`);
    if (defaultItem) {
      defaultItem.classList.add('selected');
      selectedPromptId = defaultPrompt.id;
      if (runBtn) runBtn.disabled = false;
    }
  }
}

async function openSummarizeModal() {
  const prompts = await loadSummaryPrompts();
  renderSummaryPromptList(prompts);
  // Reset custom form
  const form = document.getElementById('summarize-custom-form');
  form.classList.add('hidden');
  delete form.dataset.editId;
  document.getElementById('summarize-custom-name').value = '';
  document.getElementById('summarize-custom-prompt').value = '';
  document.getElementById('summarize-modal').classList.remove('hidden');
}

async function runSummarize(promptId, customPrompt) {
  const modal = document.getElementById('summarize-modal');
  modal.classList.add('hidden');
  const btn = document.getElementById('ctrl-summarize');
  btn.disabled = true;
  btn.textContent = 'SUMMARIZING...';

  try {
    // Build context client-side from IndexedDB
    const detail = await db.getSessionDetail(selectedSessionId);
    if (!detail) throw new Error('Session not found in local database');

    // Build context string (same logic the server used)
    let context = `Project: ${detail.session.projectName || detail.session.projectPath || 'Unknown'}\n`;
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

    // Resolve prompt template
    let promptTemplate = customPrompt || '';
    if (!promptTemplate && promptId) {
      const tmpl = await db.get('summaryPrompts', promptId);
      if (tmpl) promptTemplate = tmpl.prompt;
    }

    const resp = await fetch(`/api/sessions/${selectedSessionId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, promptTemplate })
    });
    const data = await resp.json();
    if (data.ok) {
      const session = sessionsData.get(selectedSessionId);
      if (session) { session.archived = 1; session.summary = data.summary; }
      // Store summary in IndexedDB
      const s = await db.get('sessions', selectedSessionId);
      if (s) { s.summary = data.summary; s.archived = 1; await db.put('sessions', s); }
      const summaryEl = document.getElementById('summary-content');
      if (summaryEl) {
        summaryEl.innerHTML = `<div class="summary-text">${escapeHtml(data.summary).replace(/\n/g, '<br>')}</div>`;
      }
      document.querySelectorAll('.detail-tabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      const summaryTab = document.querySelector('.detail-tabs .tab[data-tab="summary"]');
      if (summaryTab) summaryTab.classList.add('active');
      document.getElementById('tab-summary').classList.add('active');
      btn.textContent = 'RE-SUMMARIZE';
      btn.disabled = false;
      showToast('SUMMARIZED', 'AI summary generated & session archived');
    } else {
      showToast('SUMMARIZE FAILED', data.error || 'Unknown error');
      btn.textContent = 'SUMMARIZE';
      btn.disabled = false;
    }
  } catch(err) {
    showToast('SUMMARIZE ERROR', err.message);
    btn.textContent = 'SUMMARIZE';
    btn.disabled = false;
  }
}

// Summarize button → opens prompt selector modal
document.getElementById('ctrl-summarize').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  openSummarizeModal();
});

// Modal close
document.getElementById('summarize-modal-close')?.addEventListener('click', () => {
  document.getElementById('summarize-modal').classList.add('hidden');
});
document.getElementById('summarize-cancel')?.addEventListener('click', () => {
  document.getElementById('summarize-modal').classList.add('hidden');
});
document.getElementById('summarize-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'summarize-modal') document.getElementById('summarize-modal').classList.add('hidden');
});

// Run summarize with selected prompt
document.getElementById('summarize-run')?.addEventListener('click', () => {
  if (selectedPromptId) runSummarize(selectedPromptId, null);
});

// Toggle custom prompt form
document.getElementById('summarize-toggle-custom')?.addEventListener('click', () => {
  const form = document.getElementById('summarize-custom-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    delete form.dataset.editId;
    document.getElementById('summarize-custom-name').value = '';
    document.getElementById('summarize-custom-prompt').value = '';
  }
});

// Save as template
document.getElementById('summarize-save-template')?.addEventListener('click', async () => {
  const nameInput = document.getElementById('summarize-custom-name');
  const promptInput = document.getElementById('summarize-custom-prompt');
  const form = document.getElementById('summarize-custom-form');
  const name = nameInput.value.trim();
  const prompt = promptInput.value.trim();
  if (!name || !prompt) { showToast('MISSING', 'Name and prompt are required'); return; }

  const editId = form.dataset.editId;
  if (editId) {
    const item = await db.get('summaryPrompts', parseInt(editId, 10));
    if (item) {
      item.name = name;
      item.prompt = prompt;
      item.updatedAt = Date.now();
      await db.put('summaryPrompts', item);
    }
    showToast('UPDATED', 'Template updated');
  } else {
    const now = Date.now();
    await db.put('summaryPrompts', { name, prompt, isDefault: 0, createdAt: now, updatedAt: now });
    showToast('SAVED', 'Template saved');
  }
  form.classList.add('hidden');
  delete form.dataset.editId;
  nameInput.value = '';
  promptInput.value = '';
  const prompts = await loadSummaryPrompts();
  renderSummaryPromptList(prompts);
});

// Use once (custom prompt without saving)
document.getElementById('summarize-use-once')?.addEventListener('click', () => {
  const prompt = document.getElementById('summarize-custom-prompt').value.trim();
  if (!prompt) { showToast('MISSING', 'Write a prompt first'); return; }
  runSummarize(null, prompt);
});


// Save note
document.getElementById('save-note').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  const textarea = document.getElementById('note-textarea');
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await db.addNote(selectedSessionId, text);
    textarea.value = '';
    loadNotes(selectedSessionId);
    showToast('NOTE SAVED', 'Note added successfully');
  } catch(e) {
    showToast('NOTE ERROR', e.message);
  }
});

// Delete note (event delegation)
document.getElementById('notes-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.note-delete');
  if (!btn || !selectedSessionId) return;
  const noteId = btn.dataset.noteId;
  try {
    await db.del('notes', Number(noteId));
    loadNotes(selectedSessionId);
  } catch(e) {
    showToast('DELETE ERROR', e.message);
  }
});

// ---- Prompt Queue Handlers ----

// Collapsible queue panel toggle
document.getElementById('terminal-queue-toggle')?.addEventListener('click', () => {
  const panel = document.getElementById('terminal-queue-panel');
  if (panel) {
    panel.classList.toggle('collapsed');
    // Refit terminal after toggle since container height changes
    import('./terminalManager.js').then(tm => {
      requestAnimationFrame(() => tm.refitTerminal());
    });
  }
});


// Add to Queue
document.getElementById('queue-add-btn')?.addEventListener('click', async () => {
  if (!selectedSessionId) return;
  const textarea = document.getElementById('queue-textarea');
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await db.addToQueue(selectedSessionId, text);
    textarea.value = '';
    loadQueue(selectedSessionId);
    showToast('QUEUED', 'Prompt added to queue');
  } catch(e) {
    showToast('QUEUE ERROR', e.message);
  }
});

// Send prompt text to terminal as input
async function sendToTerminal(text) {
  const tm = await import('./terminalManager.js');
  const { getWs } = await import('./wsClient.js');
  const ws = getWs();
  const terminalId = tm.getActiveTerminalId();
  if (!terminalId || !ws || ws.readyState !== 1) {
    showToast('TERMINAL', 'No active terminal connection');
    return false;
  }
  // Send the text + Enter to the terminal
  ws.send(JSON.stringify({ type: 'terminal_input', terminalId, data: text + '\n' }));
  return true;
}

// Delete / Edit / Send queue items (event delegation)
document.getElementById('queue-list')?.addEventListener('click', async (e) => {
  const delBtn = e.target.closest('.queue-delete');
  const editBtn = e.target.closest('.queue-edit');
  const sendBtn = e.target.closest('.queue-send');
  if (!selectedSessionId) return;

  if (sendBtn) {
    const itemId = sendBtn.dataset.queueId;
    const itemEl = sendBtn.closest('.queue-item');
    const text = itemEl?.querySelector('.queue-text')?.textContent;
    if (text) {
      const sent = await sendToTerminal(text);
      if (sent) {
        // Remove from queue after sending
        try {
          await db.del('promptQueue', Number(itemId));
          loadQueue(selectedSessionId);
        } catch(e) {}
        showToast('SENT', 'Prompt sent to terminal');
      }
    }
  }

  if (delBtn) {
    const itemId = delBtn.dataset.queueId;
    try {
      await db.del('promptQueue', Number(itemId));
      loadQueue(selectedSessionId);
    } catch(e) {
      showToast('DELETE ERROR', e.message);
    }
  }

  if (editBtn) {
    const itemId = editBtn.dataset.queueId;
    const itemEl = editBtn.closest('.queue-item');
    const textEl = itemEl?.querySelector('.queue-text');
    if (!textEl) return;
    const currentText = textEl.textContent;
    // Inline edit: replace text with textarea
    const ta = document.createElement('textarea');
    ta.className = 'queue-edit-textarea';
    ta.value = currentText;
    ta.rows = 3;
    textEl.replaceWith(ta);
    ta.focus();
    editBtn.textContent = 'SAVE';
    editBtn.classList.add('saving');

    const saveEdit = async () => {
      const newText = ta.value.trim();
      if (newText && newText !== currentText) {
        try {
          const existing = await db.get('promptQueue', Number(itemId));
          if (existing) {
            existing.text = newText;
            await db.put('promptQueue', existing);
          }
        } catch(e) {
          showToast('EDIT ERROR', e.message);
        }
      }
      loadQueue(selectedSessionId);
    };

    editBtn.onclick = (ev) => { ev.stopPropagation(); saveEdit(); };
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveEdit(); }
      if (ev.key === 'Escape') loadQueue(selectedSessionId);
    });
  }
});

// Enable drag-to-terminal: drop a queue item onto the terminal to send it
document.getElementById('terminal-container')?.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('text/queue-prompt')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    e.currentTarget.classList.add('drop-target');
  }
});
document.getElementById('terminal-container')?.addEventListener('dragleave', (e) => {
  e.currentTarget.classList.remove('drop-target');
});
document.getElementById('terminal-container')?.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.currentTarget.classList.remove('drop-target');
  const text = e.dataTransfer.getData('text/queue-prompt');
  const itemId = e.dataTransfer.getData('text/queue-id');
  if (text) {
    const sent = await sendToTerminal(text);
    if (sent && itemId && selectedSessionId) {
      try {
        await db.del('promptQueue', Number(itemId));
        loadQueue(selectedSessionId);
      } catch(e) {}
      showToast('SENT', 'Prompt dropped into terminal');
    }
  }
});

// Alert button
document.getElementById('ctrl-alert').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  document.getElementById('alert-modal').classList.remove('hidden');
});

document.getElementById('alert-cancel').addEventListener('click', () => {
  document.getElementById('alert-modal').classList.add('hidden');
});

document.getElementById('alert-confirm').addEventListener('click', async () => {
  document.getElementById('alert-modal').classList.add('hidden');
  if (!selectedSessionId) return;
  const minutes = parseInt(document.getElementById('alert-minutes').value, 10);
  if (!minutes || minutes < 1) return;
  try {
    const now = Date.now();
    await db.put('alerts', {
      sessionId: selectedSessionId,
      thresholdMs: minutes * 60000,
      createdAt: now,
      triggerAt: now + minutes * 60000
    });
    showToast('ALERT SET', `Will alert after ${minutes} minutes`);
    soundManager.play('click');
  } catch(e) {
    showToast('ALERT ERROR', e.message);
  }
});

// ---- Session Title Save (blur/Enter) ----
const detailTitleInput = document.getElementById('detail-title');
if (detailTitleInput) {
  let titleSaveTimeout = null;
  async function saveTitle() {
    const sessionId = detailTitleInput.dataset.sessionId;
    const title = detailTitleInput.value.trim();
    if (!sessionId) return;
    const session = sessionsData.get(sessionId);
    if (session) session.title = title;
    // Update card title display
    const card = document.querySelector(`.session-card[data-session-id="${sessionId}"] .card-title`);
    if (card) {
      card.textContent = title;
      card.style.display = title ? '' : 'none';
    }
    try {
      await fetch(`/api/sessions/${sessionId}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      // Also update IndexedDB
      const s = await db.get('sessions', sessionId);
      if (s) { s.title = title; await db.put('sessions', s); }
    } catch(e) {
      // silent fail
    }
  }
  detailTitleInput.addEventListener('blur', saveTitle);
  detailTitleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      detailTitleInput.blur();
    }
  });
}

// ---- Session Label Save (blur/Enter) ----
const detailLabelInput = document.getElementById('detail-label');

async function saveDetailLabel() {
  if (!detailLabelInput) return;
  const sessionId = detailLabelInput.dataset.sessionId;
  const label = detailLabelInput.value.trim();
  if (!sessionId) return;
  const session = sessionsData.get(sessionId);
  if (session) session.label = label;
  // Update card label badge
  const badge = document.querySelector(`.session-card[data-session-id="${sessionId}"] .card-label-badge`);
  if (badge) {
    badge.textContent = label;
    badge.style.display = label ? '' : 'none';
  }
  // Update chip active states
  updateDetailLabelChipStates(label);
  try {
    await fetch(`/api/sessions/${sessionId}/label`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label })
    });
    // Also update IndexedDB
    const s = await db.get('sessions', sessionId);
    if (s) { s.label = label; await db.put('sessions', s); }
  } catch(e) {
    // silent fail
  }
  // Save to global label list for suggestions
  if (label) {
    try {
      const labels = JSON.parse(localStorage.getItem('sessionLabels') || '[]');
      const idx = labels.indexOf(label);
      if (idx !== -1) labels.splice(idx, 1);
      labels.unshift(label);
      localStorage.setItem('sessionLabels', JSON.stringify(labels.slice(0, 30)));
    } catch(_) {}
  }
}

if (detailLabelInput) {
  detailLabelInput.addEventListener('blur', saveDetailLabel);
  detailLabelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      detailLabelInput.blur();
    }
  });
  // Populate datalist when input is focused
  detailLabelInput.addEventListener('focus', () => {
    const dl = document.getElementById('detail-label-suggestions');
    if (!dl) return;
    dl.innerHTML = '';
    try {
      const labels = JSON.parse(localStorage.getItem('sessionLabels') || '[]');
      for (const lbl of labels) {
        const opt = document.createElement('option');
        opt.value = lbl;
        dl.appendChild(opt);
      }
    } catch(_) {}
  });
}

// ---- Detail Label Quick-Select Chips ----
const DETAIL_LABEL_COLORS = { ONEOFF: '#ff9100', HEAVY: '#ff3355', IMPORTANT: '#aa66ff' };
const DETAIL_LABEL_ICONS = { ONEOFF: '\u{1F525}', HEAVY: '\u2605', IMPORTANT: '\u26A0' };

function updateDetailLabelChipStates(currentLabel) {
  const container = document.getElementById('detail-label-chips');
  if (!container) return;
  container.querySelectorAll('.detail-label-chip').forEach(chip => {
    const isActive = chip.dataset.label === currentLabel;
    chip.classList.toggle('active', isActive);
    const color = DETAIL_LABEL_COLORS[chip.dataset.label];
    if (isActive && color) {
      chip.style.borderColor = color;
      chip.style.color = color;
      chip.style.background = color + '1a';
    } else {
      chip.style.borderColor = '';
      chip.style.color = '';
      chip.style.background = '';
    }
  });
}

function populateDetailLabelChips(session) {
  const container = document.getElementById('detail-label-chips');
  if (!container) return;
  container.innerHTML = '';

  // Built-in labels
  const builtins = ['ONEOFF', 'HEAVY', 'IMPORTANT'];

  // Also include saved custom labels (up to 5)
  let customLabels = [];
  try {
    const saved = JSON.parse(localStorage.getItem('sessionLabels') || '[]');
    customLabels = saved.filter(l => !builtins.includes(l)).slice(0, 5);
  } catch(_) {}

  const allLabels = [...builtins, ...customLabels];
  const currentLabel = session.label || '';

  for (const label of allLabels) {
    const chip = document.createElement('button');
    chip.className = 'detail-label-chip';
    chip.dataset.label = label;

    const icon = DETAIL_LABEL_ICONS[label];
    if (icon) {
      const iconSpan = document.createElement('span');
      iconSpan.className = 'chip-icon';
      iconSpan.textContent = icon;
      chip.appendChild(iconSpan);
    }

    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);

    // Highlight if active
    const isActive = label === currentLabel;
    if (isActive) {
      chip.classList.add('active');
      const color = DETAIL_LABEL_COLORS[label];
      if (color) {
        chip.style.borderColor = color;
        chip.style.color = color;
        chip.style.background = color + '1a';
      }
    }

    chip.addEventListener('click', () => {
      if (!detailLabelInput) return;
      // Toggle: clicking active chip clears the label
      if (detailLabelInput.value.trim() === label) {
        detailLabelInput.value = '';
      } else {
        detailLabelInput.value = label;
      }
      saveDetailLabel();
    });

    container.appendChild(chip);
  }
}

// ---- Detail Panel Resize Handle ----
{
  const handle = document.getElementById('detail-resize-handle');
  const panel = document.getElementById('session-detail-panel');
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    panel.classList.add('resizing');
    handle.classList.add('active');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    const dx = startX - e.clientX;
    const newWidth = Math.max(320, Math.min(window.innerWidth * 0.95, startWidth + dx));
    panel.style.width = newWidth + 'px';
  }

  function onMouseUp() {
    panel.classList.remove('resizing');
    handle.classList.remove('active');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    // Persist width preference
    try { localStorage.setItem('detail-panel-width', panel.style.width); } catch(e) {}
  }

  // Restore saved width
  try {
    const saved = localStorage.getItem('detail-panel-width');
    if (saved) panel.style.width = saved;
  } catch(e) {}
}

// ---- Live Search Filter ----
const liveSearchInput = document.getElementById('live-search');
if (liveSearchInput) {
  liveSearchInput.addEventListener('input', () => {
    const query = liveSearchInput.value.toLowerCase().trim();
    const cards = document.querySelectorAll('.session-card');
    cards.forEach(card => {
      const sid = card.dataset.sessionId;
      const projectName = card.querySelector('.project-name')?.textContent?.toLowerCase() || '';
      const cardTitle = card.querySelector('.card-title')?.textContent?.toLowerCase() || '';

      // Also search prompts and responses
      let matchInContent = false;
      if (query && sid) {
        const session = sessionsData.get(sid);
        if (session) {
          matchInContent = (session.promptHistory || []).some(p => p.text?.toLowerCase().includes(query))
            || (session.responseLog || []).some(r => r.text?.toLowerCase().includes(query));
        }
      }

      if (!query || projectName.includes(query) || cardTitle.includes(query) || matchInContent) {
        card.classList.remove('filtered');
      } else {
        card.classList.add('filtered');
      }
    });

    // If detail panel is open, highlight matches inside it
    if (query && selectedSessionId) {
      highlightInDetailPanel(query);
    } else {
      clearDetailHighlights();
    }
  });
}

function highlightInDetailPanel(query) {
  clearDetailHighlights();
  if (!query) return;

  const tabContents = ['detail-conversation', 'detail-activity-log'];
  let firstMatch = null;
  let matchTab = null;

  for (const containerId of tabContents) {
    const container = document.getElementById(containerId);
    if (!container) continue;

    const entries = container.querySelectorAll('.conv-entry, .activity-entry');
    for (const entry of entries) {
      const text = entry.textContent.toLowerCase();
      if (text.includes(query)) {
        entry.classList.add('search-highlight');
        if (!firstMatch) {
          firstMatch = entry;
          matchTab = containerId === 'detail-conversation' ? 'conversation' : 'activity';
        }
      }
    }
  }

  // Switch to the tab with the first match and scroll to it
  if (firstMatch && matchTab) {
    const tabBtn = document.querySelector(`.detail-tabs .tab[data-tab="${matchTab}"]`);
    if (tabBtn && !tabBtn.classList.contains('active')) {
      document.querySelectorAll('.detail-tabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      tabBtn.classList.add('active');
      document.getElementById(`tab-${matchTab}`).classList.add('active');
    }
    firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function clearDetailHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => el.classList.remove('search-highlight'));
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
