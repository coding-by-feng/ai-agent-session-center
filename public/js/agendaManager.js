/**
 * @module agendaManager
 * Project-level agenda tool. Manages agenda items organized by project with
 * priority, status, tags, due dates, and notes. Bridges to per-session prompt
 * queues via push-to-session. Renders both the global Agenda view and the
 * per-session Agenda tab in the detail panel.
 */
import * as db from './browserDb.js';
import { escapeHtml } from './utils.js';
import { AGENDA_PRIORITY, AGENDA_STATUS, AGENDA_TAGS } from './constants.js';

let _showToast = null;
let _getSelectedSessionId = null;
let _getSessionsData = null;

export function initDeps({ showToast, getSelectedSessionId, getSessionsData }) {
  _showToast = showToast;
  _getSelectedSessionId = getSelectedSessionId;
  _getSessionsData = getSessionsData;
}

// ---- Filter state ----
let _filters = { project: '', status: '', priority: '', tag: '' };

// ---- Global Agenda View ----

export async function renderAgendaView() {
  const content = document.getElementById('agenda-view-content');
  const stats = document.getElementById('agenda-view-stats');
  if (!content) return;

  content.innerHTML = '<div class="tab-empty">Loading agenda...</div>';

  await populateProjectFilter();
  const items = await db.getAgendaItems(_filters);

  // Stats
  if (stats) {
    const totalCount = items.length;
    const todoCount = items.filter(i => i.status === 'todo').length;
    const inProgressCount = items.filter(i => i.status === 'in-progress').length;
    const doneCount = items.filter(i => i.status === 'done').length;
    const blockedCount = items.filter(i => i.status === 'blocked').length;
    stats.innerHTML = `
      <span class="agenda-stat">${totalCount} item${totalCount !== 1 ? 's' : ''}</span>
      <span class="agenda-stat-sep">|</span>
      <span class="agenda-stat todo">${todoCount} todo</span>
      <span class="agenda-stat in-progress">${inProgressCount} active</span>
      <span class="agenda-stat done">${doneCount} done</span>
      ${blockedCount > 0 ? `<span class="agenda-stat blocked">${blockedCount} blocked</span>` : ''}
    `;
  }

  if (items.length === 0 && !_filters.project && !_filters.status && !_filters.priority && !_filters.tag) {
    content.innerHTML = `<div class="tab-empty">
      No agenda items yet<br>
      <span class="tab-empty-hint">Press <kbd>N</kbd> or click ADD ITEM to create your first agenda item</span>
    </div>`;
    return;
  }

  if (items.length === 0) {
    content.innerHTML = '<div class="tab-empty">No items match current filters</div>';
    return;
  }

  // Group by project
  const grouped = {};
  for (const item of items) {
    const proj = item.project || 'Unassigned';
    if (!grouped[proj]) grouped[proj] = [];
    grouped[proj].push(item);
  }

  let html = '';
  for (const [project, projectItems] of Object.entries(grouped)) {
    const todoCount = projectItems.filter(i => i.status === 'todo').length;
    const activeCount = projectItems.filter(i => i.status === 'in-progress').length;
    html += `<div class="agenda-project-group" data-project="${escapeHtml(project)}">
      <div class="agenda-project-header">
        <span class="agenda-project-name">${escapeHtml(project)}</span>
        <span class="agenda-project-counts">${todoCount} todo, ${activeCount} active</span>
        <button class="agenda-project-collapse" title="Toggle collapse">&#9660;</button>
      </div>
      <div class="agenda-project-items">`;

    for (const item of projectItems) {
      html += renderAgendaItem(item);
    }

    html += '</div></div>';
  }

  content.innerHTML = html;
  wireAgendaItemEvents(content);
  wireAgendaDrag(content);
}

function renderAgendaItem(item) {
  const priorityClass = `priority-${item.priority.toLowerCase()}`;
  const statusClass = `status-${item.status}`;
  const overdue = item.dueDate && item.dueDate < Date.now() && item.status !== 'done';
  const dueDateStr = item.dueDate ? formatDate(item.dueDate) : '';
  const tagsHtml = (item.tags || []).map(t =>
    `<span class="agenda-tag tag-${t}">${t}</span>`
  ).join('');

  return `<div class="agenda-item ${priorityClass} ${statusClass}${overdue ? ' overdue' : ''}" draggable="true" data-agenda-id="${item.id}">
    <div class="agenda-item-left">
      <button class="agenda-status-toggle" data-agenda-id="${item.id}" data-status="${item.status}" title="Cycle status">
        <span class="agenda-status-dot"></span>
      </button>
      <span class="agenda-priority-badge">${item.priority}</span>
    </div>
    <div class="agenda-item-body">
      <div class="agenda-item-text">${escapeHtml(item.text)}</div>
      <div class="agenda-item-meta">
        ${tagsHtml}
        ${dueDateStr ? `<span class="agenda-due${overdue ? ' overdue' : ''}">${dueDateStr}</span>` : ''}
        ${item.notes ? '<span class="agenda-has-notes" title="Has notes">&#128221;</span>' : ''}
      </div>
    </div>
    <div class="agenda-item-actions">
      <button class="agenda-push" data-agenda-id="${item.id}" title="Push to session queue">PUSH</button>
      <button class="agenda-edit" data-agenda-id="${item.id}" title="Edit item">EDIT</button>
      <button class="agenda-delete" data-agenda-id="${item.id}" title="Delete">DEL</button>
    </div>
  </div>`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (days < 0) return `${dateStr} (${Math.abs(days)}d overdue)`;
  if (days === 0) return `${dateStr} (today)`;
  if (days === 1) return `${dateStr} (tomorrow)`;
  return `${dateStr} (${days}d)`;
}

