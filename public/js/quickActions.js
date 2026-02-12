/**
 * @module quickActions
 * Top-bar action buttons: NEW SESSION (SSH terminal creation), QUICK/ONEOFF/HEAVY/IMPORTANT
 * (labeled session launchers), ARCHIVE ENDED, and MUTE ALL. Manages the new-session modal
 * with SSH connection options and tmux support.
 */
import { toggleMuteAll, archiveAllEnded, showToast, pinSession } from './sessionPanel.js';
import * as settingsManager from './settingsManager.js';
import * as terminalManager from './terminalManager.js';
import { escapeHtml, debugWarn } from './utils.js';
import { STORAGE_KEYS, LABELS } from './constants.js';

// ---- Label Persistence ----
function getSavedLabels() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.SESSION_LABELS) || '[]');
  } catch { return []; }
}

function saveLabel(label) {
  if (!label) return;
  const labels = getSavedLabels();
  const idx = labels.indexOf(label);
  if (idx !== -1) labels.splice(idx, 1);
  labels.unshift(label);
  localStorage.setItem(STORAGE_KEYS.SESSION_LABELS, JSON.stringify(labels.slice(0, 30)));
}

function deleteLabel(label) {
  const labels = getSavedLabels();
  const idx = labels.indexOf(label);
  if (idx !== -1) {
    labels.splice(idx, 1);
    localStorage.setItem(STORAGE_KEYS.SESSION_LABELS, JSON.stringify(labels));
  }
}

function populateLabelSuggestions(datalistId) {
  const dl = document.getElementById(datalistId);
  if (!dl) return;
  dl.innerHTML = '';
  for (const label of getSavedLabels()) {
    const opt = document.createElement('option');
    opt.value = label;
    dl.appendChild(opt);
  }
}

function populateQuickLabelChips() {
  const container = document.getElementById('quick-label-chips');
  if (!container) return;
  container.innerHTML = '';
  const labels = getSavedLabels();
  if (labels.length === 0) {
    container.innerHTML = '<span class="quick-label-empty">No labels yet \u2014 type one below</span>';
    return;
  }
  for (const label of labels) {
    const chip = document.createElement('button');
    chip.className = 'quick-label-chip';

    const labelText = document.createElement('span');
    labelText.className = 'label-text';
    labelText.textContent = label;

    const deleteIcon = document.createElement('span');
    deleteIcon.className = 'label-delete';
    deleteIcon.textContent = '\u00D7';
    deleteIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLabel(label);
      populateQuickLabelChips();
      populateLabelSuggestions('quick-label-suggestions');
    });

    chip.appendChild(labelText);
    chip.appendChild(deleteIcon);

    chip.addEventListener('click', () => {
      container.querySelectorAll('.quick-label-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      document.getElementById('quick-label-input').value = label;
    });
    container.appendChild(chip);
  }
}

function getSelectedCommand() {
  const preset = document.getElementById('ssh-command-preset').value;
  if (preset === 'custom') {
    return document.getElementById('ssh-custom-command').value || 'claude';
  }
  return preset;
}

function getApiKeyForCommand(command) {
  if (!command) return settingsManager.get('anthropicApiKey');
  if (command.startsWith('codex')) return settingsManager.get('openaiApiKey');
  if (command.startsWith('gemini')) return settingsManager.get('geminiApiKey');
  return settingsManager.get('anthropicApiKey');
}

// ---- SSH Keys ----
async function loadSshKeys() {
  try {
    const resp = await fetch('/api/ssh-keys');
    const { keys } = await resp.json();
    const select = document.getElementById('ssh-key-select');
    select.innerHTML = '';
    for (const k of keys) {
      const opt = document.createElement('option');
      opt.value = k.path;
      opt.textContent = k.name;
      select.appendChild(opt);
    }
    if (keys.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No keys found in ~/.ssh/';
      select.appendChild(opt);
    }
  } catch (e) {
    debugWarn('[quickActions] Failed to load SSH keys:', e);
  }
}

