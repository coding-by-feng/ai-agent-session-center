// terminalManager.js — Frontend terminal module using xterm.js
// Manages terminal lifecycle, I/O relay through WebSocket, and tab attachment.
// Uses canvas renderer, Unicode11, WebLinks, and FitAddon (same stack as AWS/Azure Cloud Shell).
import { debugWarn } from './utils.js';
import { onChange as onSettingChange } from './settingsManager.js';

let ws = null;
let activeTerminal = null;  // { terminalId, term, fitAddon, resizeObserver }
let terminalSessions = {};  // terminalId -> sessionId mapping
let terminalThemes = {};    // terminalId -> theme name
let pendingOutput = {};     // terminalId -> [base64Data] — buffer output before terminal is ready
let isFullscreen = false;
let hasReceivedFirstOutput = false;  // true once the active terminal gets its first data

/** Return appropriate font size based on viewport width */
function getResponsiveFontSize() {
  const width = window.innerWidth;
  if (width <= 480) return 11;
  if (width <= 640) return 12;
  return 14;
}

const THEMES = {
  default: {
    background: '#0a0a1a', foreground: '#e0e0e0', cursor: '#e0e0e0', cursorAccent: '#0a0a1a',
    selectionBackground: 'rgba(0,229,255,0.3)', selectionForeground: '#ffffff',
    black: '#0a0a1a', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#6272a4', magenta: '#ff79c6', cyan: '#00e5ff', white: '#e0e0e0',
    brightBlack: '#555555', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  dark: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(255,255,255,0.15)', selectionForeground: '#ffffff',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
    blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
    brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
    brightCyan: '#29b8db', brightWhite: '#ffffff',
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#272822',
    selectionBackground: 'rgba(73,72,62,0.6)', selectionForeground: '#ffffff',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
    blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
    brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
    selectionBackground: 'rgba(68,71,90,0.6)', selectionForeground: '#ffffff',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#839496', cursor: '#839496', cursorAccent: '#002b36',
    selectionBackground: 'rgba(7,54,66,0.6)', selectionForeground: '#93a1a1',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
    selectionBackground: 'rgba(67,76,94,0.6)', selectionForeground: '#eceff4',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  'github-dark': {
    background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9', cursorAccent: '#0d1117',
    selectionBackground: 'rgba(56,139,253,0.25)', selectionForeground: '#ffffff',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
};

/**
 * Build a terminal theme dynamically from the current website CSS variables.
 * Falls back to the 'default' THEMES entry for any variable that isn't set.
 */
function buildAutoTheme() {
  const s = getComputedStyle(document.body);
  const v = (name) => s.getPropertyValue(name).trim();

  const bg = v('--bg-primary') || THEMES.default.background;
  const fg = v('--text-primary') || THEMES.default.foreground;

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: 'rgba(255,255,255,0.18)',
    selectionForeground: '#ffffff',
    black: bg,
    red: v('--accent-red') || THEMES.default.red,
    green: v('--accent-green') || THEMES.default.green,
    yellow: v('--accent-orange') || THEMES.default.yellow,
    blue: v('--accent-cyan') || THEMES.default.blue,
    magenta: v('--accent-purple') || THEMES.default.magenta,
    cyan: v('--accent-cyan') || THEMES.default.cyan,
    white: fg,
    brightBlack: v('--text-dim') || THEMES.default.brightBlack,
    brightRed: v('--accent-red') || THEMES.default.brightRed,
    brightGreen: v('--accent-green') || THEMES.default.brightGreen,
    brightYellow: v('--accent-orange') || THEMES.default.brightYellow,
    brightBlue: v('--accent-cyan') || THEMES.default.brightBlue,
    brightMagenta: v('--accent-purple') || THEMES.default.brightMagenta,
    brightCyan: v('--accent-cyan') || THEMES.default.brightCyan,
    brightWhite: '#ffffff',
  };
}

export function setWs(websocket) {
  ws = websocket;
  // Re-subscribe active terminal after WS reconnect so output keeps flowing.
  // Clear the terminal first — the server will replay its ring buffer, which
  // would otherwise duplicate content that's already on screen.
  if (activeTerminal && ws && ws.readyState === 1) {
    activeTerminal.term.clear();
    ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId: activeTerminal.terminalId }));
  }
}

