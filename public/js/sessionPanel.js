import * as soundManager from './soundManager.js';

const mutedSessions = new Set();
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
let selectedSessionId = null;
export function getSelectedSessionId() { return selectedSessionId; }
export function getSessionsData() { return sessionsData; }
export { deselectSession };

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

export function createOrUpdateCard(session) {
  sessionsData.set(session.sessionId, session);

  let card = document.querySelector(`.session-card[data-session-id="${session.sessionId}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.sessionId;
    card.draggable = true;
    card.innerHTML = `
      <button class="close-btn" title="Dismiss card">&times;</button>
      <button class="pin-btn" title="Pin to top">&#9650;</button>
      <button class="open-editor-btn" title="Open in VS Code">&#9998;</button>
      <button class="summarize-card-btn" title="Summarize & Archive">&#8681;AI</button>
      <button class="mute-btn" title="Mute sounds">&#9835;</button>
      <div class="robot-viewport"></div>
      <div class="card-info">
        <div class="card-title" title="Double-click to rename"></div>
        <div class="card-header">
          <span class="project-name"></span>
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
    card.addEventListener('click', (e) => {
      selectSession(session.sessionId);
    });
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
    });
    // Close button — dismiss card from live view
    card.querySelector('.close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const sid = session.sessionId;
      card.style.transition = 'opacity 0.3s, transform 0.3s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.9)';
      setTimeout(() => {
        removeCard(sid);
        // Also remove the robot
        const event = new CustomEvent('card-dismissed', { detail: { sessionId: sid } });
        document.dispatchEvent(event);
      }, 300);
    });
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

    // Open in editor button
    card.querySelector('.open-editor-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const sid = session.sessionId;
      const s = sessionsData.get(sid);
      const path = s?.projectPath;
      if (!path) { showToast('OPEN', 'No project path available'); return; }
      try {
        const resp = await fetch(`/api/sessions/${sid}/open-editor`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (!data.ok) showToast('OPEN FAILED', data.error || 'Unknown error');
      } catch(err) {
        showToast('OPEN ERROR', err.message);
      }
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
        const resp = await fetch(`/api/sessions/${sid}/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (data.ok) {
          const s = sessionsData.get(sid);
          if (s) { s.archived = 1; s.summary = data.summary; }
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

      const save = () => {
        titleEl.contentEditable = 'false';
        titleEl.classList.remove('editing');
        const newTitle = titleEl.textContent.trim();
        if (newTitle) {
          fetch(`/api/sessions/${session.sessionId}/title`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle })
          });
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
  const activeStatuses = new Set(['working', 'prompting', 'approval']);
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
  const statusLabel = session.status === 'approval' ? 'APPROVAL NEEDED'
    : session.status === 'waiting' ? 'WAITING'
    : session.status.toUpperCase();
  badge.textContent = statusLabel;
  badge.className = `status-badge ${session.status}`;

  // Update approval banner with detail about what needs approval
  const banner = card.querySelector('.waiting-banner');
  if (banner) {
    banner.textContent = session.waitingDetail || 'NEEDS YOUR APPROVAL';
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
    }, 500);
  } else {
    card.remove();
    sessionsData.delete(sessionId);
    if (selectedSessionId === sessionId) deselectSession();
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
  toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('fade-out'); setTimeout(() => toast.remove(), 300); }, 5000);
}

async function loadNotes(sessionId) {
  const list = document.getElementById('notes-list');
  try {
    const resp = await fetch(`/api/sessions/${sessionId}/notes`);
    const { notes } = await resp.json();
    list.innerHTML = notes.map(n => `
      <div class="note-entry">
        <div class="note-meta">
          <span class="note-time">${formatTime(n.created_at)}</span>
          <button class="note-delete" data-note-id="${n.id}">DELETE</button>
        </div>
        <div class="note-text">${escapeHtml(n.text)}</div>
      </div>
    `).join('') || '<div class="tab-empty">No notes yet</div>';
  } catch(e) {
    list.innerHTML = '<div class="tab-empty">Failed to load notes</div>';
  }
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
}

function populateDetailPanel(session) {
  document.getElementById('detail-project-name').textContent = session.projectName;
  const badge = document.getElementById('detail-status-badge');
  const detailLabel = session.status === 'approval' ? 'APPROVAL NEEDED'
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

  // Prompt history tab (newest first)
  const promptHist = document.getElementById('detail-prompt-history');
  const prompts = (session.promptHistory || []).slice().reverse();
  promptHist.innerHTML = prompts.map(p => `
    <div class="prompt-entry">
      <span class="prompt-time">${formatTime(p.timestamp)}</span>
      <div class="prompt-text">${escapeHtml(p.text)}</div>
    </div>
  `).join('');

  // Response history tab
  const responseHist = document.getElementById('detail-response-history');
  const responses = session.responseLog || [];
  responseHist.innerHTML = responses.length > 0
    ? responses.map(r => `
      <div class="response-entry">
        <span class="response-time">${formatTime(r.timestamp)}</span>
        <div class="response-text">${escapeHtml(r.text)}</div>
      </div>
    `).join('')
    : '<div class="tab-empty">Responses will appear as the session progresses</div>';

  // Tool log tab
  const toolLog = document.getElementById('detail-tool-log');
  toolLog.innerHTML = (session.toolLog || []).map(t => `
    <div class="tool-entry">
      <span class="tool-time">${formatTime(t.timestamp)}</span>
      <span class="tool-name-badge">${escapeHtml(t.tool)}</span>
      <span class="tool-detail">${escapeHtml(t.input)}</span>
    </div>
  `).join('');

  // Events tab
  const eventsLog = document.getElementById('detail-events-log');
  eventsLog.innerHTML = (session.events || []).map(e => `
    <div class="event-entry">
      <span class="event-time">${formatTime(e.timestamp)}</span>
      <span class="event-type">${escapeHtml(e.type)}</span>
      <span class="event-detail">${escapeHtml(e.detail)}</span>
    </div>
  `).join('');

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

  // Load notes
  loadNotes(session.sessionId);
  // Update archive button
  const archBtn = document.getElementById('ctrl-archive');
  if (archBtn) archBtn.textContent = session.archived ? 'UNARCHIVE' : 'ARCHIVE';

  // Detect session source and update prompt input
  updatePromptSource(session.sessionId, session.source);
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
  const resp = await fetch(`/api/sessions/${sessionId}/detail`);
  const data = await resp.json();

  // Populate detail header
  document.getElementById('detail-project-name').textContent = data.session.project_name;
  const badge = document.getElementById('detail-status-badge');
  badge.textContent = data.session.status.toUpperCase();
  badge.className = `status-badge ${data.session.status}`;
  document.getElementById('detail-model').textContent = data.session.model || '';
  const duration = data.session.ended_at
    ? formatDuration(data.session.ended_at - data.session.started_at)
    : formatDuration(Date.now() - data.session.started_at);
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
    charSelect.value = data.session.character_model || '';
    charSelect.dataset.sessionId = sessionId;
  }
  updateDetailCharPreview(
    data.session.character_model || '',
    data.session.status,
    data.session.accent_color || null
  );

  // Populate prompt history tab
  document.getElementById('detail-prompt-history').innerHTML = (data.prompts || []).map(p => `
    <div class="prompt-entry">
      <span class="prompt-time">${formatTime(p.timestamp)}</span>
      <div class="prompt-text">${escapeHtml(p.text)}</div>
    </div>
  `).join('') || '<div class="tab-empty">No prompts recorded</div>';

  // Populate response history tab
  document.getElementById('detail-response-history').innerHTML = (data.responses || []).map(r => `
    <div class="response-entry">
      <span class="response-time">${formatTime(r.timestamp)}</span>
      <div class="response-text">${escapeHtml(r.text_excerpt)}</div>
    </div>
  `).join('') || '<div class="tab-empty">No responses recorded</div>';

  // Populate tool log tab
  document.getElementById('detail-tool-log').innerHTML = (data.tool_calls || []).map(t => `
    <div class="tool-entry">
      <span class="tool-time">${formatTime(t.timestamp)}</span>
      <span class="tool-name-badge">${escapeHtml(t.tool_name)}</span>
      <span class="tool-detail">${escapeHtml(t.tool_input_summary)}</span>
    </div>
  `).join('') || '<div class="tab-empty">No tool calls recorded</div>';

  // Populate events tab
  document.getElementById('detail-events-log').innerHTML = (data.events || []).map(e => `
    <div class="event-entry">
      <span class="event-time">${formatTime(e.timestamp)}</span>
      <span class="event-type">${escapeHtml(e.event_type)}</span>
      <span class="event-detail">${escapeHtml(e.detail)}</span>
    </div>
  `).join('') || '<div class="tab-empty">No events recorded</div>';

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
  // Update archive button text
  const archBtn = document.getElementById('ctrl-archive');
  if (archBtn) archBtn.textContent = data.session.archived ? 'UNARCHIVE' : 'ARCHIVE';

  // Detect session source and update prompt input
  updatePromptSource(sessionId, data.session.source);

  // Show overlay
  document.getElementById('session-detail-overlay').classList.remove('hidden');
}

// Detect session source (vscode/terminal) and update prompt input UI
async function updatePromptSource(sessionId, knownSource) {
  const input = document.getElementById('detail-prompt-input');
  const sendBtn = document.getElementById('detail-prompt-send');
  if (!input || !sendBtn) return;

  let source = knownSource;
  if (!source || source === 'unknown' || source === 'hook') {
    try {
      const resp = await fetch(`/api/sessions/${sessionId}/source`);
      const data = await resp.json();
      source = data.source;
      // Cache in sessionsData
      const s = sessionsData.get(sessionId);
      if (s) s.source = source;
    } catch(e) { source = 'unknown'; }
  }

  if (source === 'vscode') {
    input.placeholder = 'Type prompt to send to VS Code... (Enter to send)';
    sendBtn.textContent = 'SEND TO VSCODE';
  } else if (source === 'terminal') {
    input.placeholder = 'Type prompt to send to Terminal... (Enter to send)';
    sendBtn.textContent = 'SEND TO TERMINAL';
  } else {
    input.placeholder = 'Type prompt to send to session... (Enter to send)';
    sendBtn.textContent = 'SEND';
  }
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

    // Save to server
    try {
      await fetch(`/api/sessions/${sessionId}/character-model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model })
      });
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
});

