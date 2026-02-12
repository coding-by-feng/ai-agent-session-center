/**
 * @module sessionGroups
 * Visual grouping of session cards. Groups are persisted in localStorage and rendered
 * as collapsible sections with drag-and-drop support for reordering sessions between groups.
 * Enhanced with 12-column CSS Grid layout, resize handles, group drag-reorder, and preset layouts.
 */
import { escapeHtml, escapeAttr, debugLog } from './utils.js';
import { STORAGE_KEYS } from './constants.js';

// ---- Default Groups (seeded on first use) ----
const DEFAULT_GROUPS = [
  { name: 'Priority', order: 0 },
  { name: 'Active', order: 1 },
  { name: 'Background', order: 2 },
  { name: 'Review', order: 3 },
];

function seedDefaultGroups() {
  if (localStorage.getItem(STORAGE_KEYS.GROUPS_SEEDED)) return;
  localStorage.setItem(STORAGE_KEYS.GROUPS_SEEDED, '1');
  const existing = loadGroups();
  if (existing.length > 0) return;
  const groups = DEFAULT_GROUPS.map((g, i) => ({
    id: 'grp-default-' + i,
    name: g.name,
    sessionIds: [],
    order: g.order,
  }));
  saveGroups(groups);
}

// ---- Layout Presets ----
const LAYOUT_PRESETS = {
  '1-col':    { label: '1 Column',   colSpans: [12] },
  '2-col':    { label: '2 Columns',  colSpans: [6, 6] },
  '3-col':    { label: '3 Columns',  colSpans: [4, 4, 4] },
  '1-3-2-3':  { label: '1/3 + 2/3', colSpans: [4, 8] },
  '2-3-1-3':  { label: '2/3 + 1/3', colSpans: [8, 4] },
};

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

// ---- Dashboard Layout (persisted in localStorage) ----

export function loadDashboardLayout() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.DASHBOARD_LAYOUT) || '{}');
  } catch {
    return {};
  }
}

export function saveDashboardLayout(layout) {
  localStorage.setItem(STORAGE_KEYS.DASHBOARD_LAYOUT, JSON.stringify(layout));
}

export function getLayoutPresets() {
  return { ...LAYOUT_PRESETS };
}

export function applyLayoutPreset(presetKey) {
  const preset = LAYOUT_PRESETS[presetKey];
  if (!preset) return;
  const groups = loadGroups();
  if (groups.length === 0) return;
  const spans = preset.colSpans;
  for (let i = 0; i < groups.length; i++) {
    groups[i].colSpan = spans[i % spans.length];
  }
  saveGroups(groups);
  saveDashboardLayout({ preset: presetKey, columns: 12 });
  renderGroups();
  updatePresetButtons(presetKey);
}

// ---- Session Groups (persisted in localStorage) ----
// Structure: [{ id, name, sessionIds: [], layout?, colSpan?: number(3-12), order?: number }, ...]

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
  const maxOrder = groups.reduce((max, g) => Math.max(max, g.order || 0), 0);
  groups.push({ id, name: name || 'New Group', sessionIds: [], order: maxOrder + 1 });
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

// ---- Preset Bar Rendering ----

function renderPresetIcon(presetKey) {
  const preset = LAYOUT_PRESETS[presetKey];
  if (!preset) return '';
  const spans = preset.colSpans;
  const totalCols = 12;
  const svgW = 28;
  const svgH = 16;
  const gap = 1;
  let rects = '';
  let x = 0;
  for (let i = 0; i < spans.length; i++) {
    const w = (spans[i] / totalCols) * svgW - gap;
    rects += `<rect x="${x}" y="0" width="${Math.max(w, 1)}" height="${svgH}" rx="1" fill="currentColor" opacity="0.6"/>`;
    x += (spans[i] / totalCols) * svgW;
  }
  return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

function renderLayoutPresetBar() {
  const bar = document.getElementById('layout-presets');
  if (!bar) return;
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'layout-presets-label';
  label.textContent = 'Layout';
  bar.appendChild(label);

  const savedLayout = loadDashboardLayout();
  const activePreset = savedLayout.preset || null;

  for (const [key, preset] of Object.entries(LAYOUT_PRESETS)) {
    const btn = document.createElement('button');
    btn.className = 'layout-preset-btn';
    btn.dataset.preset = key;
    btn.title = preset.label;
    btn.innerHTML = renderPresetIcon(key);
    if (key === activePreset) btn.classList.add('active');
    btn.addEventListener('click', () => {
      applyLayoutPreset(key);
    });
    bar.appendChild(btn);
  }
}

function updatePresetButtons(activePreset) {
  const bar = document.getElementById('layout-presets');
  if (!bar) return;
  bar.querySelectorAll('.layout-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === activePreset);
  });
}

