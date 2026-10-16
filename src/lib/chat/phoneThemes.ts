/**
 * phoneThemes.ts — the desktop's ten themes on the phone (AASC-58).
 *
 * Each desktop theme (`settingsStore.THEMES`) gets a phone palette: the colours
 * the phone kit's tokens (`--ph-*`, phoneTokens.css) take while it is chosen,
 * plus the phone terminal's xterm palette. Light or dark follows the theme
 * (`scheme`, the `color-scheme` its desktop stylesheet declares).
 *
 * The values start from the desktop palette (bg-primary, bg-card, text-*,
 * accent-*), with each foreground lifted toward white (dark themes) or black
 * (light ones) only as far as WCAG 4.5:1 needs on every surface it is drawn on,
 * including the translucent fills and tints (phoneThemes.test.ts measures them
 * all). Dracula, Nord and Monokai sit their surfaces halfway between the
 * desktop's background and card colour: on the desktop card no accent of
 * theirs reaches 4.5:1 without washing out.
 *
 * Import-light on purpose (types and the xterm palette table only): the phone
 * frame applies it to <body>, the phone terminal reads its palette.
 */
import type { ITheme } from '@xterm/xterm';
import type { ThemeName } from '@/stores/settingsStore';
import { THEMES as XTERM_THEMES } from '@/components/terminal/themes';

export type PhoneScheme = 'light' | 'dark';

export interface PhonePalette {
  name: ThemeName;
  scheme: PhoneScheme;
  bg: string;
  surface: string;
  surfaceRaised: string;
  sheetBg: string;
  sheetGroup: string;
  segmentSelected: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  onAccent: string;
  danger: string;
  onDanger: string;
  /** The tab bar's count badge, drawn with white text in every theme. */
  badge: string;
  statusApproval: string;
  statusQuestion: string;
  statusWorking: string;
  statusFinished: string;
}

/** The theme a phone shows before (or without) a stored choice: the desktop default. */
export const DEFAULT_PHONE_THEME: ThemeName = 'windows-xp';

/** <body>'s light / dark marker, which phoneTokens.css reads (scheme-wide fills, separators, shadows). */
export const PHONE_SCHEME_ATTR = 'data-ph-appearance';