function restoreLastSession() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.LAST_SESSION);
    if (!saved) return;
    const s = JSON.parse(saved);

    if (s.host) document.getElementById('ssh-host').value = s.host;
    if (s.port) document.getElementById('ssh-port').value = s.port;
    if (s.username) document.getElementById('ssh-username').value = s.username;
    if (s.authMethod) {
      document.getElementById('ssh-auth-method').value = s.authMethod;
      document.getElementById('ssh-auth-method').dispatchEvent(new Event('change'));
    }
    if (s.privateKeyPath) {
      const keySelect = document.getElementById('ssh-key-select');
      for (const opt of keySelect.options) {
        if (opt.value === s.privateKeyPath) { keySelect.value = s.privateKeyPath; break; }
      }
    }
    if (s.workingDir) document.getElementById('ssh-workdir').value = s.workingDir;
    if (s.command) {
      const presetSelect = document.getElementById('ssh-command-preset');
      let matched = false;
      for (const opt of presetSelect.options) {
        if (opt.value === s.command) { presetSelect.value = s.command; matched = true; break; }
      }
      if (!matched) {
        presetSelect.value = 'custom';
        document.getElementById('ssh-custom-command').value = s.command;
        document.getElementById('ssh-custom-command').classList.remove('hidden');
      }
      presetSelect.dispatchEvent(new Event('change'));
    }
    if (s.terminalTheme) {
      const themeSelect = document.getElementById('ssh-terminal-theme');
      if (themeSelect) themeSelect.value = s.terminalTheme;
    }
  } catch (e) {
    debugWarn('[quickActions] Failed to restore last session:', e);
  }
}

function formatAge(ts) {
  if (!ts) return '';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function localEscapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---- Quick Session Modal ----
function initQuickSessionModal() {
  const modal = document.getElementById('quick-session-modal');
  if (!modal) return;

  document.getElementById('quick-session-close')?.addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('quick-session-cancel')?.addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('quick-session-launch')?.addEventListener('click', async () => {
    const launchBtn = document.getElementById('quick-session-launch');
    const label = document.getElementById('quick-label-input').value.trim();
    const workingDir = document.getElementById('quick-workdir')?.value.trim() || '~';

    const saved = (() => {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.LAST_SESSION) || '{}'); } catch { return {}; }
    })();

    if (!saved.username) {
      showToast('ERROR', 'No saved session config. Use "+ NEW SESSION" first.');
      return;
    }

    launchBtn.disabled = true;
    launchBtn.textContent = 'LAUNCHING...';
    try {
      const body = {
        host: saved.host || 'localhost',
        port: saved.port || 22,
        username: saved.username,
        authMethod: saved.authMethod || 'key',
        privateKeyPath: saved.privateKeyPath,
        workingDir: workingDir,
        command: saved.command || 'claude',
        terminalTheme: saved.terminalTheme || 'default',
        label: label || undefined,
      };

      const globalKey = getApiKeyForCommand(body.command);
      if (globalKey) body.apiKey = globalKey;

      const resp = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Connection failed');

      if (label) saveLabel(label);

      try {
        const lastSession = JSON.parse(localStorage.getItem(STORAGE_KEYS.LAST_SESSION) || '{}');
        lastSession.workingDir = workingDir;
        localStorage.setItem(STORAGE_KEYS.LAST_SESSION, JSON.stringify(lastSession));
      } catch (_) {}

      modal.classList.add('hidden');

      terminalManager.setTerminalTheme(result.terminalId, body.terminalTheme);

      if (label === LABELS.HEAVY) {
        setTimeout(() => pinSession(result.terminalId), 500);
        showToast('HEAVY SESSION', 'High-priority session launched & pinned');
      } else if (label === LABELS.IMPORTANT) {
        setTimeout(() => pinSession(result.terminalId), 500);
        showToast('IMPORTANT SESSION', 'Important session launched & pinned \u2014 alert on completion');
      } else if (label === LABELS.ONEOFF) {
        showToast('ONEOFF SESSION', 'One-off session launched \u2014 review when done');
      } else {
        showToast('CONNECTED', 'Quick session launched');
      }
    } catch (e) {
      showToast('ERROR', e.message);
    } finally {
      launchBtn.disabled = false;
      launchBtn.textContent = 'LAUNCH';
    }
  });
}