function wireAgendaItemEvents(container) {
  container.addEventListener('click', async (e) => {
    const statusBtn = e.target.closest('.agenda-status-toggle');
    const pushBtn = e.target.closest('.agenda-push');
    const editBtn = e.target.closest('.agenda-edit');
    const deleteBtn = e.target.closest('.agenda-delete');
    const collapseBtn = e.target.closest('.agenda-project-collapse');

    if (collapseBtn) {
      const group = collapseBtn.closest('.agenda-project-group');
      group?.classList.toggle('collapsed');
      return;
    }

    if (statusBtn) {
      const id = Number(statusBtn.dataset.agendaId);
      const current = statusBtn.dataset.status;
      const cycle = ['todo', 'in-progress', 'done', 'blocked'];
      const nextIdx = (cycle.indexOf(current) + 1) % cycle.length;
      await db.updateAgendaItem(id, { status: cycle[nextIdx] });
      renderAgendaView();
      return;
    }

    if (pushBtn) {
      const id = Number(pushBtn.dataset.agendaId);
      openPushToSessionModal(id);
      return;
    }

    if (editBtn) {
      const id = Number(editBtn.dataset.agendaId);
      openAgendaItemModal(id);
      return;
    }

    if (deleteBtn) {
      const id = Number(deleteBtn.dataset.agendaId);
      await db.deleteAgendaItem(id);
      renderAgendaView();
      if (_showToast) _showToast('DELETED', 'Agenda item removed');
      return;
    }
  });
}

function wireAgendaDrag(container) {
  let dragItem = null;
  container.querySelectorAll('.agenda-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/agenda-id', item.dataset.agendaId);
    });
    item.addEventListener('dragend', async () => {
      item.classList.remove('dragging');
      const projectGroup = item.closest('.agenda-project-items');
      const project = item.closest('.agenda-project-group')?.dataset.project;
      if (projectGroup && project) {
        const orderedIds = [...projectGroup.querySelectorAll('.agenda-item')].map(el => Number(el.dataset.agendaId));
        await db.reorderAgenda(project, orderedIds);
      }
      dragItem = null;
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragItem || dragItem === item) return;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const parent = item.closest('.agenda-project-items');
      if (e.clientY < midY) {
        parent.insertBefore(dragItem, item);
      } else {
        parent.insertBefore(dragItem, item.nextSibling);
      }
    });
  });
}

// ---- Push to Session Modal ----

async function openPushToSessionModal(agendaId) {
  const item = await db.get('agenda', agendaId);
  if (!item) return;

  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const sessions = [...sessionsData.values()].filter(s => s.status !== 'ended');

  if (sessions.length === 0) {
    if (_showToast) _showToast('NO SESSIONS', 'No active sessions to push to');
    return;
  }

  const modal = document.getElementById('agenda-push-modal');
  const list = document.getElementById('agenda-push-session-list');
  if (!modal || !list) return;

  modal.dataset.agendaId = agendaId;
  list.innerHTML = sessions.map(s => `
    <button class="agenda-push-session-btn" data-session-id="${s.sessionId}">
      <span class="agenda-push-session-name">${escapeHtml(s.projectName || 'Unknown')}</span>
      <span class="agenda-push-session-status status-badge ${s.status}">${s.status.toUpperCase()}</span>
    </button>
  `).join('');

  modal.classList.remove('hidden');
}

