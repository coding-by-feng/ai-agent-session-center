/**
 * @module detailPanel
 * Slide-in detail panel for the selected session. Manages tab navigation (events, tools,
 * prompts, responses, terminal), panel resize, search highlighting, and session data display.
 */
import * as db from './browserDb.js';
import * as settingsManager from './settingsManager.js';
import { escapeHtml, escapeAttr, sanitizeColor, formatDuration, formatTime } from './utils.js';
import { STORAGE_KEYS } from './constants.js';

// Dependencies injected via initDeps()
let _getSelectedSessionId = null;
let _setSelectedSessionId = null;
let _getSessionsData = null;
let _showToast = null;
let _loadNotes = null;
let _loadQueue = null;
let _refreshAllGroupSelects = null;
let _populateDetailLabelChips = null;

export function initDeps(deps) {
  _getSelectedSessionId = deps.getSelectedSessionId;
  _setSelectedSessionId = deps.setSelectedSessionId;
  _getSessionsData = deps.getSessionsData;
  _showToast = deps.showToast;
  _loadNotes = deps.loadNotes;
  _loadQueue = deps.loadQueue;
  _refreshAllGroupSelects = deps.refreshAllGroupSelects;
  _populateDetailLabelChips = deps.populateDetailLabelChips;
}

export function selectSession(sessionId) {
  if (_setSelectedSessionId) _setSelectedSessionId(sessionId);
  const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
  const session = sessionsData.get(sessionId);
  if (!session) return;

  populateDetailPanel(session);
  const overlay = document.getElementById('session-detail-overlay');
  overlay.classList.remove('hidden');
}

export function deselectSession() {
  if (_setSelectedSessionId) _setSelectedSessionId(null);
  document.getElementById('session-detail-overlay').classList.add('hidden');
}

export function populateDetailPanel(session) {
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

  // Mini character preview in header
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
  if (_populateDetailLabelChips) _populateDetailLabelChips(session);

  // Resume button visibility
  const resumeBtn = document.getElementById('ctrl-resume');
  if (resumeBtn) {
    const canResume = session.status === 'ended' && session.source === 'ssh' && !!session.lastTerminalId;
    resumeBtn.classList.toggle('hidden', !canResume);
  }

  // Prompt History tab
  const convContainer = document.getElementById('detail-conversation');
  const prompts = (session.promptHistory || []).slice().sort((a, b) => b.timestamp - a.timestamp);
  let prevSessionsHtml = '';
  if (session.previousSessions && session.previousSessions.length > 0) {
    for (let i = session.previousSessions.length - 1; i >= 0; i--) {
      const prev = session.previousSessions[i];
      const prevPrompts = (prev.promptHistory || []).slice().sort((a, b) => b.timestamp - a.timestamp);
      const startTime = prev.startedAt ? formatTime(prev.startedAt) : '?';
      const endTime = prev.endedAt ? formatTime(prev.endedAt) : '?';
      prevSessionsHtml += `<div class="prev-session-section collapsed">
        <div class="prev-session-header" data-idx="${i}">
          <span class="prev-session-toggle">&#9654;</span>
          Previous Session #${i + 1} (${startTime} - ${endTime}) &middot; ${prevPrompts.length} prompts
        </div>
        <div class="prev-session-content">
          ${prevPrompts.length > 0 ? prevPrompts.map((p, j) => `<div class="conv-entry conv-user prev-session-entry">
            <div class="conv-header"><span class="conv-role">#${prevPrompts.length - j}</span><span class="conv-time">${formatTime(p.timestamp)}</span></div>
            <div class="conv-text">${escapeHtml(p.text)}</div>
          </div>`).join('') : '<div class="tab-empty">No prompts in this session</div>'}
        </div>
      </div>`;
    }
  }
  convContainer.innerHTML = prevSessionsHtml + (prompts.length > 0
    ? prompts.map((p, i) => `<div class="conv-entry conv-user">
        <div class="conv-header"><span class="conv-role">#${prompts.length - i}</span><span class="conv-time">${formatTime(p.timestamp)}</span><button class="conv-copy" title="Copy">COPY</button></div>
        <div class="conv-text">${escapeHtml(p.text)}</div>
      </div>`).join('')
    : (prevSessionsHtml ? '' : '<div class="tab-empty">No prompts yet</div>'));

  // Activity tab
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
      summaryEl.innerHTML = '<div class="tab-empty">No summary yet \u2014 click SUMMARIZE to generate one with AI</div>';
    }
  }

  // Update summarize button state
  const sumBtn = document.getElementById('ctrl-summarize');
  if (sumBtn) {
    sumBtn.disabled = false;
    sumBtn.textContent = session.summary ? 'RE-SUMMARIZE' : 'SUMMARIZE';
  }

  // Group select
  if (_refreshAllGroupSelects) _refreshAllGroupSelects();

  // Load notes & queue
  if (_loadNotes) _loadNotes(session.sessionId);
  if (_loadQueue) _loadQueue(session.sessionId);

  // Auto-attach terminal if Terminal tab is the default active tab
  const activeTab = document.querySelector('.detail-tabs .tab.active');
  if (activeTab && activeTab.dataset.tab === 'terminal' && session.terminalId) {
    import('./terminalManager.js').then(tm => {
      if (tm.getActiveTerminalId() === session.terminalId) {
        requestAnimationFrame(() => tm.refitTerminal());
      } else {
        tm.attachToSession(session.sessionId, session.terminalId);
      }
    });
  } else if (activeTab && activeTab.dataset.tab === 'terminal' && !session.terminalId) {
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
export { renderToolBars };

// Character model mini preview in detail panel
export function updateDetailCharPreview(modelName, status, color) {
  const container = document.getElementById('detail-char-preview');
  if (!container) return;
  const model = modelName || 'robot';
  const accentColor = sanitizeColor(color);
  import('./robotManager.js').then(rm => {
    container.innerHTML = '';
    const mini = document.createElement('div');
    mini.className = `css-robot char-${escapeAttr(model)}`;
    mini.dataset.status = status || 'idle';
    mini.style.setProperty('--robot-color', accentColor);
    const templates = rm._getTemplates ? rm._getTemplates() : null;
    if (templates && templates[model]) {
      mini.innerHTML = templates[model](accentColor);
    } else {
      mini.textContent = model;
    }
    container.appendChild(mini);
  });
}

export async function openSessionDetailFromHistory(sessionId) {
  const data = await db.getSessionDetail(sessionId);
  if (!data) { if (_showToast) _showToast('ERROR', 'Session not found in local database'); return; }

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

  const titleInput = document.getElementById('detail-title');
  if (titleInput) {
    titleInput.value = data.session.title || '';
    titleInput.dataset.sessionId = sessionId;
  }

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

  // Populate conversation tab
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

  // Populate activity tab
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
      summaryEl.innerHTML = '<div class="tab-empty">No summary yet \u2014 click SUMMARIZE to generate one with AI</div>';
    }
  }

  const sumBtn = document.getElementById('ctrl-summarize');
  if (sumBtn) {
    sumBtn.disabled = false;
    sumBtn.textContent = data.session.summary ? 'RE-SUMMARIZE' : 'SUMMARIZE';
  }

  if (_setSelectedSessionId) _setSelectedSessionId(sessionId);
  if (_refreshAllGroupSelects) _refreshAllGroupSelects();
  if (_loadNotes) _loadNotes(sessionId);
  document.getElementById('session-detail-overlay').classList.remove('hidden');
}