// ---- Group ColSpan Helpers ----

function applyGroupColSpan(groupEl, colSpan) {
  groupEl.style.gridColumn = 'span ' + (colSpan || 12);
}

// ---- Group Resize ----

function initGroupResize(handle, groupEl, groupId) {
  let startX = 0;
  let startColSpan = 12;
  let containerWidth = 0;

  function onMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    const container = document.getElementById('groups-container');
    if (container) containerWidth = container.getBoundingClientRect().width;
    const groups = loadGroups();
    const g = groups.find(g => g.id === groupId);
    startColSpan = (g && g.colSpan) || 12;
    groupEl.classList.add('resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    if (containerWidth === 0) return;
    const dx = e.clientX - startX;
    const colWidth = containerWidth / 12;
    const deltaCols = Math.round(dx / colWidth);
    let newSpan = startColSpan + deltaCols;
    newSpan = Math.max(3, Math.min(12, newSpan));
    applyGroupColSpan(groupEl, newSpan);
  }

  function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    groupEl.classList.remove('resizing');
    // Calculate final colSpan from current style
    const currentSpan = parseInt(groupEl.style.gridColumn.replace('span ', ''), 10) || 12;
    const groups = loadGroups();
    const g = groups.find(g => g.id === groupId);
    if (g) {
      g.colSpan = currentSpan;
      saveGroups(groups);
    }
    // Set preset to custom since user manually resized
    saveDashboardLayout({ preset: 'custom', columns: 12 });
    updatePresetButtons('custom');
  }

  handle.addEventListener('mousedown', onMouseDown);
}

// ---- Group Drag & Reorder ----

function clearGroupDropIndicators() {
  document.querySelectorAll('.session-group.group-drop-left, .session-group.group-drop-right').forEach(el => {
    el.classList.remove('group-drop-left', 'group-drop-right');
  });
}

function reorderGroups(draggedGroupId, targetGroupId, insertBefore) {
  const groups = loadGroups();
  const draggedIdx = groups.findIndex(g => g.id === draggedGroupId);
  if (draggedIdx === -1) return;
  const [dragged] = groups.splice(draggedIdx, 1);
  let targetIdx = groups.findIndex(g => g.id === targetGroupId);
  if (targetIdx === -1) {
    groups.push(dragged);
  } else {
    if (!insertBefore) targetIdx += 1;
    groups.splice(targetIdx, 0, dragged);
  }
  // Reassign order values
  for (let i = 0; i < groups.length; i++) {
    groups[i].order = i;
  }
  saveGroups(groups);
  renderGroups();
}

// ---- Main Render ----

