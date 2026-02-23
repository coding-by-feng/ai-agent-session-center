/**
 * Terminal themes ported from public/js/terminalManager.js.
 */
import type { ITheme } from '@xterm/xterm';

export const THEMES: Record<string, ITheme> = {
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

export function buildAutoTheme(): ITheme {
  const s = getComputedStyle(document.body);
  const v = (name: string) => s.getPropertyValue(name).trim();

  const bg = v('--bg-primary') || THEMES.default.background!;
  const fg = v('--text-primary') || THEMES.default.foreground!;

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

export function getThemeNames(): string[] {
  return Object.keys(THEMES);
}

export function resolveTheme(themeName: string): ITheme {
  if (themeName === 'auto') return buildAutoTheme();
  return THEMES[themeName] || THEMES.default;
}
