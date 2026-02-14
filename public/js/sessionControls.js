/**
 * @module sessionControls
 * Action buttons in the detail panel: kill process, archive/unarchive, delete, resume SSH session,
 * label assignment, notes editing, and AI-powered session summarization via the /api/sessions/:id/summarize endpoint.
 */
import * as db from './browserDb.js';
import * as soundManager from './soundManager.js';
import { escapeHtml, formatTime } from './utils.js';
import { STORAGE_KEYS } from './constants.js';

// Dependencies injected via initDeps()
let _getSelectedSessionId = null;
let _getSessionsData = null;
let _showToast = null;
let _deselectSession = null;
let _removeCard = null;
let _refreshAllGroupSelects = null;
let _createGroup = null;
let _assignSessionToGroupAndMove = null;
let _reorderPinnedCards = null;
let _pinnedSessions = null;
let _addSessionToGroup = null;
let _removeSessionFromGroup = null;
let _updateGroupCounts = null;
let _updateCardGroupBadge = null;

export function initDeps(deps) {
  _getSelectedSessionId = deps.getSelectedSessionId;
  _getSessionsData = deps.getSessionsData;
  _showToast = deps.showToast;
  _deselectSession = deps.deselectSession;
  _removeCard = deps.removeCard;
  _refreshAllGroupSelects = deps.refreshAllGroupSelects;
  _createGroup = deps.createGroup;
  _assignSessionToGroupAndMove = deps.assignSessionToGroupAndMove;
  _reorderPinnedCards = deps.reorderPinnedCards;
  _pinnedSessions = deps.pinnedSessions;
  _addSessionToGroup = deps.addSessionToGroup;
  _removeSessionFromGroup = deps.removeSessionFromGroup;
  _updateGroupCounts = deps.updateGroupCounts;
  _updateCardGroupBadge = deps.updateCardGroupBadge;
}

// ---- Notes ----