export const PHONE_PALETTES: Readonly<Record<ThemeName, PhonePalette>> = {
  'command-center': {
    name: 'command-center', scheme: 'dark',
    bg: '#0a0a1a', surface: '#12122a', surfaceRaised: '#1a1a3a', sheetBg: '#12122a', sheetGroup: '#1a1a3a', segmentSelected: '#3a3a56',
    text: '#e0e0ff', textSecondary: '#a7a7c0', textTertiary: '#85859d',
    accent: '#00e5ff', onAccent: '#0a0a1a', danger: '#ff6a83', onDanger: '#0a0a1a', badge: '#de2c4a',
    statusApproval: '#ffcc00', statusQuestion: '#aa66ff', statusWorking: '#00e5ff', statusFinished: '#00ff88',
  },
  cyberpunk: {
    name: 'cyberpunk', scheme: 'dark',
    bg: '#0d0221', surface: '#1a0533', surfaceRaised: '#2a0845', sheetBg: '#1a0533', sheetGroup: '#2a0845', segmentSelected: '#482b5f',
    text: '#f0e0ff', textSecondary: '#bf8fef', textTertiary: '#9479bc',
    accent: '#ff30ff', onAccent: '#0d0221', danger: '#ff5c92', onDanger: '#0d0221', badge: '#e8004d',
    statusApproval: '#ffcc00', statusQuestion: '#ce3bff', statusWorking: '#00ffff', statusFinished: '#39ff14',
  },
  warm: {
    name: 'warm', scheme: 'light',
    bg: '#faf6f1', surface: '#fffcf7', surfaceRaised: '#fffcf7', sheetBg: '#faf6f1', sheetGroup: '#fffcf7', segmentSelected: '#fffcf7',
    text: '#292524', textSecondary: '#57534e', textTertiary: '#726e6b',
    accent: '#9a5404', onAccent: '#ffffff', danger: '#b91c1c', onDanger: '#ffffff', badge: '#b91c1c',
    statusApproval: '#956603', statusQuestion: '#7e22ce', statusWorking: '#92400e', statusFinished: '#4d7c0f',
  },
  dracula: {
    name: 'dracula', scheme: 'dark',
    bg: '#282a36', surface: '#363948', surfaceRaised: '#3e4153', sheetBg: '#363948', sheetGroup: '#3e4153', segmentSelected: '#595c6b',
    text: '#f8f8f2', textSecondary: '#d4d4d3', textTertiary: '#a6afcb',
    accent: '#d2b6fb', onAccent: '#282a36', danger: '#ffacac', onDanger: '#282a36', badge: '#cc4444',
    statusApproval: '#f1fa8c', statusQuestion: '#c49efa', statusWorking: '#8be9fd', statusFinished: '#50fa7b',
  },
  solarized: {
    name: 'solarized', scheme: 'dark',
    bg: '#002b36', surface: '#073642', surfaceRaised: '#0a4050', sheetBg: '#073642', sheetGroup: '#0a4050', segmentSelected: '#2c5b69',
    text: '#c9cdc4', textSecondary: '#bdc3c0', textTertiary: '#9ba9ad',
    accent: '#7bc5bf', onAccent: '#002b36', danger: '#f0a5a3', onDanger: '#002b36', badge: '#dc322f',
    statusApproval: '#c5a236', statusQuestion: '#9fa3d9', statusWorking: '#57b5ae', statusFinished: '#9fae36',
  },
  nord: {
    name: 'nord', scheme: 'dark',
    bg: '#2e3440', surface: '#353b49', surfaceRaised: '#383f4e', sheetBg: '#353b49', sheetGroup: '#383f4e', segmentSelected: '#545a67',
    text: '#eceff4', textSecondary: '#becede', textTertiary: '#a5acbb',
    accent: '#93c6d4', onAccent: '#2e3440', danger: '#e0b3b7', onDanger: '#2e3440', badge: '#b25a63',
    statusApproval: '#ebcb8b', statusQuestion: '#c2a2bc', statusWorking: '#88c0d0', statusFinished: '#a3be8c',
  },
  monokai: {
    name: 'monokai', scheme: 'dark',
    bg: '#272822', surface: '#33332a', surfaceRaised: '#39392f', sheetBg: '#33332a', sheetGroup: '#39392f', segmentSelected: '#55554c',
    text: '#f8f8f2', textSecondary: '#c6c4b5', textTertiary: '#a7a498',
    accent: '#66d9ef', onAccent: '#272822', danger: '#fc9bbe', onDanger: '#272822', badge: '#de2265',
    statusApproval: '#e6db74', statusQuestion: '#b68eff', statusWorking: '#66d9ef', statusFinished: '#a6e22e',
  },
  light: {
    name: 'light', scheme: 'light',
    bg: '#f0f2f5', surface: '#ffffff', surfaceRaised: '#ffffff', sheetBg: '#f0f2f5', sheetGroup: '#ffffff', segmentSelected: '#ffffff',
    text: '#1e293b', textSecondary: '#475569', textTertiary: '#636d7b',
    accent: '#096a95', onAccent: '#ffffff', danger: '#c22121', onDanger: '#ffffff', badge: '#dc2626',
    statusApproval: '#a55a05', statusQuestion: '#7c3aed', statusWorking: '#0273ad', statusFinished: '#117e39',
  },
  blonde: {
    name: 'blonde', scheme: 'light',
    bg: '#fdf8ef', surface: '#fffbf3', surfaceRaised: '#fffbf3', sheetBg: '#fdf8ef', sheetGroup: '#fffbf3', segmentSelected: '#fffbf3',
    text: '#292420', textSecondary: '#57524a', textTertiary: '#767065',
    accent: '#8b5f03', onAccent: '#ffffff', danger: '#991b1b', onDanger: '#ffffff', badge: '#991b1b',
    statusApproval: '#a16207', statusQuestion: '#6b21a8', statusWorking: '#854d0e', statusFinished: '#3f6212',
  },
  'windows-xp': {
    name: 'windows-xp', scheme: 'light',
    bg: '#ece9d8', surface: '#ffffff', surfaceRaised: '#ffffff', sheetBg: '#ece9d8', sheetGroup: '#ffffff', segmentSelected: '#ffffff',
    text: '#14161a', textSecondary: '#4a4a44', textTertiary: '#696759',
    accent: '#0959c9', onAccent: '#ffffff', danger: '#b4271b', onDanger: '#ffffff', badge: '#c62b1e',
    statusApproval: '#886008', statusQuestion: '#6d3fa0', statusWorking: '#0a5fd6', statusFinished: '#2b7625',
  },
};

