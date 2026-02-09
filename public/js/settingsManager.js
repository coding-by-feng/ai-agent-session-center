// settingsManager.js — Settings persistence and event system

const defaults = {
  theme: 'command-center',
  fontSize: '13',
  soundEnabled: 'true',
  soundVolume: '0.5',
  soundActions: '',
  scanlineEnabled: 'true',
  cardSize: 'normal',
  activityFeedVisible: 'true'
};

let settings = { ...defaults };
const listeners = new Map(); // key -> Set of callbacks

export async function loadSettings() {
  try {
    const resp = await fetch('/api/settings');
    const data = await resp.json();
    settings = { ...defaults, ...data.settings };
  } catch (e) {
    console.error('[settings] Failed to load:', e.message);
  }
  return settings;
}

export function get(key) {
  return settings[key] ?? defaults[key];
}

export function getAll() {
  return { ...settings };
}

export async function set(key, value) {
  settings[key] = value;
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: String(value) })
    });
    flashAutosave();
  } catch (e) {
    console.error('[settings] Failed to save:', e.message);
  }
  // Notify listeners
  const cbs = listeners.get(key);
  if (cbs) cbs.forEach(cb => cb(value));
}

export function onChange(key, callback) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(callback);
}

// Apply theme to body
export function applyTheme(themeName) {
  if (themeName === 'command-center') {
    document.body.removeAttribute('data-theme');
  } else {
    document.body.setAttribute('data-theme', themeName);
  }
}

// Apply font size
export function applyFontSize(size) {
  document.documentElement.style.fontSize = size + 'px';
}

// Apply scanline setting
export function applyScanline(enabled) {
  document.body.classList.toggle('no-scanlines', enabled !== 'true');
}

// Apply card size
export function applyCardSize(size) {
  if (size === 'normal') {
    document.body.removeAttribute('data-card-size');
  } else {
    document.body.setAttribute('data-card-size', size);
  }
}

// Apply activity feed visibility
export function applyActivityFeed(visible) {
  const feed = document.getElementById('activity-feed');
  if (feed) feed.style.display = visible === 'true' ? '' : 'none';
}

// Flash autosave indicator
function flashAutosave() {
  const el = document.getElementById('settings-autosave');
  if (!el) return;
  el.classList.remove('visible');
  void el.offsetWidth; // force reflow
  el.classList.add('visible');
}

// Export all settings as JSON file download
export function exportSettings() {
  const data = JSON.stringify(getAll(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'claude-dashboard-settings.json';
  a.click();
  URL.revokeObjectURL(url);
}

// Import settings from JSON file
export async function importSettings(file) {
  const text = await file.text();
  const imported = JSON.parse(text);
  for (const [key, value] of Object.entries(imported)) {
    await set(key, value);
  }
  // Re-apply all visual settings
  applyTheme(get('theme'));
  applyFontSize(get('fontSize'));
  applyScanline(get('scanlineEnabled'));
  applyCardSize(get('cardSize'));
  applyActivityFeed(get('activityFeedVisible'));
  // Refresh the UI to reflect imported values
  syncUIToSettings();
}

// Reset all settings to defaults
export async function resetDefaults() {
  for (const [key, value] of Object.entries(defaults)) {
    await set(key, value);
  }
  applyTheme(defaults.theme);
  applyFontSize(defaults.fontSize);
  applyScanline(defaults.scanlineEnabled);
  applyCardSize(defaults.cardSize);
  applyActivityFeed(defaults.activityFeedVisible);
  syncUIToSettings();
}

// Sync all UI controls to current settings state
function syncUIToSettings() {
  const currentTheme = get('theme');
  applyTheme(currentTheme);
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === currentTheme);
  });

  const fontSize = get('fontSize');
  applyFontSize(fontSize);
  const slider = document.getElementById('font-size-slider');
  const display = document.getElementById('font-size-display');
  if (slider) slider.value = fontSize;
  if (display) display.textContent = fontSize + 'px';

  const soundEn = document.getElementById('sound-enabled');
  if (soundEn) soundEn.checked = get('soundEnabled') === 'true';
  const soundVol = document.getElementById('sound-volume');
  if (soundVol) soundVol.value = get('soundVolume');
  const volDisplay = document.getElementById('volume-display');
  if (volDisplay) volDisplay.textContent = Math.round(parseFloat(get('soundVolume')) * 100) + '%';

  const scanlineEl = document.getElementById('scanline-enabled');
  if (scanlineEl) scanlineEl.checked = get('scanlineEnabled') === 'true';
  applyScanline(get('scanlineEnabled'));

  const cardSize = get('cardSize');
  applyCardSize(cardSize);
  document.querySelectorAll('.card-size-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.size === cardSize);
  });

  const feedEl = document.getElementById('activity-feed-visible');
  if (feedEl) feedEl.checked = get('activityFeedVisible') === 'true';
  applyActivityFeed(get('activityFeedVisible'));
}

