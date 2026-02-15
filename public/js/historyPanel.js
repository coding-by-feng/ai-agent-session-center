import { escapeHtml as _escapeHtml, formatDuration as _formatDuration, formatTime as _formatTime, sanitizeColor } from './utils.js';

let currentPage = 1;
let debounceTimer = null;

// Fetch helper for server-side DB API
async function apiFetch(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function init() {
  // Fetch projects from server DB
  const projects = await apiFetch('/api/db/projects');
  const select = document.getElementById('history-project-filter');
  projects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.project_path;
    opt.textContent = p.project_name;
    select.appendChild(opt);
  });

  // Wire up filter change events
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { currentPage = 1; loadSessions(); }, 300);
  });
  ['history-project-filter', 'history-status-filter', 'history-date-from', 'history-date-to', 'history-sort-by'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => { currentPage = 1; loadSessions(); });
  });
  document.getElementById('history-sort-dir').addEventListener('click', (e) => {
    e.target.textContent = e.target.textContent === 'DESC' ? 'ASC' : 'DESC';
    currentPage = 1;
    loadSessions();
  });
}

export async function refresh() {
  await loadSessions();
}

async function loadSessions() {
  const query = document.getElementById('search-input').value || '';
  const project = document.getElementById('history-project-filter').value || '';
  const statusVal = document.getElementById('history-status-filter').value;
  let status = '', archived = '';
  if (statusVal === 'archived') {
    archived = 'true';
  } else if (statusVal) {
    status = statusVal;
  }
  const dateFromRaw = document.getElementById('history-date-from').value;
  const dateFrom = dateFromRaw ? new Date(dateFromRaw).getTime() : '';
  const dateToRaw = document.getElementById('history-date-to').value;
  const dateTo = dateToRaw ? new Date(dateToRaw + 'T23:59:59').getTime() : '';
  const sortByMap = { date: 'started_at', duration: 'last_activity_at', prompts: 'started_at', tools: 'started_at' };
  const rawSort = document.getElementById('history-sort-by').value;
  const sortBy = sortByMap[rawSort] || 'started_at';
  const sortDir = document.getElementById('history-sort-dir').textContent.toLowerCase();

  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (project) params.set('project', project);
  if (status) params.set('status', status);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  if (archived) params.set('archived', archived);
  params.set('sortBy', sortBy);
  params.set('sortDir', sortDir);
  params.set('page', currentPage);
  params.set('pageSize', 50);

  const result = await apiFetch(`/api/db/sessions?${params}`);

  // DB returns snake_case fields directly
  const mapped = result.sessions.map(s => ({
    id: s.id,
    title: s.title || '',
    project_name: s.project_name || '',
    started_at: s.started_at,
    ended_at: s.ended_at,
    status: s.status,
    total_prompts: s.total_prompts || 0,
    total_tool_calls: s.total_tool_calls || 0,
    git_branch: '',
  }));
  renderResults(mapped, result.total, result.page, result.pageSize);
}