/** The palette for a stored theme name; anything unknown gets the default's. */
export function phonePalette(name: string): PhonePalette {
  return Object.prototype.hasOwnProperty.call(PHONE_PALETTES, name)
    ? PHONE_PALETTES[name as ThemeName]
    : PHONE_PALETTES[DEFAULT_PHONE_THEME];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Desktop xterm palettes that belong to a theme (same colours, same background). */
const OWN_XTERM: Partial<Record<ThemeName, string>> = {
  'command-center': 'default',
  dracula: 'dracula',
  monokai: 'monokai',
  nord: 'nord',
  solarized: 'solarized-dark',
};

/**
 * The phone terminal's palette for a theme. The five themes with an xterm
 * palette of their own use it; the rest are built from the phone palette (as
 * the desktop's `auto` terminal does from the theme), so Windows XP keeps a
 * light terminal like the desktop's default, not the opt-in cmd.exe look. Every
 * colour is one the phone already draws as text, so all of it reads on the
 * terminal's background.
 */
export function phoneTerminalTheme(name: string): ITheme {
  const p = phonePalette(name);
  const own = OWN_XTERM[p.name];
  if (own && XTERM_THEMES[own]) return XTERM_THEMES[own];
  const dark = p.scheme === 'dark';
  return {
    background: p.bg,
    foreground: p.text,
    cursor: p.text,
    cursorAccent: p.bg,
    selectionBackground: rgba(p.accent, dark ? 0.35 : 0.25),
    selectionForeground: p.text,
    black: dark ? p.surfaceRaised : p.text,
    red: p.danger,
    green: p.statusFinished,
    yellow: p.statusApproval,
    blue: p.statusWorking,
    magenta: p.statusQuestion,
    cyan: p.accent,
    white: dark ? p.text : p.textSecondary,
    brightBlack: p.textTertiary,
    brightRed: p.danger,
    brightGreen: p.statusFinished,
    brightYellow: p.statusApproval,
    brightBlue: p.statusWorking,
    brightMagenta: p.statusQuestion,
    brightCyan: p.accent,
    brightWhite: dark ? '#ffffff' : p.text,
  };
}

/** The `--ph-*` custom properties a theme sets (the rest of the kit derives from these). */
export function phoneThemeVars(name: string): Record<string, string> {
  const p = phonePalette(name);
  return {
    '--ph-bg': p.bg,
    '--ph-surface': p.surface,
    '--ph-surface-raised': p.surfaceRaised,
    '--ph-bar-bg': rgba(p.bg, 0.94),
    '--ph-sheet-bg': p.sheetBg,
    '--ph-sheet-group': p.sheetGroup,
    '--ph-segment-selected': p.segmentSelected,
    '--ph-text': p.text,
    '--ph-text-secondary': p.textSecondary,
    '--ph-text-tertiary': p.textTertiary,
    '--ph-accent': p.accent,
    '--ph-on-accent': p.onAccent,
    '--ph-danger': p.danger,
    '--ph-on-danger': p.onDanger,
    '--ph-badge': p.badge,
    '--ph-status-approval': p.statusApproval,
    '--ph-status-question': p.statusQuestion,
    '--ph-status-working': p.statusWorking,
    '--ph-status-finished': p.statusFinished,
    '--ph-terminal-bg': phoneTerminalTheme(p.name).background ?? p.bg,
  };
}

const VAR_NAMES = Object.keys(phoneThemeVars(DEFAULT_PHONE_THEME));

/** Put a theme's tokens and its light / dark on `el` (the frame does this to <body>). */
export function applyPhoneTheme(el: HTMLElement, name: string): void {
  for (const [prop, value] of Object.entries(phoneThemeVars(name))) el.style.setProperty(prop, value);
  el.setAttribute(PHONE_SCHEME_ATTR, phonePalette(name).scheme);
}

/** Take every token `applyPhoneTheme` set off `el` again (the frame unmounting: the desktop never sees them). */
export function clearPhoneTheme(el: HTMLElement): void {
  for (const prop of VAR_NAMES) el.style.removeProperty(prop);
  el.removeAttribute(PHONE_SCHEME_ATTR);
}
