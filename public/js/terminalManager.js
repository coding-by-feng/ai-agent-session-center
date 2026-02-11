// terminalManager.js — Frontend terminal module using xterm.js
// Manages terminal lifecycle, I/O relay through WebSocket, and tab attachment.
// Uses canvas renderer, Unicode11, WebLinks, and FitAddon (same stack as AWS/Azure Cloud Shell).

let ws = null;
let activeTerminal = null;  // { terminalId, term, fitAddon, resizeObserver }
let terminalSessions = {};  // terminalId -> sessionId mapping
let terminalThemes = {};    // terminalId -> theme name
let pendingOutput = {};     // terminalId -> [base64Data] — buffer output before terminal is ready
let isFullscreen = false;

const THEMES = {
  default: {
    background: '#0a0a1a', foreground: '#e0e0e0', cursor: '#0a0a1a', cursorAccent: '#0a0a1a',
    selectionBackground: 'rgba(0,229,255,0.3)', selectionForeground: '#ffffff',
    black: '#0a0a1a', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#6272a4', magenta: '#ff79c6', cyan: '#00e5ff', white: '#e0e0e0',
    brightBlack: '#555555', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  dark: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#1e1e1e', cursorAccent: '#1e1e1e',
    selectionBackground: 'rgba(255,255,255,0.15)', selectionForeground: '#ffffff',
    black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
    blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
    brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
    brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
    brightCyan: '#29b8db', brightWhite: '#ffffff',
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#272822', cursorAccent: '#272822',
    selectionBackground: 'rgba(73,72,62,0.6)', selectionForeground: '#ffffff',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
    blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
    brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#282a36', cursorAccent: '#282a36',
    selectionBackground: 'rgba(68,71,90,0.6)', selectionForeground: '#ffffff',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#839496', cursor: '#002b36', cursorAccent: '#002b36',
    selectionBackground: 'rgba(7,54,66,0.6)', selectionForeground: '#93a1a1',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#2e3440', cursorAccent: '#2e3440',
    selectionBackground: 'rgba(67,76,94,0.6)', selectionForeground: '#eceff4',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  'github-dark': {
    background: '#0d1117', foreground: '#c9d1d9', cursor: '#0d1117', cursorAccent: '#0d1117',
    selectionBackground: 'rgba(56,139,253,0.25)', selectionForeground: '#ffffff',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
};

export function setWs(websocket) {
  ws = websocket;
  // Re-subscribe active terminal after WS reconnect so output keeps flowing
  if (activeTerminal && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'terminal_subscribe', terminalId: activeTerminal.terminalId }));
  }
}

export function setTerminalTheme(terminalId, themeName) {
  terminalThemes[terminalId] = themeName;
}

function getTheme(terminalId) {
  const name = terminalThemes[terminalId] || 'default';
  return THEMES[name] || THEMES.default;
}

function sendResize(terminalId, cols, rows) {
  if (ws && ws.readyState === 1 && cols > 0 && rows > 0) {
    ws.send(JSON.stringify({ type: 'terminal_resize', terminalId, cols, rows }));
  }
}

export function initTerminal(terminalId) {
  detachTerminal();

  const container = document.getElementById('terminal-container');
  if (!container) return;
  container.innerHTML = '';

  // Subscribe early so output is buffered while we wait for container dimensions
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
    }
  }

  function doSetup() {
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: 14,
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
      console.warn('[terminal] Unicode11 addon not available:', e.message);
    }

    // Load WebLinks for clickable URLs
    try {
      const webLinks = new WebLinksAddon.WebLinksAddon();
      term.loadAddon(webLinks);
    } catch (e) {
      console.warn('[terminal] WebLinks addon not available:', e.message);
    }

    term.open(container);

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
  }

  // Start polling — up to ~2s (40 × 50ms)
  setupWhenReady(40);
}

export function onTerminalOutput(terminalId, base64Data) {
  if (activeTerminal && activeTerminal.terminalId === terminalId) {
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    activeTerminal.term.write(bytes);
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
    // Re-fit and sync size now that server shell is ready
    requestAnimationFrame(() => {
      if (activeTerminal && activeTerminal.fitAddon) {
        activeTerminal.fitAddon.fit();
        sendResize(terminalId, activeTerminal.term.cols, activeTerminal.term.rows);
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

export function refitTerminal() {
  if (activeTerminal && activeTerminal.fitAddon) {
    activeTerminal.fitAddon.fit();
    sendResize(activeTerminal.terminalId, activeTerminal.term.cols, activeTerminal.term.rows);
  }
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

// Refit terminal after tab/app switch
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && activeTerminal) {
    requestAnimationFrame(() => {
      if (!activeTerminal) return;
      activeTerminal.fitAddon.fit();
    });
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
});