function renderResults(sessions, total, page, pageSize) {
  const container = document.getElementById('history-results');
  if (sessions.length === 0) {
    container.innerHTML = '<div class="tab-empty">No sessions found</div>';
    document.getElementById('history-pagination').innerHTML = '';
    return;
  }

  container.innerHTML = sessions.map(s => {
    const duration = s.ended_at
      ? formatDuration(s.ended_at - s.started_at)
      : formatDuration(Date.now() - s.started_at);
    const date = new Date(s.started_at).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return `<div class="history-row" data-session-id="${s.id}">
      <span class="history-title">${escapeHtml(s.title)}</span>
      <span class="history-project">${escapeHtml(s.project_name)}</span>
      <span class="history-date">${date}</span>
      <span class="history-duration">${duration}</span>
      <span class="history-status ${s.status}">${s.status.toUpperCase()}</span>
      <span class="history-prompts">${s.total_prompts} prompts</span>
      <span class="history-tools">${s.total_tool_calls} tools</span>
      <span class="history-branch">${escapeHtml(s.git_branch || '')}</span>
      <button class="history-delete" title="Delete session">&times;</button>
    </div>`;
  }).join('');

  // Click handler for rows
  container.querySelectorAll('.history-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.history-delete')) return;
      openHistoryDetail(row.dataset.sessionId);
    });
  });

  // Delete button handler — delete from server DB
  container.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.history-row');
      const sid = row.dataset.sessionId;
      if (!confirm('Delete this session from history? This cannot be undone.')) return;
      await fetch(`/api/db/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
      row.style.transition = 'opacity 0.3s';
      row.style.opacity = '0';
      setTimeout(() => {
        row.remove();
        if (container.querySelectorAll('.history-row').length === 0) loadSessions();
      }, 300);
    });
  });

  renderPagination(total, page, pageSize);
}

function renderPagination(total, page, pageSize) {
  const container = document.getElementById('history-pagination');
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  const buttons = [];
  buttons.push(
    `<button class="page-btn${page <= 1 ? ' disabled' : ''}" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>&laquo; Prev</button>`
  );

  const range = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 2 && i <= page + 2)) {
      range.push(i);
    }
  }

  let lastShown = 0;
  range.forEach(i => {
    if (lastShown && i - lastShown > 1) {
      buttons.push('<span class="page-ellipsis">...</span>');
    }
    buttons.push(
      `<button class="page-btn${i === page ? ' active' : ''}" data-page="${i}">${i}</button>`
    );
    lastShown = i;
  });

  buttons.push(
    `<button class="page-btn${page >= totalPages ? ' disabled' : ''}" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''}>Next &raquo;</button>`
  );

  container.innerHTML = buttons.join('');

  container.querySelectorAll('.page-btn:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = parseInt(btn.dataset.page, 10);
      loadSessions();
    });
  });
}

async function openHistoryDetail(sessionId) {
  const data = await apiFetch(`/api/db/sessions/${encodeURIComponent(sessionId)}`);
  if (!data) return;

  const sess = data.session;
  const prompts = data.prompts || [];
  const responses = (data.responses || []).map(r => ({ ...r, text: r.text_excerpt || r.text || '' }));
  const tools = (data.tool_calls || []).map(t => ({ tool: t.tool_name, input: t.tool_input_summary || '', timestamp: t.timestamp }));
  const events = data.events || [];

  // Populate header
  document.getElementById('detail-project-name').textContent = sess.project_name || '';
  const badge = document.getElementById('detail-status-badge');
  badge.textContent = (sess.status || '').toUpperCase();
  badge.className = `status-badge ${sess.status}`;
  document.getElementById('detail-model').textContent = sess.model || '';
  const startedAt = sess.started_at;
  const endedAt = sess.ended_at;
  document.getElementById('detail-duration').textContent = endedAt
    ? formatDuration(endedAt - startedAt)
    : formatDuration(Date.now() - startedAt);

  // Character model selector + preview
  const charSelect = document.getElementById('detail-char-model');
  if (charSelect) {
    charSelect.value = sess.character_model || '';
    charSelect.dataset.sessionId = sessionId;
  }
  const previewEl = document.getElementById('detail-char-preview');
  if (previewEl) {
    const model = sess.character_model || 'robot';
    const accentColor = sanitizeColor(sess.accent_color);
    import('./robotManager.js').then(rm => {
      previewEl.innerHTML = '';
      const mini = document.createElement('div');
      mini.className = `css-robot char-${model}`;
      mini.dataset.status = sess.status || 'ended';
      mini.style.setProperty('--robot-color', accentColor);
      if (rm._getTemplates) {
        const templates = rm._getTemplates();
        if (templates[model]) mini.innerHTML = templates[model](accentColor);
      }
      previewEl.appendChild(mini);
    });
  }

  // Conversation tab (interleaved prompts + responses)
  const convoEl = document.getElementById('detail-conversation');
  const allEntries = [
    ...prompts.map(p => ({ type: 'prompt', timestamp: p.timestamp, text: p.text })),
    ...responses.map(r => ({ type: 'response', timestamp: r.timestamp, text: r.text })),
  ].sort((a, b) => a.timestamp - b.timestamp);
  convoEl.innerHTML = allEntries.map(e => {
    const cls = e.type === 'prompt' ? 'prompt-entry' : 'response-entry';
    return `<div class="${cls}">
      <span class="${e.type}-time">${formatTime(e.timestamp)}</span>
      <div class="${e.type}-text">${escapeHtml(e.text)}</div>
    </div>`;
  }).join('');

  // Activity tab (merged tool calls + events)
  const histItems = [];
  for (const t of tools) {
    histItems.push({ kind: 'tool', tool: t.tool, input: t.input, timestamp: t.timestamp });
  }
  for (const e of events) {
    histItems.push({ kind: 'event', type: e.event_type, detail: e.detail, timestamp: e.timestamp });
  }
  histItems.sort((a, b) => b.timestamp - a.timestamp);
  const actEl = document.getElementById('detail-activity-log');
  if (actEl) {
    actEl.innerHTML = histItems.length > 0
      ? histItems.map(item => {
          if (item.kind === 'tool') {
            return `<div class="activity-entry activity-tool">
              <span class="activity-time">${formatTime(item.timestamp)}</span>
              <span class="activity-badge activity-badge-tool">${escapeHtml(item.tool)}</span>
              <span class="activity-detail">${escapeHtml(item.input)}</span>
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

  document.getElementById('session-detail-overlay').classList.remove('hidden');
}

// -- Helpers (imported from utils.js) --
const formatDuration = _formatDuration;
const formatTime = _formatTime;
const escapeHtml = _escapeHtml;