export function setTerminalTheme(terminalId, themeName) {
  terminalThemes[terminalId] = themeName;
}

/** Get theme names for populating UI selectors */
export function getThemeNames() {
  return Object.keys(THEMES);
}

function getTheme(terminalId) {
  const name = terminalThemes[terminalId] || 'auto';
  if (name === 'auto') return buildAutoTheme();
  return THEMES[name] || THEMES.default;
}

/**
 * Apply a theme to the active terminal at runtime.
 * Updates the xterm options, syncs the container background, and persists
 * the choice to localStorage.
 */
export function applyTheme(themeName) {
  if (!activeTerminal) return;
  const resolvedName = (themeName === 'auto' || THEMES[themeName]) ? themeName : 'auto';
  const theme = resolvedName === 'auto' ? buildAutoTheme() : THEMES[resolvedName];

  // Store for this terminal and persist globally
  terminalThemes[activeTerminal.terminalId] = resolvedName;
  try { localStorage.setItem('terminal-theme', resolvedName); } catch {}

  // Apply to the live terminal — xterm re-renders immediately
  activeTerminal.term.options.theme = theme;

  // Sync the container background so the border area matches
  const container = document.getElementById('terminal-container');
  if (container) container.style.background = theme.background;
  const fsContainer = document.getElementById('terminal-fullscreen-container');
  if (fsContainer) fsContainer.style.background = theme.background;
  const fsOverlay = document.getElementById('terminal-fullscreen-overlay');
  if (fsOverlay) fsOverlay.style.background = theme.background;

  // Update the select UI
  const select = document.getElementById('terminal-theme-select');
  if (select && select.value !== resolvedName) select.value = resolvedName;
}

function sendResize(terminalId, cols, rows) {
  if (ws && ws.readyState === 1 && cols > 0 && rows > 0) {
    ws.send(JSON.stringify({ type: 'terminal_resize', terminalId, cols, rows }));
  }
}

/**
 * Force the xterm.js canvas to repaint by cycling through a real resize.
 *
 * The canvas renderer sometimes fails to paint when the container transitions
 * from hidden → visible.  A single fitAddon.fit() with the same dimensions is
 * a no-op inside xterm, so nothing repaints.  The user discovered that dragging
 * the panel resize handle (which changes container width) makes it appear —
 * because that triggers fit() with *different* cols/rows, which forces xterm to
 * recreate / repaint the canvas.
 *
 * Strategy: resize cols-1 in one frame, then resize back in the next frame.
 * Each resize is a real change so xterm fully redraws its canvas grid.
 * A final setTimeout fallback covers edge cases where rAF is coalesced.
 */
/**
 * Force the xterm.js canvas to repaint by cycling through a real resize.
 *
 * IMPORTANT: Only sends ONE resize to the server (the final correct size)
 * to avoid multiple SIGWINCH → shell redraws that cause content duplication.
 * The intermediate cols-1 resize is local-only (no sendResize).
 */
function forceCanvasRepaint(terminalId, term, fitAddon) {
  const savedCols = term.cols;
  const savedRows = term.rows;

  // Frame 1 — shrink by 1 col locally to force xterm canvas repaint.
  // Do NOT send this intermediate size to the server.
  requestAnimationFrame(() => {
    if (!activeTerminal || activeTerminal.terminalId !== terminalId) return;
    if (savedCols > 2) {
      term.resize(savedCols - 1, savedRows);
    }

    // Frame 2 — restore correct size and send ONE resize to the server
    requestAnimationFrame(() => {
      if (!activeTerminal || activeTerminal.terminalId !== terminalId) return;
      fitAddon.fit();
      sendResize(terminalId, term.cols, term.rows);
    });
  });
}

