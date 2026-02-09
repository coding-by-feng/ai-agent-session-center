import * as soundManager from './soundManager.js';

const mutedSessions = new Set();
export function isMuted(sessionId) { return mutedSessions.has(sessionId); }

const sessionsData = new Map(); // sessionId -> session object (for duration updates + detail panel)
let selectedSessionId = null;
export function getSelectedSessionId() { return selectedSessionId; }
export function getSessionsData() { return sessionsData; }
export { deselectSession };

export function createOrUpdateCard(session) {
  sessionsData.set(session.sessionId, session);

  let card = document.querySelector(`.session-card[data-session-id="${session.sessionId}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.sessionId;
    card.innerHTML = `
      <button class="mute-btn" title="Mute sounds">&#9835;</button>
      <div class="robot-viewport"></div>
      <div class="card-info">
        <div class="card-header">
          <span class="project-name"></span>
          <span class="status-badge"></span>
        </div>
        <div class="waiting-banner">NEEDS YOUR INPUT</div>
        <div class="card-title"></div>
        <div class="card-prompt"></div>
        <div class="card-stats">
          <span class="duration"></span>
          <span class="tool-count"></span>
          <span class="subagent-count" title="Active subagents"></span>
        </div>
        <div class="tool-bars"></div>
      </div>
    `;
    card.addEventListener('click', () => selectSession(session.sessionId));
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
    document.getElementById('sessions-grid').appendChild(card);
  }

  // Update status attribute
  card.dataset.status = session.status;

  // Update fields
  card.querySelector('.project-name').textContent = session.projectName;
  const cardTitle = card.querySelector('.card-title');
  if (cardTitle) {
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

  card.querySelector('.duration').textContent = formatDuration(Date.now() - session.startedAt);
  card.querySelector('.tool-count').textContent = `Tools: ${session.totalToolCalls}`;
  card.querySelector('.subagent-count').textContent =
    session.subagentCount > 0 ? `Agents: ${session.subagentCount}` : '';

  card.querySelector('.tool-bars').innerHTML = renderToolBars(session.toolUsage);

  // If this session is selected, update the detail panel too
  if (selectedSessionId === session.sessionId) {
    populateDetailPanel(session);
  }
}

export function removeCard(sessionId) {
  const card = document.querySelector(`.session-card[data-session-id="${sessionId}"]`);
  if (card) card.remove();
  sessionsData.delete(sessionId);
  if (selectedSessionId === sessionId) {
    deselectSession();
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
  document.getElementById('detail-duration').textContent = formatDuration(Date.now() - session.startedAt);

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

  // Load notes
  loadNotes(session.sessionId);
  // Update archive button
  const archBtn = document.getElementById('ctrl-archive');
  if (archBtn) archBtn.textContent = session.archived ? 'UNARCHIVE' : 'ARCHIVE';
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
  document.getElementById('detail-duration').textContent = duration;

  // Session title
  const titleInput = document.getElementById('detail-title');
  if (titleInput) {
    titleInput.value = data.session.title || '';
    titleInput.dataset.sessionId = sessionId;
  }

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

  // Load notes for this session
  loadNotes(sessionId);
  // Update archive button text
  const archBtn = document.getElementById('ctrl-archive');
  if (archBtn) archBtn.textContent = data.session.archived ? 'UNARCHIVE' : 'ARCHIVE';

  // Show overlay
  document.getElementById('session-detail-overlay').classList.remove('hidden');
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

// ---- Live Search Filter ----
const liveSearchInput = document.getElementById('live-search');
if (liveSearchInput) {
  liveSearchInput.addEventListener('input', () => {
    const query = liveSearchInput.value.toLowerCase().trim();
    const cards = document.querySelectorAll('.session-card');
    cards.forEach(card => {
      const projectName = card.querySelector('.project-name')?.textContent?.toLowerCase() || '';
      const cardTitle = card.querySelector('.card-title')?.textContent?.toLowerCase() || '';
      if (!query || projectName.includes(query) || cardTitle.includes(query)) {
        card.classList.remove('filtered');
      } else {
        card.classList.add('filtered');
      }
    });
  });
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
