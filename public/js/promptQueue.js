/**
 * @module promptQueue
 * Per-session prompt queue backed by IndexedDB. Provides compose UI, queue view,
 * drag-to-reorder, move-between-sessions, and auto-paste into terminal on dequeue.
 */
import * as db from './browserDb.js';
import { escapeHtml } from './utils.js';

// Dependencies injected via initDeps()
let _getSelectedSessionId = null;
let _setSelectedSessionId = null;
let _selectSession = null;
let _deselectSession = null;
let _showToast = null;
let _getSessionsData = null;

export function initDeps({ getSelectedSessionId, setSelectedSessionId, selectSession, deselectSession, showToast, getSessionsData }) {
  _getSelectedSessionId = getSelectedSessionId;
  _setSelectedSessionId = setSelectedSessionId;
  _selectSession = selectSession;
  _deselectSession = deselectSession;
  _showToast = showToast;
  _getSessionsData = getSessionsData;
}

// Track known queue item IDs to detect newly added items
let _knownQueueIds = new Set();

// Move-mode state for moving queue items between sessions
let moveMode = { active: false, itemIds: [], sourceSessionId: null };
export function isMoveModeActive() { return moveMode.active; }

export async function loadQueue(sessionId) {
  const list = document.getElementById('queue-list');
  const countBadge = document.getElementById('terminal-queue-count');
  try {
    const items = await db.getQueue(sessionId);
    if (countBadge) countBadge.textContent = items.length > 0 ? `(${items.length})` : '';
    const moveAllBtn = document.getElementById('queue-move-all-btn');
    if (moveAllBtn) moveAllBtn.classList.toggle('hidden', items.length === 0);

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
          <button class="queue-move" data-queue-id="${item.id}" title="Move to another session">MOVE</button>
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
      const text = item.querySelector('.queue-text')?.textContent || '';
      e.dataTransfer.setData('text/queue-prompt', text);
      e.dataTransfer.setData('text/queue-id', item.dataset.queueId);
    });
    item.addEventListener('dragend', async () => {
      item.classList.remove('dragging');
      dragItem = null;
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

// ---- Queue View (global prompt queue inspector) ----

export async function renderQueueView() {
  const content = document.getElementById('queue-view-content');
  const stats = document.getElementById('queue-view-stats');
  if (!content) return;

  content.innerHTML = '<div class="tab-empty">Loading queue data...</div>';

  const allItems = await db.getAll('promptQueue');
  const allSessions = await db.getAll('sessions');
  const sessionMap = new Map(allSessions.map(s => [s.id, s]));

  // Group by sessionId
  const grouped = {};
  for (const item of allItems) {
    if (!grouped[item.sessionId]) grouped[item.sessionId] = [];
    grouped[item.sessionId].push(item);
  }
  for (const items of Object.values(grouped)) {
    items.sort((a, b) => a.position - b.position);
  }

  const groupKeys = Object.keys(grouped);

  if (stats) {
    stats.innerHTML = `<span>${allItems.length} item${allItems.length !== 1 ? 's' : ''}</span> <span class="queue-view-stats-sep">across</span> <span>${groupKeys.length} session${groupKeys.length !== 1 ? 's' : ''}</span>`;
  }

  if (allItems.length === 0) {
    content.innerHTML = '<div class="tab-empty">No prompt queue items found in IndexedDB</div>';
    return;
  }

  let html = '';
  for (const sessionId of groupKeys) {
    const items = grouped[sessionId];
    const session = sessionMap.get(sessionId);
    const projectName = session?.projectName || 'Unknown';
    const status = session?.status || 'unknown';
    const label = session?.label || '';

    html += `<div class="queue-view-group">
      <div class="queue-view-group-header">
        <span class="queue-view-session-name">${escapeHtml(projectName)}</span>
        ${label ? `<span class="queue-view-label">${escapeHtml(label)}</span>` : ''}
        <span class="status-badge ${status}">${status.toUpperCase()}</span>
        <span class="queue-view-sid" title="${sessionId}">${sessionId.substring(0, 8)}...</span>
        <span class="queue-view-item-count">${items.length} item${items.length !== 1 ? 's' : ''}</span>
      </div>
      <table class="queue-view-table">
        <thead><tr><th>#</th><th>ID</th><th>Text</th><th>Position</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>`;
    for (const item of items) {
      const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : '\u2014';
      html += `<tr data-queue-id="${item.id}">
        <td class="queue-view-pos">${item.position}</td>
        <td class="queue-view-id">${item.id}</td>
        <td class="queue-view-text">${escapeHtml(item.text)}</td>
        <td>${item.position}</td>
        <td class="queue-view-date">${created}</td>
        <td><button class="queue-view-delete ctrl-btn kill" data-queue-id="${item.id}">DEL</button></td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  content.innerHTML = html;

  // Wire delete buttons
  content.querySelectorAll('.queue-view-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.queueId);
      await db.del('promptQueue', id);
      renderQueueView();
    });
  });
}

export function initQueueView() {
  const refreshBtn = document.getElementById('queue-view-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => renderQueueView());

  const exportBtn = document.getElementById('queue-view-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const allItems = await db.getAll('promptQueue');
      const blob = new Blob([JSON.stringify(allItems, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `prompt-queue-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

// Sync queue count to server so session cards update
export async function syncQueueCount(sessionId) {
  try {
    const items = await db.getQueue(sessionId);
    const { getWs } = await import('./wsClient.js');
    const ws = getWs();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'update_queue_count', sessionId, count: items.length }));
    }
  } catch {}
}

// Send prompt text to terminal as input
async function sendToTerminal(text) {
  const tm = await import('./terminalManager.js');
  const { getWs } = await import('./wsClient.js');
  const ws = getWs();
  const terminalId = tm.getActiveTerminalId();
  if (!terminalId || !ws || ws.readyState !== 1) {
    if (_showToast) _showToast('TERMINAL', 'No active terminal connection');
    return false;
  }
  ws.send(JSON.stringify({ type: 'terminal_input', terminalId, data: text + '\n' }));
  return true;
}

// ---- Move Queue Mode ----

function enterQueueMoveMode(itemIds, sourceSessionId) {
  moveMode = { active: true, itemIds, sourceSessionId };
  if (_deselectSession) _deselectSession();

  const banner = document.getElementById('move-mode-banner');
  const bannerText = document.getElementById('move-mode-text');
  if (banner && bannerText) {
    bannerText.textContent = `Click a session to move ${itemIds.length} prompt(s)`;
    banner.classList.remove('hidden');
  }

  document.body.classList.add('move-mode');
  document.querySelectorAll('.session-card').forEach(card => {
    if (card.dataset.sessionId === sourceSessionId) {
      card.classList.add('move-source');
    } else {
      card.classList.add('move-target');
    }
  });
}

export function exitQueueMoveMode(cancel = false) {
  const source = moveMode.sourceSessionId;
  moveMode = { active: false, itemIds: [], sourceSessionId: null };

  const banner = document.getElementById('move-mode-banner');
  if (banner) banner.classList.add('hidden');

  document.body.classList.remove('move-mode');
  document.querySelectorAll('.session-card').forEach(card => {
    card.classList.remove('move-target', 'move-source');
  });

  if (cancel && source && _selectSession) _selectSession(source);
}

export async function completeQueueMove(targetSessionId) {
  const { itemIds, sourceSessionId } = moveMode;
  if (!itemIds.length || !sourceSessionId || targetSessionId === sourceSessionId) return;

  try {
    await db.moveQueueItems(itemIds, targetSessionId);
    syncQueueCount(sourceSessionId);
    syncQueueCount(targetSessionId);
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    const targetSession = sessionsData.get(targetSessionId);
    const name = targetSession?.projectName || targetSession?.title || 'session';
    if (_showToast) _showToast('MOVED', `Moved ${itemIds.length} prompt(s) to ${name}`);
  } catch(err) {
    if (_showToast) _showToast('MOVE ERROR', err.message);
  }

  exitQueueMoveMode();
  if (_selectSession) _selectSession(targetSessionId);
}

export function initQueueHandlers() {
  // Cancel move mode
  document.getElementById('move-mode-cancel')?.addEventListener('click', () => exitQueueMoveMode(true));

  // MOVE ALL button
  document.getElementById('queue-move-all-btn')?.addEventListener('click', async () => {
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const items = await db.getQueue(sid);
    if (items.length === 0) return;
    enterQueueMoveMode(items.map(i => i.id), sid);
  });

  // Collapsible queue panel toggle
  document.getElementById('terminal-queue-toggle')?.addEventListener('click', () => {
    const panel = document.getElementById('terminal-queue-panel');
    if (panel) {
      panel.classList.toggle('collapsed');
      import('./terminalManager.js').then(tm => {
        requestAnimationFrame(() => tm.refitTerminal());
      });
    }
  });

  // Add to Queue
  document.getElementById('queue-add-btn')?.addEventListener('click', async () => {
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const textarea = document.getElementById('queue-textarea');
    const text = textarea.value.trim();
    if (!text) return;
    try {
      await db.addToQueue(sid, text);
      textarea.value = '';
      loadQueue(sid);
      syncQueueCount(sid);
      if (_showToast) _showToast('QUEUED', 'Prompt added to queue');
    } catch(e) {
      if (_showToast) _showToast('QUEUE ERROR', e.message);
    }
  });

  // Delete / Edit / Send / Move queue items (event delegation)
  document.getElementById('queue-list')?.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('.queue-delete');
    const editBtn = e.target.closest('.queue-edit');
    const sendBtn = e.target.closest('.queue-send');
    const moveBtn = e.target.closest('.queue-move');
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;

    if (sendBtn) {
      const itemId = sendBtn.dataset.queueId;
      const itemEl = sendBtn.closest('.queue-item');
      const text = itemEl?.querySelector('.queue-text')?.textContent;
      if (text) {
        const sent = await sendToTerminal(text);
        if (sent) {
          try {
            await db.del('promptQueue', Number(itemId));
            loadQueue(sid);
            syncQueueCount(sid);
          } catch(e) {}
          if (_showToast) _showToast('SENT', 'Prompt sent to terminal');
        }
      }
    }

    if (delBtn) {
      const itemId = delBtn.dataset.queueId;
      try {
        await db.del('promptQueue', Number(itemId));
        loadQueue(sid);
        syncQueueCount(sid);
      } catch(e) {
        if (_showToast) _showToast('DELETE ERROR', e.message);
      }
    }

    if (editBtn) {
      const itemId = editBtn.dataset.queueId;
      const itemEl = editBtn.closest('.queue-item');
      const textEl = itemEl?.querySelector('.queue-text');
      if (!textEl) return;
      const currentText = textEl.textContent;
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
            if (_showToast) _showToast('EDIT ERROR', e.message);
          }
        }
        loadQueue(sid);
      };

      editBtn.onclick = (ev) => { ev.stopPropagation(); saveEdit(); };
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveEdit(); }
        if (ev.key === 'Escape') loadQueue(sid);
      });
    }

    if (moveBtn) {
      const itemId = Number(moveBtn.dataset.queueId);
      enterQueueMoveMode([itemId], sid);
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
      const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
      if (sent && itemId && sid) {
        try {
          await db.del('promptQueue', Number(itemId));
          loadQueue(sid);
          syncQueueCount(sid);
        } catch(e) {}
        if (_showToast) _showToast('SENT', 'Prompt dropped into terminal');
      }
    }
  });
}