export function initTerminal(terminalId) {
  detachTerminal();
  hasReceivedFirstOutput = false;

  const container = document.getElementById('terminal-container');
  if (!container) return;
  container.innerHTML = '';

  // Restore persisted theme and sync UI
  const savedTheme = terminalThemes[terminalId]
    || (function() { try { return localStorage.getItem('terminal-theme'); } catch { return null; } })()
    || 'auto';
  terminalThemes[terminalId] = savedTheme;
  const select = document.getElementById('terminal-theme-select');
  if (select) select.value = savedTheme;

  // Sync container background with theme
  const theme = getTheme(terminalId);
  container.style.background = theme.background;

  // Clear stale pending output before subscribing — the server will replay
  // its ring buffer on subscribe, which is more complete than our client buffer.
  delete pendingOutput[terminalId];

  // Subscribe early so the server replays its output buffer and streams new data.
  // Data arriving before doSetup() completes is buffered in pendingOutput.
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId }));
  }

  // Defer setup until container has real dimensions so fitAddon
  // can calculate correct cols/rows.
  function setupWhenReady(retries) {
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      doSetup();
    } else if (retries > 0) {
      requestAnimationFrame(() => setTimeout(() => setupWhenReady(retries - 1), 50));
    } else {
      debugWarn('[terminal] Container never got dimensions — terminal may be hidden');
    }
  }

  function doSetup() {
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: getResponsiveFontSize(),
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.15,
      letterSpacing: 0,
      theme: getTheme(terminalId),
      allowProposedApi: true,
      scrollback: 10000,
      convertEol: false,
      windowsMode: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
    });

    // Load FitAddon
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    // Load Unicode11 for proper wide character / emoji rendering
    try {
      const unicode11 = new Unicode11Addon.Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = '11';
    } catch (e) {
      debugWarn('[terminal] Unicode11 addon not available:', e.message);
    }

    // Load WebLinks for clickable URLs
    try {
      const webLinks = new WebLinksAddon.WebLinksAddon();
      term.loadAddon(webLinks);
    } catch (e) {
      debugWarn('[terminal] WebLinks addon not available:', e.message);
    }

    term.open(container);

    // Escape is the only key we handle manually.  Browsers treat Escape as
    // "exit focus" which blurs the xterm textarea before onData can fire.
    // We block that and send \x1b ourselves.  All other keys go through xterm.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (e.type === 'keydown' && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'terminal_input', terminalId, data: '\x1b' }));
        }
        return false;
      }
      return true;
    });

    // Canvas renderer (default) — same as AWS/Azure Cloud Shell.
    // WebGL addon removed: it caused black screens, context loss on app switch,
    // and required forced refresh hacks. Canvas is stable and performant enough.

    // Container already has dimensions at this point — fit immediately
    fitAddon.fit();
    sendResize(terminalId, term.cols, term.rows);

    // Send keystrokes to server
    term.onData((data) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal_input', terminalId, data }));
      }
    });

    // Also handle binary data (for special keys)
    term.onBinary((data) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal_input', terminalId, data }));
      }
    });

    // Handle resize — debounce to avoid flooding
    let resizeTimer = null;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        sendResize(terminalId, term.cols, term.rows);
      }, 50);
    });
    resizeObserver.observe(container);

    activeTerminal = { terminalId, term, fitAddon, resizeObserver };

    // Flush any buffered output
    if (pendingOutput[terminalId]) {
      for (const data of pendingOutput[terminalId]) {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        term.write(bytes);
      }
      delete pendingOutput[terminalId];
    }

    updateStatus('Connected', 'connected');
    term.focus();

    // Force canvas repaint after initial render.
    // The canvas renderer often fails to paint on the first frame when the
    // container just became visible (panel open / tab switch).  A simple
    // double-rAF + 1px nudge inside the same frame gets optimised away by
    // the browser.  Instead we force xterm.js through a real resize cycle
    // (cols±1 then back) spread across separate tasks so the renderer has
    // time to process each change.  This mirrors what happens when the user
    // drags the panel resize handle — which is known to fix the black screen.
    forceCanvasRepaint(terminalId, term, fitAddon);
  }

  // Start polling — up to ~3s (60 × 50ms) to handle slow panel animations
  setupWhenReady(60);
}

export function onTerminalOutput(terminalId, base64Data) {
  if (activeTerminal && activeTerminal.terminalId === terminalId) {
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    activeTerminal.term.write(bytes);

    // On the first data arriving after terminal init, schedule an extra
    // canvas repaint.  The initial forceCanvasRepaint may fire before any
    // content is written (server replay takes a WS round-trip), so the
    // canvas can still be blank.  One extra refresh after content lands
    // guarantees visibility.
    if (!hasReceivedFirstOutput) {
      hasReceivedFirstOutput = true;
      setTimeout(() => {
        if (activeTerminal && activeTerminal.terminalId === terminalId) {
          activeTerminal.term.refresh(0, activeTerminal.term.rows - 1);
        }
      }, 100);
    }
  } else {
    // Buffer output for when terminal attaches
    if (!pendingOutput[terminalId]) pendingOutput[terminalId] = [];
    pendingOutput[terminalId].push(base64Data);
    // Limit buffer to last 500 chunks
    if (pendingOutput[terminalId].length > 500) pendingOutput[terminalId].shift();
  }
}

