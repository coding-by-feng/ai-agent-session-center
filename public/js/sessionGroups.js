/**
 * @module sessionGroups
 * Visual grouping of session cards. Groups are persisted in localStorage and rendered
 * as collapsible sections with drag-and-drop support for reordering sessions between groups.
 */
import * as settingsManager from './settingsManager.js';
import { escapeHtml, escapeAttr, debugLog } from './utils.js';
import { STORAGE_KEYS } from './constants.js';

// ---- Internal helpers ----

// These will be injected via init() to avoid circular imports
let _getSelectedSessionId = null;
let _getSessionsData = null;
let _showToast = null;

export function initDeps({ getSelectedSessionId, getSessionsData, showToast }) {
  _getSelectedSessionId = getSelectedSessionId;
  _getSessionsData = getSessionsData;
  _showToast = showToast;
}

// ---- Session Groups (persisted in localStorage) ----
// Structure: [{ id, name, sessionIds: [], layout? }, ...]

export function loadGroups() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_GROUPS) || '[]'); } catch { return []; }
}

export function saveGroups(groups) {
  localStorage.setItem(STORAGE_KEYS.SESSION_GROUPS, JSON.stringify(groups));
}

export function findGroupForSession(sessionId) {
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

export function deleteGroup(groupId) {
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

export function addSessionToGroup(groupId, sessionId) {
  const groups = loadGroups();
  // Remove from any existing group first
  for (const g of groups) {
    g.sessionIds = g.sessionIds.filter(id => id !== sessionId);
  }
  const target = groups.find(g => g.id === groupId);
  if (target) target.sessionIds.push(sessionId);
  saveGroups(groups);
}

export function removeSessionFromGroup(sessionId) {
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
      const groupLayoutIcon = group.layout === 'horizontal' ? '&#9776;' : '&#9638;';
      groupEl.innerHTML = `
        <div class="group-header">
          <span class="group-collapse" title="Collapse/expand">&#9660;</span>
          <span class="group-name">${escapeHtml(group.name)}</span>
          <span class="group-count">0</span>
          <button class="group-layout-toggle" title="Toggle layout">${groupLayoutIcon}</button>
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
      // Per-group layout toggle
      groupEl.querySelector('.group-layout-toggle').addEventListener('click', () => {
        const groups = loadGroups();
        const g = groups.find(g => g.id === group.id);
        if (!g) return;
        const globalLayout = settingsManager.get('groupLayout') || 'vertical';
        const currentLayout = g.layout || globalLayout;
        const newLayout = currentLayout === 'horizontal' ? 'vertical' : 'horizontal';
        g.layout = newLayout;
        saveGroups(groups);
        const grid = groupEl.querySelector('.group-grid');
        grid.dataset.layoutOverride = 'true';
        grid.classList.toggle('layout-horizontal', newLayout === 'horizontal');
        const toggleBtn = groupEl.querySelector('.group-layout-toggle');
        toggleBtn.innerHTML = newLayout === 'horizontal' ? '&#9776;' : '&#9638;';
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
  // Apply layout classes (per-group overrides + global fallback)
  const globalLayout = settingsManager.get('groupLayout') || 'vertical';
  for (const group of groups) {
    const grid = document.querySelector(`#${group.id} .group-grid`);
    if (!grid) continue;
    if (group.layout) {
      grid.dataset.layoutOverride = 'true';
      grid.classList.toggle('layout-horizontal', group.layout === 'horizontal');
    } else {
      delete grid.dataset.layoutOverride;
      grid.classList.toggle('layout-horizontal', globalLayout === 'horizontal');
    }
  }
  const sessionsGrid = document.getElementById('sessions-grid');
  if (sessionsGrid) sessionsGrid.classList.toggle('layout-horizontal', globalLayout === 'horizontal');

  updateGroupCounts();
  refreshAllGroupSelects();
}

export function updateGroupCounts() {
  document.querySelectorAll('.session-group').forEach(groupEl => {
    const count = groupEl.querySelectorAll('.session-card').length;
    const countEl = groupEl.querySelector('.group-count');
    if (countEl) countEl.textContent = count;
  });
}

export function refreshAllGroupSelects() {
  // Update the detail panel group select if it exists
  const sel = document.getElementById('detail-group-select');
  if (!sel) return;
  const groups = loadGroups();
  const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
  const currentGroup = sid ? groups.find(g => g.sessionIds.includes(sid)) : null;
  const currentValue = currentGroup ? currentGroup.id : '';
  sel.innerHTML = '<option value="">No group</option>' +
    groups.map(g => `<option value="${escapeAttr(g.id)}"${g.id === currentValue ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('') +
    '<option value="__new__">+ New Group</option>';
}

export function updateCardGroupBadge(sessionId) {
  const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
  if (!card) return;
  const badgeEl = card.querySelector('.card-group-badge');
  if (!badgeEl) return;
  const group = findGroupForSession(sessionId);
  if (group) {
    badgeEl.textContent = group.name.length > 10 ? group.name.substring(0, 10) + '..' : group.name;
    badgeEl.classList.add('has-group');
    badgeEl.title = `Group: ${group.name} (click to change)`;
  } else {
    badgeEl.textContent = '+';
    badgeEl.classList.remove('has-group');
    badgeEl.title = 'Assign group';
  }
}

export function assignSessionToGroupAndMove(groupId, sessionId) {
  addSessionToGroup(groupId, sessionId);
  const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
  if (card) {
    const groupGrid = document.querySelector(`#${groupId} .group-grid`);
    if (groupGrid) groupGrid.appendChild(card);
  }
  updateGroupCounts();
  refreshAllGroupSelects();
  updateCardGroupBadge(sessionId);
}

export function showCardGroupDropdown(anchorEl, sessionId) {
  document.querySelector('.card-group-dropdown')?.remove();
  const groups = loadGroups();
  const currentGroup = findGroupForSession(sessionId);
  const dropdown = document.createElement('div');
  dropdown.className = 'card-group-dropdown';
  let html = '';
  if (currentGroup) {
    html += '<div class="cgd-item cgd-remove" data-value="">Remove from group</div>';
  }
  for (const g of groups) {
    const active = currentGroup && currentGroup.id === g.id ? ' cgd-active' : '';
    html += `<div class="cgd-item${active}" data-value="${g.id}">${escapeHtml(g.name)}</div>`;
  }
  html += '<div class="cgd-divider"></div>';
  html += '<div class="cgd-item cgd-new">+ New Group</div>';
  dropdown.innerHTML = html;
  const rect = anchorEl.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.zIndex = '500';
  if (rect.bottom + 210 > window.innerHeight) {
    dropdown.style.top = `${rect.top - 4}px`;
    dropdown.style.transform = 'translateY(-100%)';
  }
  document.body.appendChild(dropdown);
  dropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.cgd-item');
    if (!item) return;
    if (item.classList.contains('cgd-new')) {
      dropdown.remove();
      const name = prompt('Group name:');
      if (name && name.trim()) {
        const newGroupId = createGroup(name.trim());
        assignSessionToGroupAndMove(newGroupId, sessionId);
        if (_showToast) _showToast('GROUP', `Created "${name.trim()}" and assigned`);
      }
    } else {
      const groupId = item.dataset.value;
      if (groupId) {
        assignSessionToGroupAndMove(groupId, sessionId);
        if (_showToast) _showToast('GROUP', 'Moved to group');
      } else {
        removeSessionFromGroup(sessionId);
        const card2 = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
        if (card2) document.getElementById('sessions-grid').appendChild(card2);
        updateGroupCounts();
        refreshAllGroupSelects();
        updateCardGroupBadge(sessionId);
        if (_showToast) _showToast('GROUP', 'Removed from group');
      }
      dropdown.remove();
    }
  });
  setTimeout(() => {
    document.addEventListener('click', function handler(ev) {
      if (!dropdown.contains(ev.target) && ev.target !== anchorEl) {
        dropdown.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

let groupAssignToastCount = 0;
const MAX_GROUP_ASSIGN_TOASTS = 3;

export function showGroupAssignToast(sessionId) {
  if (groupAssignToastCount >= MAX_GROUP_ASSIGN_TOASTS) return;
  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const session = sessionsData.get(sessionId);
  if (!session) return;
  groupAssignToastCount++;
  const container = document.getElementById('toast-container');
  const groups = loadGroups();
  const groupOptions = groups.map(g =>
    `<option value="${g.id}">${escapeHtml(g.name)}</option>`
  ).join('');
  const title = session.title || session.projectName || 'New session';
  const toast = document.createElement('div');
  toast.className = 'toast group-assign-toast';
  toast.dataset.sessionId = sessionId;
  toast.innerHTML = `
    <button class="toast-close">&times;</button>
    <div class="toast-title">ASSIGN GROUP</div>
    <div class="toast-msg">${escapeHtml(title)}</div>
    <div class="group-assign-actions">
      <select class="group-assign-select">
        <option value="">No group</option>
        ${groupOptions}
        <option value="__new__">+ New Group</option>
      </select>
      <button class="group-assign-btn">ASSIGN</button>
      <button class="group-dismiss-btn">SKIP</button>
    </div>
    <div class="group-assign-new-row hidden">
      <input type="text" class="group-new-name-input" placeholder="Group name...">
      <button class="group-create-btn">CREATE</button>
    </div>
  `;
  const sel = toast.querySelector('.group-assign-select');
  const newRow = toast.querySelector('.group-assign-new-row');
  sel.addEventListener('change', () => {
    newRow.classList.toggle('hidden', sel.value !== '__new__');
    if (sel.value === '__new__') toast.querySelector('.group-new-name-input').focus();
  });
  function dismissToast() {
    groupAssignToastCount--;
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }
  toast.querySelector('.group-assign-btn').addEventListener('click', () => {
    const groupId = sel.value;
    if (groupId && groupId !== '__new__') {
      assignSessionToGroupAndMove(groupId, sessionId);
      if (_showToast) _showToast('GROUP', 'Assigned to group');
    }
    dismissToast();
  });
  toast.querySelector('.group-create-btn').addEventListener('click', () => {
    const name = toast.querySelector('.group-new-name-input').value.trim();
    if (!name) return;
    const newGroupId = createGroup(name);
    assignSessionToGroupAndMove(newGroupId, sessionId);
    if (_showToast) _showToast('GROUP', `Created "${name}" and assigned`);
    dismissToast();
  });
  toast.querySelector('.group-new-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') toast.querySelector('.group-create-btn').click();
  });
  toast.querySelector('.group-dismiss-btn').addEventListener('click', dismissToast);
  toast.querySelector('.toast-close').addEventListener('click', dismissToast);
  container.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) dismissToast(); }, 15000);
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

  // Listen for global layout changes and re-apply
  settingsManager.onChange('groupLayout', (layout) => {
    settingsManager.applyGroupLayout(layout);
  });
}