// ---- New Session Modal ----
function initNewSessionModal() {
  const modal = document.getElementById('new-session-modal');
  if (!modal) return;

  document.getElementById('new-session-close')?.addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('ssh-cancel')?.addEventListener('click', () => modal.classList.add('hidden'));

  document.getElementById('ssh-auth-method')?.addEventListener('change', (e) => {
    const val = e.target.value;
    document.getElementById('ssh-password-row').classList.toggle('hidden', val !== 'password');
    document.getElementById('ssh-key-row').classList.toggle('hidden', val !== 'key');
  });

  document.getElementById('ssh-command-preset')?.addEventListener('change', (e) => {
    document.getElementById('ssh-custom-row').classList.toggle('hidden', e.target.value !== 'custom');
  });

  // Session mode toggle
  let selectedTmuxSession = null;
  let currentSshMode = 'new';
  document.querySelectorAll('.ssh-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ssh-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSshMode = btn.dataset.mode;
      const tmuxRow = document.getElementById('ssh-tmux-row');
      tmuxRow.classList.toggle('hidden', currentSshMode !== 'tmux-attach');
      selectedTmuxSession = null;
      const commandFields = [document.getElementById('ssh-command-preset')?.closest('.ssh-field'), document.getElementById('ssh-custom-row')];
      commandFields.forEach(el => { if (el) el.classList.toggle('hidden', currentSshMode === 'tmux-attach'); });
    });
  });

  document.getElementById('ssh-tmux-refresh')?.addEventListener('click', () => fetchTmuxSessions());

  async function fetchTmuxSessions() {
    const listEl = document.getElementById('ssh-tmux-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="ssh-tmux-loading">Loading...</div>';
    selectedTmuxSession = null;
    try {
      const body = {
        host: document.getElementById('ssh-host').value,
        port: parseInt(document.getElementById('ssh-port').value) || 22,
        username: document.getElementById('ssh-username').value,
        authMethod: document.getElementById('ssh-auth-method').value,
        password: document.getElementById('ssh-password').value || undefined,
        privateKeyPath: document.getElementById('ssh-key-select').value,
      };
      const resp = await fetch('/api/tmux-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to list tmux sessions');
      if (!data.sessions || data.sessions.length === 0) {
        listEl.innerHTML = '<div class="ssh-tmux-empty">No tmux sessions found</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const s of data.sessions) {
        const item = document.createElement('div');
        item.className = 'ssh-tmux-item';
        item.dataset.name = s.name;
        const age = formatAge(s.created);
        item.innerHTML = `
          <span class="ssh-tmux-name">${localEscapeHtml(s.name)}</span>
          <span class="ssh-tmux-meta">${s.windows} win${s.windows !== 1 ? 's' : ''} \u00B7 ${s.attached ? 'attached' : 'detached'} \u00B7 ${age}</span>
        `;
        item.addEventListener('click', () => {
          listEl.querySelectorAll('.ssh-tmux-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
          selectedTmuxSession = s.name;
        });
        listEl.appendChild(item);
      }
    } catch (e) {
      listEl.innerHTML = `<div class="ssh-tmux-empty ssh-tmux-error">${localEscapeHtml(e.message)}</div>`;
    }
  }

  // Connect & Launch
  document.getElementById('ssh-connect')?.addEventListener('click', async () => {
    const connectBtn = document.getElementById('ssh-connect');

    if (currentSshMode === 'tmux-attach' && !selectedTmuxSession) {
      showToast('ERROR', 'Select a tmux session to attach');
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'CONNECTING...';
    try {
      const labelVal = document.getElementById('ssh-session-label')?.value.trim() || undefined;
      const body = {
        host: document.getElementById('ssh-host').value,
        port: parseInt(document.getElementById('ssh-port').value) || 22,
        username: document.getElementById('ssh-username').value,
        authMethod: document.getElementById('ssh-auth-method').value,
        password: document.getElementById('ssh-password').value || undefined,
        privateKeyPath: document.getElementById('ssh-key-select').value,
        workingDir: document.getElementById('ssh-workdir').value,
        command: getSelectedCommand(),
        apiKey: document.getElementById('ssh-api-key')?.value || getApiKeyForCommand(getSelectedCommand()) || undefined,
        terminalTheme: document.getElementById('ssh-terminal-theme')?.value || 'default',
        sessionTitle: document.getElementById('ssh-session-title')?.value || undefined,
        label: labelVal,
      };

      if (currentSshMode === 'tmux-attach') {
        body.tmuxSession = selectedTmuxSession;
      } else if (currentSshMode === 'tmux-wrap') {
        body.useTmux = true;
      }
      const resp = await fetch('/api/terminals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Connection failed');

      try {
        localStorage.setItem(STORAGE_KEYS.LAST_SESSION, JSON.stringify({
          host: body.host,
          port: body.port,
          username: body.username,
          authMethod: body.authMethod,
          privateKeyPath: body.privateKeyPath,
          workingDir: body.workingDir,
          command: getSelectedCommand(),
          terminalTheme: body.terminalTheme,
        }));
      } catch (_) {}

      if (labelVal) saveLabel(labelVal);

      modal.classList.add('hidden');
      showToast('CONNECTED', `Terminal ${result.terminalId} launched`);

      const theme = document.getElementById('ssh-terminal-theme')?.value || 'default';
      terminalManager.setTerminalTheme(result.terminalId, theme);
    } catch (e) {
      showToast('ERROR', e.message);
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'CONNECT & LAUNCH';
    }
  });
}

function openQuickModalWithLabel(label) {
  const modal = document.getElementById('quick-session-modal');
  modal.classList.remove('hidden');
  document.getElementById('quick-label-input').value = label;
  populateQuickLabelChips();
  populateLabelSuggestions('quick-label-suggestions');
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.LAST_SESSION) || '{}'); } catch { return {}; }
  })();
  const workdirInput = document.getElementById('quick-workdir');
  if (workdirInput) workdirInput.value = saved.workingDir || '~';
}