export function renderGroups() {
  const container = document.getElementById('groups-container');
  if (!container) return;
  const groups = loadGroups();
  // Sort by order
  groups.sort((a, b) => (a.order || 0) - (b.order || 0));
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
          <span class="group-name">${escapeHtml(group.name)}</span>
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
        // Ignore group drags — let group-level handler deal with those
        if (e.dataTransfer.types.includes('application/group-id')) return;
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
        // Ignore group drags
        if (e.dataTransfer.types.includes('application/group-id')) return;
        if (e.target.closest('.session-card')) return; // card handles its own drop
        e.preventDefault();
        groupGrid.classList.remove('drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId) return;
        const card = document.querySelector(`.session-card[data-session-id="${draggedId}"]`);
        if (card) {
          groupGrid.appendChild(card);
          addSessionToGroup(group.id, draggedId);
          updateGroupCounts();
        }
      });
      container.appendChild(groupEl);
    }

    // ---- Apply colSpan ----
    applyGroupColSpan(groupEl, group.colSpan || 12);

    // ---- Resize handle ----
    if (!groupEl.querySelector('.group-resize-handle')) {
      const handle = document.createElement('div');
      handle.className = 'group-resize-handle';
      groupEl.appendChild(handle);
      initGroupResize(handle, groupEl, group.id);
    }

    // ---- Group header drag (for reordering groups) ----
    const header = groupEl.querySelector('.group-header');
    if (!header.dataset.groupDragInit) {
      header.draggable = true;
      header.dataset.groupDragInit = 'true';

      header.addEventListener('dragstart', (e) => {
        // Set group-specific data type to distinguish from card drags
        e.dataTransfer.setData('application/group-id', group.id);
        e.dataTransfer.setData('text/plain', ''); // required for Firefox
        e.dataTransfer.effectAllowed = 'move';
        // Delay adding class so the drag image captures before opacity change
        requestAnimationFrame(() => {
          groupEl.classList.add('group-dragging');
        });
      });

      header.addEventListener('dragend', () => {
        groupEl.classList.remove('group-dragging');
        clearGroupDropIndicators();
      });
    }

    // ---- Group as drop target for other groups ----
    if (!groupEl.dataset.groupDropInit) {
      groupEl.dataset.groupDropInit = 'true';

      groupEl.addEventListener('dragover', (e) => {
        // Only respond to group drags
        if (!e.dataTransfer.types.includes('application/group-id')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        // Show left/right indicator based on mouse position vs midpoint
        const rect = groupEl.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        clearGroupDropIndicators();
        if (e.clientX < midX) {
          groupEl.classList.add('group-drop-left');
        } else {
          groupEl.classList.add('group-drop-right');
        }
      });

      groupEl.addEventListener('dragleave', (e) => {
        if (!groupEl.contains(e.relatedTarget)) {
          groupEl.classList.remove('group-drop-left', 'group-drop-right');
        }
      });

      groupEl.addEventListener('drop', (e) => {
        // Only handle group drops
        if (!e.dataTransfer.types.includes('application/group-id')) return;
        e.preventDefault();
        e.stopPropagation();
        const draggedGroupId = e.dataTransfer.getData('application/group-id');
        if (!draggedGroupId || draggedGroupId === group.id) {
          clearGroupDropIndicators();
          return;
        }
        const rect = groupEl.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midX;
        clearGroupDropIndicators();
        reorderGroups(draggedGroupId, group.id, insertBefore);
      });
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

  // Sort group elements in DOM by order
  const sortedIds = groups.map(g => g.id);
  const groupEls = Array.from(container.querySelectorAll('.session-group'));
  groupEls.sort((a, b) => sortedIds.indexOf(a.id) - sortedIds.indexOf(b.id));
  for (const el of groupEls) {
    container.appendChild(el);
  }

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
  // Prevent duplicate toast for the same session
  const container = document.getElementById('toast-container');
  if (container.querySelector(`.group-assign-toast[data-session-id="${sessionId}"]`)) return;
  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const session = sessionsData.get(sessionId);
  if (!session) return;
  groupAssignToastCount++;
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
        <option value="">Select group...</option>
        ${groupOptions}
        <option value="__new__">+ New Group</option>
      </select>
      <button class="group-dismiss-btn">SKIP</button>
    </div>
    <div class="group-assign-new-row hidden">
      <input type="text" class="group-new-name-input" placeholder="Group name...">
      <button class="group-create-btn">CREATE</button>
    </div>
  `;
  const sel = toast.querySelector('.group-assign-select');
  const newRow = toast.querySelector('.group-assign-new-row');
  function dismissToast() {
    groupAssignToastCount--;
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }
  sel.addEventListener('change', () => {
    const groupId = sel.value;
    if (groupId === '__new__') {
      newRow.classList.remove('hidden');
      toast.querySelector('.group-new-name-input').focus();
    } else if (groupId) {
      assignSessionToGroupAndMove(groupId, sessionId);
      if (_showToast) _showToast('GROUP', 'Assigned to group');
      dismissToast();
    }
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
  // Seed default groups on first ever launch
  seedDefaultGroups();

  // Make ungrouped grid a drop zone to pull cards out of groups
  const grid = document.getElementById('sessions-grid');
  grid.addEventListener('dragover', (e) => {
    // Ignore group drags
    if (e.dataTransfer.types.includes('application/group-id')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    grid.classList.add('drag-over');
  });
  grid.addEventListener('dragleave', (e) => {
    if (!grid.contains(e.relatedTarget)) grid.classList.remove('drag-over');
  });
  grid.addEventListener('drop', (e) => {
    // Ignore group drags
    if (e.dataTransfer.types.includes('application/group-id')) return;
    if (e.target.closest('.session-card')) return;
    e.preventDefault();
    grid.classList.remove('drag-over');
    const draggedId = e.dataTransfer.getData('text/plain');
    if (!draggedId) return;
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

  // Render layout preset bar and apply saved layout
  renderLayoutPresetBar();
  const savedLayout = loadDashboardLayout();
  if (savedLayout.preset && savedLayout.preset !== 'custom') {
    // Re-apply saved preset to ensure colSpans are in sync
    const groups = loadGroups();
    const preset = LAYOUT_PRESETS[savedLayout.preset];
    if (preset && groups.length > 0) {
      const spans = preset.colSpans;
      let needsUpdate = false;
      for (let i = 0; i < groups.length; i++) {
        const expectedSpan = spans[i % spans.length];
        if (groups[i].colSpan !== expectedSpan) {
          groups[i].colSpan = expectedSpan;
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        saveGroups(groups);
        renderGroups();
      }
    }
  }

}