export async function loadNotes(sessionId) {
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
      const prpts = await loadSummaryPrompts();
      renderSummaryPromptList(prpts);
      if (_showToast) _showToast('DEFAULT SET', 'Summary prompt set as default');
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
      const prpts = await loadSummaryPrompts();
      renderSummaryPromptList(prpts);
      if (_showToast) _showToast('DELETED', 'Prompt template removed');
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
  const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;

  try {
    const detail = await db.getSessionDetail(sid);
    if (!detail) throw new Error('Session not found in local database');

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

    let promptTemplate = customPrompt || '';
    if (!promptTemplate && promptId) {
      const tmpl = await db.get('summaryPrompts', promptId);
      if (tmpl) promptTemplate = tmpl.prompt;
    }

    const resp = await fetch(`/api/sessions/${sid}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, promptTemplate })
    });
    const data = await resp.json();
    if (data.ok) {
      const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
      const session = sessionsData.get(sid);
      if (session) { session.archived = 1; session.summary = data.summary; }
      const s = await db.get('sessions', sid);
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
      if (_showToast) _showToast('SUMMARIZED', 'AI summary generated & session archived');
    } else {
      if (_showToast) _showToast('SUMMARIZE FAILED', data.error || 'Unknown error');
      btn.textContent = 'SUMMARIZE';
      btn.disabled = false;
    }
  } catch(err) {
    if (_showToast) _showToast('SUMMARIZE ERROR', err.message);
    btn.textContent = 'SUMMARIZE';
    btn.disabled = false;
  }
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

export function populateDetailLabelChips(session) {
  const container = document.getElementById('detail-label-chips');
  if (!container) return;
  container.innerHTML = '';

  const builtins = ['ONEOFF', 'HEAVY', 'IMPORTANT'];
  let customLabels = [];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_LABELS) || '[]');
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
      const detailLabelInput = document.getElementById('detail-label');
      if (!detailLabelInput) return;
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

export async function saveDetailLabel() {
  const detailLabelInput = document.getElementById('detail-label');
  if (!detailLabelInput) return;
  const sessionId = detailLabelInput.dataset.sessionId;
  const label = detailLabelInput.value.trim();
  if (!sessionId) return;
  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const session = sessionsData.get(sessionId);
  if (session) session.label = label;
  const badge = document.querySelector(`.session-card[data-session-id="${sessionId}"] .card-label-badge`);
  if (badge) {
    badge.textContent = label;
    badge.style.display = label ? '' : 'none';
  }
  updateDetailLabelChipStates(label);
  try {
    await fetch(`/api/sessions/${sessionId}/label`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label })
    });
    const s = await db.get('sessions', sessionId);
    if (s) { s.label = label; await db.put('sessions', s); }
  } catch(e) {
    // silent fail
  }
  if (label) {
    try {
      const labels = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_LABELS) || '[]');
      const idx = labels.indexOf(label);
      if (idx !== -1) labels.splice(idx, 1);
      labels.unshift(label);
      localStorage.setItem(STORAGE_KEYS.SESSION_LABELS, JSON.stringify(labels.slice(0, 30)));
    } catch(_) {}
  }
}

export function initControlHandlers() {
  // Resume button
  document.getElementById('ctrl-resume').addEventListener('click', async (e) => {
    e.stopPropagation();
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    const session = sessionsData.get(sid);
    if (!session || session.status !== 'ended') {
      if (_showToast) _showToast('RESUME', 'Session cannot be resumed');
      return;
    }
    const btn = document.getElementById('ctrl-resume');
    btn.disabled = true;
    btn.textContent = 'RESUMING...';
    try {
      const resp = await fetch(`/api/sessions/${sid}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await resp.json();
      if (data.ok) {
        if (_showToast) _showToast('RESUMING', 'Resuming Claude session in terminal');
        const termTab = document.querySelector('.detail-tabs .tab[data-tab="terminal"]');
        if (termTab) termTab.click();
      } else {
        if (_showToast) _showToast('RESUME FAILED', data.error || 'Unknown error');
      }
    } catch (err) {
      if (_showToast) _showToast('RESUME ERROR', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'RESUME';
    }
  });

  // Kill button
  document.getElementById('ctrl-kill').addEventListener('click', (e) => {
    e.stopPropagation();
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    const session = sessionsData.get(sid);
    const msg = document.getElementById('kill-modal-msg');
    msg.textContent = `Kill session for "${session ? session.projectName : sid}"? This will terminate the Claude process (SIGTERM \u2192 SIGKILL).`;
    document.getElementById('kill-modal').classList.remove('hidden');
  });

  document.getElementById('kill-cancel').addEventListener('click', () => {
    document.getElementById('kill-modal').classList.add('hidden');
  });

  document.getElementById('kill-confirm').addEventListener('click', async () => {
    document.getElementById('kill-modal').classList.add('hidden');
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    const session = sessionsData.get(sid);
    try {
      const resp = await fetch(`/api/sessions/${sid}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
      });
      const data = await resp.json();
      if (data.ok) {
        if (session && session.terminalId) {
          fetch(`/api/terminals/${session.terminalId}`, { method: 'DELETE' }).catch(() => {});
        }
        if (_showToast) _showToast('PROCESS KILLED', `PID ${data.pid || 'N/A'} terminated`);
        soundManager.play('kill');
        if (_deselectSession) _deselectSession();
      } else {
        if (_showToast) _showToast('KILL FAILED', data.error || 'Unknown error');
      }
    } catch(e) {
      if (_showToast) _showToast('KILL ERROR', e.message);
    }
  });

  // Group select (detail panel)
  document.getElementById('detail-group-select').addEventListener('change', (e) => {
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const groupId = e.target.value;
    if (groupId === '__new__') {
      const name = prompt('New group name:');
      if (name && name.trim()) {
        const newGroupId = _createGroup(name.trim());
        _assignSessionToGroupAndMove(newGroupId, sid);
        if (_pinnedSessions && _pinnedSessions.has(sid) && _reorderPinnedCards) _reorderPinnedCards();
        if (_showToast) _showToast('GROUP', `Created and assigned to "${name.trim()}"`);
      } else {
        if (_refreshAllGroupSelects) _refreshAllGroupSelects();
      }
      return;
    }
    const card = document.querySelector(`.session-card[data-session-id="${sid}"]`);
    if (!card) return;
    if (groupId) {
      const groupGrid = document.querySelector(`#${groupId} .group-grid`);
      if (groupGrid) {
        groupGrid.appendChild(card);
        _addSessionToGroup(groupId, sid);
      }
    } else {
      document.getElementById('sessions-grid').appendChild(card);
      _removeSessionFromGroup(sid);
    }
    if (_updateGroupCounts) _updateGroupCounts();
    if (_updateCardGroupBadge) _updateCardGroupBadge(sid);
    if (_pinnedSessions && _pinnedSessions.has(sid) && _reorderPinnedCards) _reorderPinnedCards();
    if (_showToast) _showToast('GROUP', groupId ? 'Moved to group' : 'Removed from group');
  });

  // Archive button
  document.getElementById('ctrl-archive').addEventListener('click', async (e) => {
    e.stopPropagation();
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    try {
      const s = await db.get('sessions', sid);
      if (s) {
        s.status = 'ended';
        s.archived = 1;
        if (!s.endedAt) s.endedAt = Date.now();
        await db.put('sessions', s);
      }
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
      if (_deselectSession) _deselectSession();
      if (_removeCard) _removeCard(sid);
      sessionsData.delete(sid);
      import('./robotManager.js').then(rm => rm.removeRobot(sid));
      document.dispatchEvent(new CustomEvent('card-dismissed', { detail: { sessionId: sid } }));
      if (_showToast) _showToast('ARCHIVED', 'Session moved to history');
    } catch(err) {
      if (_showToast) _showToast('ARCHIVE ERROR', err.message);
    }
  });

  // Permanent Delete
  document.getElementById('ctrl-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
    const session = sessionsData.get(sid);
    const label = session?.title || session?.projectName || sid.slice(0, 8);
    if (!confirm(`Permanently delete session "${label}"?\nThis cannot be undone.`)) return;
    try {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
      await db.del('sessions', sid);
      if (_deselectSession) _deselectSession();
      if (_showToast) _showToast('DELETED', `Session "${label}" permanently removed`);
    } catch (err) {
      if (_showToast) _showToast('DELETE ERROR', err.message);
    }
  });

  // Summarize button -> opens prompt selector modal
  document.getElementById('ctrl-summarize').addEventListener('click', (e) => {
    e.stopPropagation();
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
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
    const promptText = promptInput.value.trim();
    if (!name || !promptText) { if (_showToast) _showToast('MISSING', 'Name and prompt are required'); return; }

    const editId = form.dataset.editId;
    if (editId) {
      const item = await db.get('summaryPrompts', parseInt(editId, 10));
      if (item) {
        item.name = name;
        item.prompt = promptText;
        item.updatedAt = Date.now();
        await db.put('summaryPrompts', item);
      }
      if (_showToast) _showToast('UPDATED', 'Template updated');
    } else {
      const now = Date.now();
      await db.put('summaryPrompts', { name, prompt: promptText, isDefault: 0, createdAt: now, updatedAt: now });
      if (_showToast) _showToast('SAVED', 'Template saved');
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
    const promptText = document.getElementById('summarize-custom-prompt').value.trim();
    if (!promptText) { if (_showToast) _showToast('MISSING', 'Write a prompt first'); return; }
    runSummarize(null, promptText);
  });

  // Save note
  document.getElementById('save-note').addEventListener('click', async () => {
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const textarea = document.getElementById('note-textarea');
    const text = textarea.value.trim();
    if (!text) return;
    try {
      await db.addNote(sid, text);
      textarea.value = '';
      loadNotes(sid);
      if (_showToast) _showToast('NOTE SAVED', 'Note added successfully');
    } catch(e) {
      if (_showToast) _showToast('NOTE ERROR', e.message);
    }
  });

  // Delete note (event delegation)
  document.getElementById('notes-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.note-delete');
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!btn || !sid) return;
    const noteId = btn.dataset.noteId;
    try {
      await db.del('notes', Number(noteId));
      loadNotes(sid);
    } catch(e) {
      if (_showToast) _showToast('DELETE ERROR', e.message);
    }
  });

  // Alert button
  document.getElementById('ctrl-alert').addEventListener('click', (e) => {
    e.stopPropagation();
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    document.getElementById('alert-modal').classList.remove('hidden');
  });

  document.getElementById('alert-cancel').addEventListener('click', () => {
    document.getElementById('alert-modal').classList.add('hidden');
  });

  document.getElementById('alert-confirm').addEventListener('click', async () => {
    document.getElementById('alert-modal').classList.add('hidden');
    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (!sid) return;
    const minutes = parseInt(document.getElementById('alert-minutes').value, 10);
    if (!minutes || minutes < 1) return;
    try {
      const now = Date.now();
      await db.put('alerts', {
        sessionId: sid,
        thresholdMs: minutes * 60000,
        createdAt: now,
        triggerAt: now + minutes * 60000
      });
      if (_showToast) _showToast('ALERT SET', `Will alert after ${minutes} minutes`);
      soundManager.play('click');
    } catch(e) {
      if (_showToast) _showToast('ALERT ERROR', e.message);
    }
  });

  // Session Title Save (blur/Enter)
  const detailTitleInput = document.getElementById('detail-title');
  if (detailTitleInput) {
    async function saveTitle() {
      const sessionId = detailTitleInput.dataset.sessionId;
      const title = detailTitleInput.value.trim();
      if (!sessionId) return;
      const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
      const session = sessionsData.get(sessionId);
      if (session) session.title = title;
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

  // Session Label Save (blur/Enter)
  const detailLabelInput = document.getElementById('detail-label');
  if (detailLabelInput) {
    detailLabelInput.addEventListener('blur', saveDetailLabel);
    detailLabelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        detailLabelInput.blur();
      }
    });
    detailLabelInput.addEventListener('focus', () => {
      const dl = document.getElementById('detail-label-suggestions');
      if (!dl) return;
      dl.innerHTML = '';
      try {
        const labels = JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_LABELS) || '[]');
        for (const lbl of labels) {
          const opt = document.createElement('option');
          opt.value = lbl;
          dl.appendChild(opt);
        }
      } catch(_) {}
    });
  }
}