export function initQuickActions() {
  const muteAllBtn = document.getElementById('qa-mute-all');
  if (muteAllBtn) {
    muteAllBtn.addEventListener('click', () => {
      const muted = toggleMuteAll();
      muteAllBtn.innerHTML = muted ? '&#9835; UNMUTE ALL' : '&#9835; MUTE ALL';
      muteAllBtn.title = muted ? 'Unmute all sessions' : 'Mute all sessions';
      muteAllBtn.classList.toggle('active', muted);
    });
  }

  const archiveBtn = document.getElementById('qa-archive-ended');
  if (archiveBtn) {
    archiveBtn.addEventListener('click', () => archiveAllEnded());
  }

  // + NEW SESSION button
  const newSessionBtn = document.getElementById('qa-new-session');
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', () => {
      const modal = document.getElementById('new-session-modal');
      modal.classList.remove('hidden');
      loadSshKeys().then(restoreLastSession);
      populateLabelSuggestions('label-suggestions');
    });
  }

  // QUICK SESSION button
  const quickBtn = document.getElementById('qa-quick-session');
  if (quickBtn) {
    quickBtn.addEventListener('click', () => openQuickModalWithLabel(''));
  }

  // ONEOFF button
  const oneoffBtn = document.getElementById('qa-oneoff');
  if (oneoffBtn) {
    oneoffBtn.addEventListener('click', () => openQuickModalWithLabel(LABELS.ONEOFF));
  }

  // HEAVY button
  const heavyBtn = document.getElementById('qa-heavy');
  if (heavyBtn) {
    heavyBtn.addEventListener('click', () => openQuickModalWithLabel(LABELS.HEAVY));
  }

  // IMPORTANT button
  const importantBtn = document.getElementById('qa-important');
  if (importantBtn) {
    importantBtn.addEventListener('click', () => openQuickModalWithLabel(LABELS.IMPORTANT));
  }

  // Quick Session modal buttons
  initQuickSessionModal();

  // New Session modal buttons
  initNewSessionModal();

  // Nav actions collapse/expand toggle
  const navActionsToggle = document.getElementById('nav-actions-toggle');
  const navActions = document.getElementById('nav-actions');
  if (navActionsToggle && navActions) {
    navActionsToggle.addEventListener('click', () => {
      navActions.classList.toggle('collapsed');
    });
  }

  // Activity feed collapse/expand toggle
  const feedCollapseBtn = document.getElementById('feed-collapse-btn');
  const feedEl = document.getElementById('activity-feed');
  if (feedCollapseBtn && feedEl) {
    feedCollapseBtn.addEventListener('click', () => {
      feedEl.classList.toggle('collapsed');
    });
  }
}

// Shortcuts panel
export function initShortcutsPanel() {
  const btn = document.getElementById('shortcuts-btn');
  const modal = document.getElementById('shortcuts-modal');
  const closeBtn = document.getElementById('shortcuts-close');
  if (!btn || !modal) return;

  btn.addEventListener('click', () => modal.classList.toggle('hidden'));
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}
