let currentPage = 1;
let debounceTimer = null;

export async function init() {
  // Fetch projects for dropdown
  const resp = await fetch('/api/projects');
  const { projects } = await resp.json();
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
  const params = new URLSearchParams();
  const q = document.getElementById('search-input').value;
  if (q) params.set('query', q);
  const project = document.getElementById('history-project-filter').value;
  if (project) params.set('project', project);
  const status = document.getElementById('history-status-filter').value;
  if (status === 'archived') {
    params.set('archived', 'true');
  } else if (status) {
    params.set('status', status);
  }
  const dateFrom = document.getElementById('history-date-from').value;
  if (dateFrom) params.set('dateFrom', new Date(dateFrom).getTime());
  const dateTo = document.getElementById('history-date-to').value;
  if (dateTo) params.set('dateTo', new Date(dateTo + 'T23:59:59').getTime());
  const sortByMap = { date: 'started_at', duration: 'ended_at', prompts: 'total_prompts', tools: 'total_tool_calls' };
  const rawSort = document.getElementById('history-sort-by').value;
  params.set('sortBy', sortByMap[rawSort] || 'started_at');
  params.set('sortDir', document.getElementById('history-sort-dir').textContent.toLowerCase());
  params.set('page', currentPage);
  params.set('pageSize', 50);

  const resp = await fetch(`/api/sessions/history?${params}`);
  const data = await resp.json();
  renderResults(data.sessions, data.total, data.page, data.pageSize);
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
      <span class="history-project">${escapeHtml(s.project_name)}</span>
      <span class="history-date">${date}</span>
      <span class="history-duration">${duration}</span>
      <span class="history-status ${s.status}">${s.status.toUpperCase()}</span>
      <span class="history-prompts">${s.total_prompts} prompts</span>
      <span class="history-tools">${s.total_tool_calls} tools</span>
      <span class="history-branch">${escapeHtml(s.git_branch || '')}</span>
    </div>`;
  }).join('');

  // Click handler for rows
  container.querySelectorAll('.history-row').forEach(row => {
    row.addEventListener('click', () => openHistoryDetail(row.dataset.sessionId));
  });

  // Pagination
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

  // Previous button
  buttons.push(
    `<button class="page-btn${page <= 1 ? ' disabled' : ''}" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>&laquo; Prev</button>`
  );

  // Page number buttons: show first, last, current +/- 2, with ellipses
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

  // Next button
  buttons.push(
    `<button class="page-btn${page >= totalPages ? ' disabled' : ''}" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''}>Next &raquo;</button>`
  );

  container.innerHTML = buttons.join('');

  // Wire click handlers
  container.querySelectorAll('.page-btn:not(.disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = parseInt(btn.dataset.page, 10);
      loadSessions();
    });
  });
}

async function openHistoryDetail(sessionId) {
  const resp = await fetch(`/api/sessions/${sessionId}/detail`);
  const data = await resp.json();
  const s = data;

  // Populate header
  const sess = s.session || s;
  document.getElementById('detail-project-name').textContent = sess.project_name || '';
  const badge = document.getElementById('detail-status-badge');
  badge.textContent = (sess.status || '').toUpperCase();
  badge.className = `status-badge ${sess.status}`;
  document.getElementById('detail-model').textContent = sess.model || '';
  document.getElementById('detail-duration').textContent = sess.ended_at
    ? formatDuration(sess.ended_at - sess.started_at)
    : formatDuration(Date.now() - sess.started_at);

  // Character model selector + preview
  const charSelect = document.getElementById('detail-char-model');
  if (charSelect) {
    charSelect.value = sess.character_model || '';
    charSelect.dataset.sessionId = sessionId;
  }
  // Mini preview with session's accent color
  const previewEl = document.getElementById('detail-char-preview');
  if (previewEl) {
    const model = sess.character_model || 'robot';
    const accentColor = sess.accent_color || 'var(--accent-cyan)';
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

  // Conversation tab (interleaved prompts + responses, newest first)
  const convoEl = document.getElementById('detail-conversation');
  const allEntries = [
    ...(s.prompts || []).map(p => ({ type: 'prompt', timestamp: p.timestamp, text: p.text })),
    ...(s.responses || []).map(r => ({ type: 'response', timestamp: r.timestamp, text: r.text })),
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
  for (const t of (s.tools || [])) {
    histItems.push({ kind: 'tool', tool: t.tool, input: t.input, timestamp: t.timestamp });
  }
  for (const e of (s.events || [])) {
    histItems.push({ kind: 'event', type: e.type, detail: e.detail, timestamp: e.timestamp });
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

// -- Helpers (same as sessionPanel.js) --

function formatDuration(ms) {
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