export function initDetailPanelHandlers() {
  // Close button and overlay backdrop click
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
    const textEl = entry.querySelector('.conv-text');
    const text = textEl
      ? textEl.textContent
      : (entry.querySelector('.conv-tool-name')?.textContent || '') + ' ' + (entry.querySelector('.conv-tool-input')?.textContent || '');
    try {
      await navigator.clipboard.writeText(text.trim());
      btn.textContent = 'COPIED';
      setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
    } catch {
      if (_showToast) _showToast('COPY', 'Failed to copy to clipboard');
    }
  });

  // Previous session section toggle (expand/collapse)
  document.getElementById('detail-conversation').addEventListener('click', (e) => {
    const header = e.target.closest('.prev-session-header');
    if (!header) return;
    const section = header.closest('.prev-session-section');
    if (section) section.classList.toggle('collapsed');
  });

  // Tab switching
  document.querySelector('.detail-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const tabName = btn.dataset.tab;

    document.querySelectorAll('.detail-tabs .tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'terminal') {
      const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
      if (sid) {
        const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
        const session = sessionsData.get(sid);
        if (session && session.terminalId) {
          import('./terminalManager.js').then(tm => {
            if (tm.getActiveTerminalId() === session.terminalId) {
              requestAnimationFrame(() => tm.refitTerminal());
            } else {
              tm.attachToSession(sid, session.terminalId);
            }
          });
        }
      }
    }
  });

  // Per-session character model change
  const charModelSelect = document.getElementById('detail-char-model');
  if (charModelSelect) {
    charModelSelect.addEventListener('change', async (e) => {
      const model = e.target.value;
      const sessionId = e.target.dataset.sessionId;
      if (!sessionId) return;

      const sessionsData = _getSessionsData ? _getSessionsData() : new Map();
      const session = sessionsData.get(sessionId);
      if (session) session.characterModel = model;

      try {
        const s = await db.get('sessions', sessionId);
        if (s) { s.characterModel = model; await db.put('sessions', s); }
      } catch(e) {
        // silent fail
      }

      import('./robotManager.js').then(rm => {
        rm.switchSessionCharacter(sessionId, model);
      });

      import('./robotManager.js').then(rm => {
        const color = rm.getSessionColor(sessionId) || session?.accentColor || null;
        updateDetailCharPreview(model, session?.status || 'idle', color);
      });
    });
  }

  // Detail Panel Resize Handle
  const handle = document.getElementById('detail-resize-handle');
  const panel = document.getElementById('session-detail-panel');
  if (handle && panel) {
    let startX = 0;
    let startWidth = 0;

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
      try { localStorage.setItem(STORAGE_KEYS.DETAIL_PANEL_WIDTH, panel.style.width); } catch(e) {}
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startWidth = panel.offsetWidth;
      panel.classList.add('resizing');
      handle.classList.add('active');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Restore saved width
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.DETAIL_PANEL_WIDTH);
      if (saved) panel.style.width = saved;
    } catch(e) {}
  }

  // Team modal close
  document.getElementById('team-modal-close')?.addEventListener('click', () => {
    document.getElementById('team-modal').classList.add('hidden');
  });
  document.getElementById('team-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'team-modal') document.getElementById('team-modal').classList.add('hidden');
  });
}

// ---- Live Search Filter ----

export function initSearchFilter() {
  const liveSearchInput = document.getElementById('live-search');
  if (!liveSearchInput) return;

  liveSearchInput.addEventListener('input', () => {
    const query = liveSearchInput.value.toLowerCase().trim();
    const cards = document.querySelectorAll('.session-card');
    const sessionsData = _getSessionsData ? _getSessionsData() : new Map();

    cards.forEach(card => {
      const sid = card.dataset.sessionId;
      const projectName = card.querySelector('.project-name')?.textContent?.toLowerCase() || '';
      const cardTitle = card.querySelector('.card-title')?.textContent?.toLowerCase() || '';

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

    const sid = _getSelectedSessionId ? _getSelectedSessionId() : null;
    if (query && sid) {
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