async function handlePushToSession(agendaId, sessionId) {
  const item = await db.get('agenda', agendaId);
  if (!item) return;

  await db.addToQueue(sessionId, item.text);
  await db.updateAgendaItem(agendaId, { status: 'in-progress' });

  // Sync queue count
  try {
    const { getWs } = await import('./wsClient.js');
    const ws = getWs();
    const items = await db.getQueue(sessionId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'update_queue_count', sessionId, count: items.length }));
    }
  } catch {}

  document.getElementById('agenda-push-modal')?.classList.add('hidden');
  renderAgendaView();

  // Refresh queue in detail panel if that session is selected
  const selectedId = _getSelectedSessionId ? _getSelectedSessionId() : null;
  if (selectedId === sessionId) {
    const { loadQueue } = await import('./promptQueue.js');
    loadQueue(sessionId);
  }

  if (_showToast) _showToast('PUSHED', 'Agenda item pushed to session queue');
}

// ---- Agenda Item Modal (Add / Edit) ----

export async function openAgendaItemModal(editId = null) {
  const modal = document.getElementById('agenda-item-modal');
  if (!modal) return;

  const titleEl = document.getElementById('agenda-modal-title');
  const textEl = document.getElementById('agenda-modal-text');
  const projectEl = document.getElementById('agenda-modal-project');
  const priorityEl = document.getElementById('agenda-modal-priority');
  const statusEl = document.getElementById('agenda-modal-status');
  const dueDateEl = document.getElementById('agenda-modal-due');
  const notesEl = document.getElementById('agenda-modal-notes');
  const tagsContainer = document.getElementById('agenda-modal-tags');

  // Populate project datalist
  const projectList = document.getElementById('agenda-modal-project-list');
  if (projectList) {
    const projects = await db.getAgendaProjects();
    // Also add known session projects
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    const sessionProjects = new Set(projects);
    for (const s of sessionsData.values()) {
      if (s.projectName) sessionProjects.add(s.projectName);
    }
    projectList.innerHTML = [...sessionProjects].sort().map(p =>
      `<option value="${escapeHtml(p)}">`
    ).join('');
  }

  // Render tag checkboxes
  if (tagsContainer) {
    tagsContainer.innerHTML = AGENDA_TAGS.map(t =>
      `<label class="agenda-tag-check"><input type="checkbox" value="${t}" class="agenda-tag-input"> ${t}</label>`
    ).join('');
  }

  if (editId) {
    const item = await db.get('agenda', editId);
    if (!item) return;
    titleEl.textContent = 'Edit Agenda Item';
    modal.dataset.editId = editId;
    textEl.value = item.text || '';
    projectEl.value = item.project || '';
    priorityEl.value = item.priority || 'P1';
    statusEl.value = item.status || 'todo';
    dueDateEl.value = item.dueDate ? new Date(item.dueDate).toISOString().split('T')[0] : '';
    notesEl.value = item.notes || '';
    // Check tags
    const itemTags = item.tags || [];
    tagsContainer?.querySelectorAll('.agenda-tag-input').forEach(cb => {
      cb.checked = itemTags.includes(cb.value);
    });
  } else {
    titleEl.textContent = 'New Agenda Item';
    delete modal.dataset.editId;
    textEl.value = '';
    projectEl.value = _filters.project || '';
    priorityEl.value = 'P1';
    statusEl.value = 'todo';
    dueDateEl.value = '';
    notesEl.value = '';
    tagsContainer?.querySelectorAll('.agenda-tag-input').forEach(cb => { cb.checked = false; });
  }

  modal.classList.remove('hidden');
  textEl.focus();
}

async function saveAgendaItem() {
  const modal = document.getElementById('agenda-item-modal');
  const textEl = document.getElementById('agenda-modal-text');
  const projectEl = document.getElementById('agenda-modal-project');
  const priorityEl = document.getElementById('agenda-modal-priority');
  const statusEl = document.getElementById('agenda-modal-status');
  const dueDateEl = document.getElementById('agenda-modal-due');
  const notesEl = document.getElementById('agenda-modal-notes');

  const text = textEl.value.trim();
  if (!text) {
    if (_showToast) _showToast('ERROR', 'Prompt text is required');
    return;
  }

  const tags = [];
  document.querySelectorAll('#agenda-modal-tags .agenda-tag-input:checked').forEach(cb => {
    tags.push(cb.value);
  });

  const data = {
    text,
    project: projectEl.value.trim() || 'Unassigned',
    priority: priorityEl.value,
    status: statusEl.value,
    tags,
    dueDate: dueDateEl.value ? new Date(dueDateEl.value).getTime() : null,
    notes: notesEl.value.trim(),
  };

  const editId = modal.dataset.editId;
  if (editId) {
    await db.updateAgendaItem(Number(editId), data);
    if (_showToast) _showToast('UPDATED', 'Agenda item updated');
  } else {
    await db.addAgendaItem(data);
    if (_showToast) _showToast('ADDED', 'Agenda item created');
  }

  modal.classList.add('hidden');
  renderAgendaView();
  renderAgendaTab();
}

// ---- Per-Session Agenda Tab ----