// Initialize settings UI bindings
export function initSettingsUI() {
  // Open/close settings
  document.getElementById('open-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('hidden');
  });
  document.getElementById('close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
  });
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') {
      document.getElementById('settings-modal').classList.add('hidden');
    }
  });

  // --- Settings tab switching ---
  let lastSettingsTab = 'appearance';
  document.querySelector('.settings-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.settings-tab');
    if (!tab) return;
    const tabName = tab.dataset.settingsTab;
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const content = document.getElementById('settings-tab-' + tabName);
    if (content) content.classList.add('active');
    lastSettingsTab = tabName;
  });

  // Theme selection
  document.getElementById('theme-grid').addEventListener('click', (e) => {
    const swatch = e.target.closest('.theme-swatch');
    if (!swatch) return;
    const theme = swatch.dataset.theme;
    document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    applyTheme(theme);
    set('theme', theme);
  });

  // Font size controls
  const slider = document.getElementById('font-size-slider');
  const display = document.getElementById('font-size-display');
  slider.addEventListener('input', () => {
    const val = slider.value;
    display.textContent = val + 'px';
    applyFontSize(val);
    set('fontSize', val);
  });
  document.getElementById('font-decrease').addEventListener('click', () => {
    const val = Math.max(10, parseInt(slider.value) - 1);
    slider.value = val;
    display.textContent = val + 'px';
    applyFontSize(val);
    set('fontSize', String(val));
  });
  document.getElementById('font-increase').addEventListener('click', () => {
    const val = Math.min(20, parseInt(slider.value) + 1);
    slider.value = val;
    display.textContent = val + 'px';
    applyFontSize(val);
    set('fontSize', String(val));
  });

  // --- Scanline toggle ---
  const scanlineCheckbox = document.getElementById('scanline-enabled');
  if (scanlineCheckbox) {
    scanlineCheckbox.addEventListener('change', (e) => {
      const enabled = String(e.target.checked);
      applyScanline(enabled);
      set('scanlineEnabled', enabled);
    });
  }

  // --- Card size ---
  const cardSizeControl = document.getElementById('card-size-control');
  if (cardSizeControl) {
    cardSizeControl.addEventListener('click', (e) => {
      const btn = e.target.closest('.card-size-btn');
      if (!btn) return;
      const size = btn.dataset.size;
      document.querySelectorAll('.card-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyCardSize(size);
      set('cardSize', size);
    });
  }

  // Sound controls
  document.getElementById('sound-enabled').addEventListener('change', (e) => {
    set('soundEnabled', String(e.target.checked));
  });
  document.getElementById('sound-volume').addEventListener('input', (e) => {
    const vol = e.target.value;
    document.getElementById('volume-display').textContent = Math.round(vol * 100) + '%';
    set('soundVolume', vol);
  });

  // --- Import / Export ---
  const exportBtn = document.getElementById('export-settings');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportSettings());
  }
  const importBtn = document.getElementById('import-settings-btn');
  const importFile = document.getElementById('import-settings-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        await importSettings(file);
      } catch (err) {
        console.error('[settings] Import failed:', err.message);
      }
      importFile.value = '';
    });
  }

  // --- Reset to defaults ---
  const resetBtn = document.getElementById('reset-defaults');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await resetDefaults();
    });
  }

  // --- Activity feed toggle ---
  const feedToggle = document.getElementById('activity-feed-visible');
  if (feedToggle) {
    feedToggle.addEventListener('change', (e) => {
      const visible = String(e.target.checked);
      applyActivityFeed(visible);
      set('activityFeedVisible', visible);
    });
  }

  // --- Apply all current settings to UI ---
  syncUIToSettings();

  // Build per-action sound config grid (deferred import to avoid circular)
  initSoundGrid();
}

async function initSoundGrid() {
  const soundManager = await import('./soundManager.js');
  const grid = document.getElementById('sound-action-grid');
  if (!grid) return;

  const library = soundManager.getSoundLibrary();
  const currentMapping = soundManager.getActionSounds();
  const labels = soundManager.getActionLabels();
  const categories = soundManager.getActionCategories();

  let html = '';
  for (const [category, actions] of Object.entries(categories)) {
    html += `<div class="sound-category-label">${category}</div>`;
    for (const action of actions) {
      const current = currentMapping[action] || 'none';
      const options = library.map(s =>
        `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`
      ).join('');
      html += `<div class="sound-action-row">` +
        `<span class="sound-action-label">${labels[action] || action}</span>` +
        `<select class="sound-action-select" data-action="${action}">${options}</select>` +
        `<button class="sound-preview-btn" data-action="${action}" title="Preview">&#9654;</button>` +
        `</div>`;
    }
  }
  grid.innerHTML = html;

  // Wire dropdowns
  grid.addEventListener('change', (e) => {
    const sel = e.target.closest('.sound-action-select');
    if (!sel) return;
    soundManager.setActionSound(sel.dataset.action, sel.value);
  });

  // Wire preview buttons
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.sound-preview-btn');
    if (!btn) return;
    const action = btn.dataset.action;
    const sel = grid.querySelector(`.sound-action-select[data-action="${action}"]`);
    if (sel) soundManager.previewSound(sel.value);
  });
}