// ---- Control Button Handlers ----

// Send prompt to session
async function sendPromptToSession() {
  const input = document.getElementById('detail-prompt-input');
  const btn = document.getElementById('detail-prompt-send');
  const text = input.value.trim();
  if (!text || !selectedSessionId) return;
  btn.disabled = true;
  btn.textContent = 'SENDING...';
  btn.classList.add('sending');
  try {
    const resp = await fetch(`/api/sessions/${selectedSessionId}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text })
    });
    const data = await resp.json();
    if (data.ok) {
      input.value = '';
      input.style.height = 'auto';
      const methodNames = {
        iterm2: 'via iTerm2', terminal: 'via Terminal.app',
        vscode: 'via VS Code',
        xdotool: 'via xdotool', 'xdotool-paste': 'via xdotool',
        powershell: 'via PowerShell', 'powershell-paste': 'via PowerShell'
      };
      const via = methodNames[data.method] || '';
      showToast('PROMPT SENT', `Typed into session ${via}`);
    } else if (data.fallback === 'clipboard') {
      // Backend couldn't inject keystrokes — copy to clipboard as fallback
      const session = sessionsData.get(selectedSessionId);
      const src = session?.source === 'vscode' ? 'VS Code' : 'your session';
      try {
        await navigator.clipboard.writeText(text);
        input.value = '';
        input.style.height = 'auto';
        showToast('COPIED', `Paste into ${src} with Cmd+V`);
      } catch(clipErr) {
        showToast('SEND FAILED', data.error || 'Could not send or copy prompt');
      }
    } else {
      showToast('SEND FAILED', data.error || 'Unknown error');
    }
  } catch(e) {
    showToast('SEND ERROR', e.message);
  }
  btn.disabled = false;
  btn.textContent = 'SEND';
  btn.classList.remove('sending');
}

document.getElementById('detail-prompt-send').addEventListener('click', sendPromptToSession);

document.getElementById('detail-prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPromptToSession();
  }
});

// Auto-resize textarea
document.getElementById('detail-prompt-input').addEventListener('input', (e) => {
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
});

// Open in editor button (detail panel)
document.getElementById('ctrl-open-editor').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  try {
    const resp = await fetch(`/api/sessions/${selectedSessionId}/open-editor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (data.ok) {
      showToast('EDITOR', 'Opening in VS Code...');
    } else {
      showToast('OPEN FAILED', data.error || 'Unknown error');
    }
  } catch(err) {
    showToast('OPEN ERROR', err.message);
  }
});