export function onTerminalReady(terminalId) {
  if (activeTerminal && activeTerminal.terminalId === terminalId) {
    updateStatus('Terminal ready', 'connected');
    // Only send a resize if fitAddon computes a different size than what we
    // already told the server.  This avoids a redundant SIGWINCH → shell
    // redraw that causes duplicate/overlapping content.
    requestAnimationFrame(() => {
      if (!activeTerminal || !activeTerminal.fitAddon) return;
      const prevCols = activeTerminal.term.cols;
      const prevRows = activeTerminal.term.rows;
      activeTerminal.fitAddon.fit();
      const newCols = activeTerminal.term.cols;
      const newRows = activeTerminal.term.rows;
      if (newCols !== prevCols || newRows !== prevRows) {
        sendResize(terminalId, newCols, newRows);
      }
    });
  }
}

export function onTerminalClosed(terminalId, reason) {
  if (activeTerminal && activeTerminal.terminalId === terminalId) {
    activeTerminal.term.write(`\r\n\x1b[31m--- Terminal ${reason || 'closed'} ---\x1b[0m\r\n`);
    updateStatus(`Disconnected (${reason || 'closed'})`, 'disconnected');
  }
}

export function attachToSession(sessionId, terminalId) {
  if (!terminalId) return;
  terminalSessions[terminalId] = sessionId;
  initTerminal(terminalId);
}

export function detachTerminal() {
  if (isFullscreen) exitFullscreen();
  if (activeTerminal) {
    if (activeTerminal.resizeObserver) {
      activeTerminal.resizeObserver.disconnect();
    }
    activeTerminal.term.dispose();
    activeTerminal = null;
  }
  const container = document.getElementById('terminal-container');
  if (container) container.innerHTML = '';
}

export function getActiveTerminalId() {
  return activeTerminal ? activeTerminal.terminalId : null;
}

/** Focus the active terminal so subsequent keypresses go to the SSH session */
export function focusTerminal() {
  if (!activeTerminal) return false;
  activeTerminal.term.scrollToBottom();
  activeTerminal.term.focus();
  return true;
}

/**
 * Refit terminal to its container and force a full canvas repaint.
 * Uses the same cols±1 resize cycle as forceCanvasRepaint() to guarantee
 * the canvas re-renders after tab switches and visibility changes.
 */
export function refitTerminal() {
  if (!activeTerminal || !activeTerminal.fitAddon) return;
  const { terminalId, term, fitAddon } = activeTerminal;
  forceCanvasRepaint(terminalId, term, fitAddon);
}

function getContainer() {
  return isFullscreen
    ? document.getElementById('terminal-fullscreen-container')
    : document.getElementById('terminal-container');
}

export function toggleFullscreen() {
  if (isFullscreen) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
}

export function enterFullscreen() {
  if (isFullscreen || !activeTerminal) return;
  isFullscreen = true;

  const overlay = document.getElementById('terminal-fullscreen-overlay');
  const fsContainer = document.getElementById('terminal-fullscreen-container');
  if (!overlay || !fsContainer) return;

  // Move the .xterm element into fullscreen container
  const xtermEl = activeTerminal.term.element;
  if (xtermEl) {
    fsContainer.appendChild(xtermEl);
  }

  overlay.classList.remove('hidden');

  // Observe fullscreen container for resize (e.g. window resize while fullscreen)
  if (activeTerminal.resizeObserver) {
    activeTerminal.resizeObserver.observe(fsContainer);
  }

  // Refit after DOM move
  requestAnimationFrame(() => {
    if (activeTerminal && activeTerminal.fitAddon) {
      activeTerminal.fitAddon.fit();
      sendResize(activeTerminal.terminalId, activeTerminal.term.cols, activeTerminal.term.rows);
      activeTerminal.term.focus();
    }
  });
}