export async function renderAgendaTab() {
  const container = document.getElementById('agenda-tab-content');
  if (!container) return;

  const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
  if (!sid) {
    container.innerHTML = '<div class="tab-empty">No session selected</div>';
    return;
  }

  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const session = sessionsData.get(sid);
  const projectName = session?.projectName || '';

  if (!projectName) {
    container.innerHTML = '<div class="tab-empty">Session has no project name</div>';
    return;
  }

  const items = await db.getAgendaItems({ project: projectName });

  container.innerHTML = `
    <div class="agenda-tab-header">
      <span class="agenda-tab-project">${escapeHtml(projectName)}</span>
      <button class="agenda-tab-add ctrl-btn queue" id="agenda-tab-add-btn">ADD ITEM</button>
    </div>
    ${items.length > 0 ? items.map(item => renderAgendaItem(item)).join('') : '<div class="tab-empty">No agenda items for this project</div>'}
  `;

  // Wire events
  container.querySelector('#agenda-tab-add-btn')?.addEventListener('click', () => {
    _filters.project = projectName;
    openAgendaItemModal();
  });
  wireAgendaItemEvents(container);
}

// ---- Promote queue item to agenda ----

export async function promoteToAgenda(queueItemId) {
  const item = await db.get('promptQueue', queueItemId);
  if (!item) return;

  // Determine project from session
  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const session = sessionsData.get(item.sessionId);
  const project = session?.projectName || 'Unassigned';

  await db.addAgendaItem({
    project,
    text: item.text,
    priority: 'P1',
    status: 'todo',
    tags: [],
    dueDate: null,
    notes: '',
  });

  if (_showToast) _showToast('PROMOTED', 'Queue item promoted to agenda');
  renderAgendaView();
}

// ---- Filters ----

function renderFilters() {
  const bar = document.getElementById('agenda-filter-bar');
  if (!bar) return;

  bar.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'agenda-filter-project') _filters.project = el.value;
    if (el.id === 'agenda-filter-status') _filters.status = el.value;
    if (el.id === 'agenda-filter-priority') _filters.priority = el.value;
    if (el.id === 'agenda-filter-tag') _filters.tag = el.value;
    renderAgendaView();
  });
}

async function populateProjectFilter() {
  const select = document.getElementById('agenda-filter-project');
  if (!select) return;

  const projects = await db.getAgendaProjects();
  const options = '<option value="">All Projects</option>' +
    projects.map(p => `<option value="${escapeHtml(p)}"${_filters.project === p ? ' selected' : ''}>${escapeHtml(p)}</option>`).join('');
  select.innerHTML = options;
}

// ---- Export / Import ----

async function exportAgenda() {
  const items = await db.getAll('agenda');
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `agenda-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importAgenda(file) {
  try {
    const text = await file.text();
    const items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error('Expected array');
    for (const item of items) {
      // Strip id so it auto-increments
      delete item.id;
      await db.addAgendaItem(item);
    }
    renderAgendaView();
    if (_showToast) _showToast('IMPORTED', `Imported ${items.length} agenda items`);
  } catch (err) {
    if (_showToast) _showToast('IMPORT ERROR', err.message);
  }
}

// ---- Init ----

export function initAgenda() {
  // Agenda item modal handlers
  document.getElementById('agenda-modal-save')?.addEventListener('click', saveAgendaItem);
  document.getElementById('agenda-modal-close')?.addEventListener('click', () => {
    document.getElementById('agenda-item-modal')?.classList.add('hidden');
  });
  document.getElementById('agenda-modal-cancel')?.addEventListener('click', () => {
    document.getElementById('agenda-item-modal')?.classList.add('hidden');
  });
  document.getElementById('agenda-item-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // Allow Enter in text to save (not shift+enter)
  document.getElementById('agenda-modal-text')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveAgendaItem();
    }
  });

  // Push-to-session modal
  document.getElementById('agenda-push-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  document.getElementById('agenda-push-close')?.addEventListener('click', () => {
    document.getElementById('agenda-push-modal')?.classList.add('hidden');
  });
  document.getElementById('agenda-push-session-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.agenda-push-session-btn');
    if (!btn) return;
    const sessionId = btn.dataset.sessionId;
    const modal = document.getElementById('agenda-push-modal');
    const agendaId = Number(modal?.dataset.agendaId);
    if (agendaId && sessionId) {
      await handlePushToSession(agendaId, sessionId);
    }
  });

  // Add item button in global view
  document.getElementById('agenda-add-btn')?.addEventListener('click', () => openAgendaItemModal());

  // Filters
  renderFilters();

  // Export
  document.getElementById('agenda-export-btn')?.addEventListener('click', exportAgenda);

  // Import
  document.getElementById('agenda-import-btn')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      if (e.target.files[0]) importAgenda(e.target.files[0]);
    };
    input.click();
  });
}