// Kill button
document.getElementById('ctrl-kill').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const session = sessionsData.get(selectedSessionId);
  const msg = document.getElementById('kill-modal-msg');
  msg.textContent = `Kill session for "${session ? session.projectName : selectedSessionId}"? This will send SIGTERM to the Claude process.`;
  document.getElementById('kill-modal').classList.remove('hidden');
});

document.getElementById('kill-cancel').addEventListener('click', () => {
  document.getElementById('kill-modal').classList.add('hidden');
});

document.getElementById('kill-confirm').addEventListener('click', async () => {
  document.getElementById('kill-modal').classList.add('hidden');
  if (!selectedSessionId) return;
  try {
    const resp = await fetch(`/api/sessions/${selectedSessionId}/kill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    });
    const data = await resp.json();
    if (data.ok) {
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

// Archive button
document.getElementById('ctrl-archive').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const session = sessionsData.get(selectedSessionId);
  const newArchived = !(session && session.archived);
  try {
    await fetch(`/api/sessions/${selectedSessionId}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: newArchived })
    });
    if (session) session.archived = newArchived ? 1 : 0;
    e.target.textContent = newArchived ? 'UNARCHIVE' : 'ARCHIVE';
    showToast('ARCHIVE', newArchived ? 'Session archived' : 'Session unarchived');
  } catch(err) {
    showToast('ARCHIVE ERROR', err.message);
  }
});

