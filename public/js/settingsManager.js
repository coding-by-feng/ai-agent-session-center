// settingsManager.js — Settings persistence and event system

const defaults = {
  theme: 'command-center',
  fontSize: '13',
  soundEnabled: 'true',
  soundVolume: '0.5',
  soundActions: '',
  scanlineEnabled: 'true',
  cardSize: 'small',
  activityFeedVisible: 'true',
  characterModel: 'robot',
  animationIntensity: '100',
  animationSpeed: '100',
  movementActions: ''
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

// Apply animation intensity (0-200, default 100)
export function applyAnimationIntensity(value) {
  const v = parseFloat(value) / 100;
  document.documentElement.style.setProperty('--anim-intensity', v);
}

// Apply animation speed (30-200, default 100 → lower = faster)
export function applyAnimationSpeed(value) {
  const v = parseFloat(value) / 100;
  document.documentElement.style.setProperty('--anim-speed', v);
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
  applyAnimationIntensity(get('animationIntensity'));
  applyAnimationSpeed(get('animationSpeed'));
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
  applyAnimationIntensity(defaults.animationIntensity);
  applyAnimationSpeed(defaults.animationSpeed);
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

  // Character model
  const currentModel = get('characterModel');
  document.querySelectorAll('.char-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.model === currentModel);
  });

  // Animation intensity
  const animIntensity = get('animationIntensity');
  applyAnimationIntensity(animIntensity);
  const intSlider = document.getElementById('anim-intensity-slider');
  const intDisplay = document.getElementById('anim-intensity-display');
  if (intSlider) intSlider.value = animIntensity;
  if (intDisplay) intDisplay.textContent = animIntensity + '%';

  // Animation speed
  const animSpeed = get('animationSpeed');
  applyAnimationSpeed(animSpeed);
  const spdSlider = document.getElementById('anim-speed-slider');
  const spdDisplay = document.getElementById('anim-speed-display');
  if (spdSlider) spdSlider.value = animSpeed;
  if (spdDisplay) spdDisplay.textContent = animSpeed + '%';

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

  // --- Animation intensity slider ---
  const intensitySlider = document.getElementById('anim-intensity-slider');
  const intensityDisplay = document.getElementById('anim-intensity-display');
  if (intensitySlider && intensityDisplay) {
    intensitySlider.addEventListener('input', () => {
      const val = intensitySlider.value;
      intensityDisplay.textContent = val + '%';
      applyAnimationIntensity(val);
      set('animationIntensity', val);
    });
  }

  // --- Animation speed slider ---
  const speedSlider = document.getElementById('anim-speed-slider');
  const speedDisplay = document.getElementById('anim-speed-display');
  if (speedSlider && speedDisplay) {
    speedSlider.addEventListener('input', () => {
      const val = speedSlider.value;
      speedDisplay.textContent = val + '%';
      applyAnimationSpeed(val);
      set('animationSpeed', val);
    });
  }

  // --- Character model ---
  const charGrid = document.getElementById('char-model-grid');
  if (charGrid) {
    charGrid.addEventListener('click', async (e) => {
      const swatch = e.target.closest('.char-swatch');
      if (!swatch) return;
      const model = swatch.dataset.model;
      document.querySelectorAll('.char-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      await set('characterModel', model);
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

  // Build per-action movement effect grid
  initMovementGrid();

  // Build summary prompt template management
  initSummaryPromptSettings();
}

/**
 * Shared per-action config grid component.
 * Used by both sound and movement settings.
 *
 * @param {HTMLElement} grid - container element
 * @param {Object} opts
 * @param {Object|string[]} opts.library - available options: { key: label } or [name, ...]
 * @param {Object} opts.currentMapping - action -> current value
 * @param {Object} opts.labels - action -> display label
 * @param {Object} opts.categories - category -> [action, ...]
 * @param {Function} opts.onChange - (action, value) => void
 * @param {Function} [opts.onPreview] - (value) => void (adds preview button if provided)
 */
function buildActionGrid(grid, opts) {
  const { library, currentMapping, labels, categories, onChange, onPreview } = opts;

  // Normalize library to [{ value, label }]
  let options;
  if (Array.isArray(library)) {
    options = library.map(s => ({ value: s, label: s }));
  } else {
    options = Object.entries(library).map(([val, lbl]) => ({ value: val, label: lbl }));
  }

  let html = '';
  for (const [category, actions] of Object.entries(categories)) {
    html += `<div class="sound-category-label">${category}</div>`;
    for (const action of actions) {
      const current = currentMapping[action] || 'none';
      const optionsHtml = options.map(o =>
        `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`
      ).join('');
      html += `<div class="sound-action-row">` +
        `<span class="sound-action-label">${labels[action] || action}</span>` +
        `<select class="sound-action-select" data-action="${action}">${optionsHtml}</select>` +
        (onPreview ? `<button class="sound-preview-btn" data-action="${action}" title="Preview">&#9654;</button>` : '') +
        `</div>`;
    }
  }
  grid.innerHTML = html;

  grid.addEventListener('change', (e) => {
    const sel = e.target.closest('.sound-action-select');
    if (!sel) return;
    onChange(sel.dataset.action, sel.value);
  });

  if (onPreview) {
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.sound-preview-btn');
      if (!btn) return;
      const action = btn.dataset.action;
      const sel = grid.querySelector(`.sound-action-select[data-action="${action}"]`);
      if (sel) onPreview(sel.value);
    });
  }
}

async function initMovementGrid() {
  const movementManager = await import('./movementManager.js');
  const robotManager = await import('./robotManager.js');
  const grid = document.getElementById('movement-action-grid');
  if (!grid) return;

  // Render preview character in the viewport
  const viewport = document.getElementById('movement-preview-viewport');
  if (viewport) {
    const templates = robotManager._getTemplates();
    const currentModel = get('characterModel') || 'robot';
    const templateFn = templates[currentModel] || templates.robot;

    // Clear placeholder label, render character
    viewport.innerHTML = '';
    const previewChar = document.createElement('div');
    previewChar.className = `css-robot char-${currentModel}`;
    previewChar.dataset.status = 'idle';
    previewChar.style.setProperty('--robot-color', '#00e5ff');
    previewChar.innerHTML = templateFn('#00e5ff');
    viewport.appendChild(previewChar);

    // Effect name label
    const nameLabel = document.createElement('div');
    nameLabel.className = 'movement-preview-effect-name';
    viewport.appendChild(nameLabel);

    // Store ref for preview callback
    viewport._previewChar = previewChar;
    viewport._nameLabel = nameLabel;
    viewport._clearTimer = null;
  }

  buildActionGrid(grid, {
    library: movementManager.getEffectLibrary(),
    currentMapping: movementManager.getActionEffects(),
    labels: movementManager.getActionLabels(),
    categories: movementManager.getActionCategories(),
    onChange: (action, value) => movementManager.setActionEffect(action, value),
    onPreview: (effectName) => {
      if (!viewport || !viewport._previewChar) return;
      const char = viewport._previewChar;
      const label = viewport._nameLabel;

      // Clear previous
      if (viewport._clearTimer) clearTimeout(viewport._clearTimer);
      char.removeAttribute('data-movement');
      void char.offsetWidth; // force reflow for re-trigger

      if (effectName === 'none') {
        label.textContent = '';
        label.classList.remove('visible');
        return;
      }

      // Apply effect
      char.setAttribute('data-movement', effectName);
      const lib = movementManager.getEffectLibrary();
      label.textContent = lib[effectName] || effectName;
      label.classList.add('visible');

      // Auto-clear after 3.5s
      viewport._clearTimer = setTimeout(() => {
        char.removeAttribute('data-movement');
        label.classList.remove('visible');
      }, 3500);
    },
  });
}

async function initSoundGrid() {
  const soundManager = await import('./soundManager.js');
  const grid = document.getElementById('sound-action-grid');
  if (!grid) return;

  buildActionGrid(grid, {
    library: soundManager.getSoundLibrary(),
    currentMapping: soundManager.getActionSounds(),
    labels: soundManager.getActionLabels(),
    categories: soundManager.getActionCategories(),
    onChange: (action, value) => soundManager.setActionSound(action, value),
    onPreview: (value) => soundManager.previewSound(value),
  });
}

// ---- Summary Prompt Template Settings ----

async function initSummaryPromptSettings() {
  const list = document.getElementById('settings-prompt-list');
  const nameInput = document.getElementById('settings-prompt-name');
  const textInput = document.getElementById('settings-prompt-text');
  const saveBtn = document.getElementById('settings-prompt-save');
  const cancelEditBtn = document.getElementById('settings-prompt-cancel-edit');
  if (!list || !nameInput || !textInput || !saveBtn) return;

  let editingId = null;

  async function loadAndRender() {
    try {
      const resp = await fetch('/api/summary-prompts');
      const data = await resp.json();
      renderList(data.prompts || []);
    } catch(e) {
      list.innerHTML = '<div style="color:var(--text-dim);padding:8px">Failed to load prompts</div>';
    }
  }

  function renderList(prompts) {
    list.innerHTML = prompts.map(p => `
      <div class="settings-prompt-item${p.is_default ? ' default' : ''}" data-id="${p.id}">
        <div class="settings-prompt-item-row">
          <button class="settings-prompt-star${p.is_default ? ' active' : ''}" data-id="${p.id}" title="${p.is_default ? 'Default' : 'Set as default'}">&#9733;</button>
          <span class="settings-prompt-item-name">${escapeHtml(p.name)}</span>
          ${p.is_default ? '<span class="settings-prompt-badge">DEFAULT</span>' : ''}
          <button class="settings-prompt-edit" data-id="${p.id}" title="Edit">&#9998;</button>
          <button class="settings-prompt-del" data-id="${p.id}" title="Delete">&times;</button>
        </div>
        <div class="settings-prompt-item-preview">${escapeHtml(p.prompt).substring(0, 120)}${p.prompt.length > 120 ? '...' : ''}</div>
      </div>
    `).join('') || '<div style="color:var(--text-dim);padding:8px">No prompt templates</div>';

    // Star (set default)
    list.querySelectorAll('.settings-prompt-star').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/summary-prompts/${btn.dataset.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_default: true })
        });
        loadAndRender();
      });
    });

    // Edit
    list.querySelectorAll('.settings-prompt-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id, 10);
        const resp = await fetch('/api/summary-prompts');
        const data = await resp.json();
        const p = (data.prompts || []).find(x => x.id === id);
        if (!p) return;
        editingId = id;
        nameInput.value = p.name;
        textInput.value = p.prompt;
        saveBtn.textContent = 'Update Template';
        cancelEditBtn.classList.remove('hidden');
      });
    });

    // Delete
    list.querySelectorAll('.settings-prompt-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/summary-prompts/${btn.dataset.id}`, { method: 'DELETE' });
        loadAndRender();
      });
    });
  }

  // Save / Update
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const prompt = textInput.value.trim();
    if (!name || !prompt) return;

    if (editingId) {
      await fetch(`/api/summary-prompts/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt })
      });
    } else {
      await fetch('/api/summary-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt })
      });
    }
    nameInput.value = '';
    textInput.value = '';
    editingId = null;
    saveBtn.textContent = 'Add Template';
    cancelEditBtn.classList.add('hidden');
    loadAndRender();
  });

  // Cancel edit
  cancelEditBtn.addEventListener('click', () => {
    editingId = null;
    nameInput.value = '';
    textInput.value = '';
    saveBtn.textContent = 'Add Template';
    cancelEditBtn.classList.add('hidden');
  });

  loadAndRender();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