export function exitFullscreen() {
  if (!isFullscreen) return;
  isFullscreen = false;

  const overlay = document.getElementById('terminal-fullscreen-overlay');
  const fsContainer = document.getElementById('terminal-fullscreen-container');
  const inlineContainer = document.getElementById('terminal-container');
  if (!overlay || !inlineContainer) return;

  overlay.classList.add('hidden');

  // Stop observing fullscreen container
  if (activeTerminal && activeTerminal.resizeObserver && fsContainer) {
    activeTerminal.resizeObserver.unobserve(fsContainer);
  }

  // Move the .xterm element back to inline container
  if (activeTerminal) {
    const xtermEl = activeTerminal.term.element;
    if (xtermEl) {
      inlineContainer.appendChild(xtermEl);
    }
    // Refit after DOM move
    requestAnimationFrame(() => {
      if (activeTerminal && activeTerminal.fitAddon) {
        activeTerminal.fitAddon.fit();
        sendResize(activeTerminal.terminalId, activeTerminal.term.cols, activeTerminal.term.rows);
        activeTerminal.term.focus();
      }
    });
  }
}

function updateStatus(text, className) {
  const status = document.getElementById('terminal-status');
  if (status) {
    status.textContent = text;
    status.className = `terminal-status ${className}`;
  }
}

// Refit terminal after browser tab/app switch
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeTerminal) {
    refitTerminal();
  }
});

// Alt+F11 toggles fullscreen (no Escape — it's a valid terminal key)
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11' && e.altKey && activeTerminal) {
    e.preventDefault();
    toggleFullscreen();
  }
});

// Wire up fullscreen buttons when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const fsBtn = document.getElementById('terminal-fullscreen-btn');
  if (fsBtn) fsBtn.addEventListener('click', () => toggleFullscreen());

  const exitBtn = document.getElementById('terminal-fullscreen-exit');
  if (exitBtn) exitBtn.addEventListener('click', () => exitFullscreen());

  // Refresh button: enter fullscreen then exit after a short delay to force repaint
  const refreshBtn = document.getElementById('terminal-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => {
    if (!activeTerminal) return;
    enterFullscreen();
    setTimeout(() => exitFullscreen(), 300);
  });

  // Theme selector
  const themeSelect = document.getElementById('terminal-theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', (e) => applyTheme(e.target.value));
  }

  // When the website theme changes, re-apply the terminal theme if set to 'auto'
  onSettingChange('theme', () => {
    if (!activeTerminal) return;
    const current = terminalThemes[activeTerminal.terminalId];
    if (current === 'auto') {
      applyTheme('auto');
    }
  });
});

// Refit terminal and adjust font size on viewport resize / orientation change
let viewportResizeTimer = null;
function handleViewportResize() {
  clearTimeout(viewportResizeTimer);
  viewportResizeTimer = setTimeout(() => {
    if (!activeTerminal) return;
    const newFontSize = getResponsiveFontSize();
    if (activeTerminal.term.options.fontSize !== newFontSize) {
      activeTerminal.term.options.fontSize = newFontSize;
    }
    activeTerminal.fitAddon.fit();
    sendResize(activeTerminal.terminalId, activeTerminal.term.cols, activeTerminal.term.rows);
  }, 150);
}

window.addEventListener('resize', handleViewportResize);
window.addEventListener('orientationchange', handleViewportResize);

/**
 * Open a tmux terminal for a team member.
 * Calls the backend API to create/attach a tmux pane, then opens the
 * detail panel terminal tab and subscribes to terminal output.
 */
export async function openTeamMemberTerminal(teamId, sessionId) {
  const resp = await fetch(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(sessionId)}/terminal`, {
    method: 'POST',
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Failed to open team terminal (${resp.status})`);
  }
  const data = await resp.json();
  const terminalId = data.terminalId;
  if (!terminalId) {
    throw new Error('No terminalId returned from server');
  }

  // Select the session in the detail panel
  const { selectSession } = await import('./detailPanel.js');
  selectSession(sessionId);

  // Switch to the terminal tab
  const termTab = document.querySelector('.detail-tabs .tab[data-tab="terminal"]');
  if (termTab) termTab.click();

  // Attach and subscribe to the terminal
  attachToSession(sessionId, terminalId);
}