// Summarize & archive button (detail panel)
document.getElementById('ctrl-summarize').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'SUMMARIZING...';
  try {
    const resp = await fetch(`/api/sessions/${selectedSessionId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await resp.json();
    if (data.ok) {
      const session = sessionsData.get(selectedSessionId);
      if (session) { session.archived = 1; session.summary = data.summary; }
      // Update summary tab content
      const summaryEl = document.getElementById('summary-content');
      if (summaryEl) {
        summaryEl.innerHTML = `<div class="summary-text">${escapeHtml(data.summary).replace(/\n/g, '<br>')}</div>`;
      }
      // Switch to summary tab
      document.querySelectorAll('.detail-tabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      const summaryTab = document.querySelector('.detail-tabs .tab[data-tab="summary"]');
      if (summaryTab) summaryTab.classList.add('active');
      document.getElementById('tab-summary').classList.add('active');
      // Update archive button
      const archBtn = document.getElementById('ctrl-archive');
      if (archBtn) archBtn.textContent = 'UNARCHIVE';
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
});

// Export button
document.getElementById('ctrl-export').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!selectedSessionId) return;
  const a = document.createElement('a');
  a.href = `/api/sessions/${selectedSessionId}/export`;
  a.download = `session-${selectedSessionId}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('EXPORT', 'Downloading session transcript...');
});

// Notes button — switch to notes tab
document.getElementById('ctrl-notes').addEventListener('click', (e) => {
  e.stopPropagation();
  document.querySelectorAll('.detail-tabs .tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
  const notesTab = document.querySelector('.detail-tabs .tab[data-tab="notes"]');
  if (notesTab) notesTab.classList.add('active');
  document.getElementById('tab-notes').classList.add('active');
});

// Save note
document.getElementById('save-note').addEventListener('click', async () => {
  if (!selectedSessionId) return;
  const textarea = document.getElementById('note-textarea');
  const text = textarea.value.trim();
  if (!text) return;
  try {
    await fetch(`/api/sessions/${selectedSessionId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
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
    await fetch(`/api/sessions/${selectedSessionId}/notes/${noteId}`, { method: 'DELETE' });
    loadNotes(selectedSessionId);
  } catch(e) {
    showToast('DELETE ERROR', e.message);
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
    await fetch(`/api/sessions/${selectedSessionId}/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold_ms: minutes * 60000 })
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

  const tabContents = ['detail-prompt-history', 'detail-response-history', 'detail-tool-log'];
  let firstMatch = null;
  let matchTab = null;

  for (const containerId of tabContents) {
    const container = document.getElementById(containerId);
    if (!container) continue;

    const entries = container.querySelectorAll('.prompt-entry, .response-entry, .tool-entry');
    for (const entry of entries) {
      const text = entry.textContent.toLowerCase();
      if (text.includes(query)) {
        entry.classList.add('search-highlight');
        if (!firstMatch) {
          firstMatch = entry;
          matchTab = containerId === 'detail-prompt-history' ? 'prompts'
            : containerId === 'detail-response-history' ? 'responses'
            : 'tools';
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
        await fetch(`/api/sessions/${sessionId}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: true })
        });
        session.archived = 1;
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
