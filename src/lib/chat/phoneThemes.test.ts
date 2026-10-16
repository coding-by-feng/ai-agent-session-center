// phoneThemes.test.ts — the desktop's ten themes on the phone (AASC-58): every
// theme has a phone palette, light or dark follows the desktop theme, every
// text pair clears WCAG contrast, the tokens reach an element, and the phone
// terminal gets a palette that matches the theme.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { THEMES, type ThemeName } from '@/stores/settingsStore';
import { THEMES as XTERM_THEMES } from '@/components/terminal/themes';
import {
  PHONE_PALETTES,
  PHONE_SCHEME_ATTR,
  applyPhoneTheme,
  clearPhoneTheme,
  phonePalette,
  phoneTerminalTheme,
  phoneThemeVars,
  type PhonePalette,
} from './phoneThemes';

// ---- WCAG 2.x contrast, written out here apart from the code under test ----
function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not #rrggbb: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `top` at `alpha` over the opaque `base`, as the browser composites it. */
function over(top: string | [number, number, number], alpha: number, base: string): string {
  const t = typeof top === 'string' ? rgb(top) : top;
  const b = rgb(base);
  return `#${t.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

// The translucent layers phoneTokens.css draws over the surfaces (checked against the file below).
const FILL_RGB: [number, number, number] = [118, 118, 128];
const ALPHAS = {
  light: { fill: 0.12, fillStrong: 0.22, accentTint: 0.12, dangerTint: 0.12, warningTint: 0.14 },
  dark: { fill: 0.24, fillStrong: 0.36, accentTint: 0.18, dangerTint: 0.18, warningTint: 0.18 },
} as const;

const BODY = 4.5;
const LARGE = 3;

interface Pair { name: string; fg: string; bg: string; min: number }

/** Every text / background pair the phone draws, with the minimum it must clear. */
function pairsFor(p: PhonePalette): Pair[] {
  const a = ALPHAS[p.scheme];
  const surfaces: Array<[string, string]> = [
    ['bg', p.bg], ['surface', p.surface], ['raised', p.surfaceRaised], ['sheet', p.sheetBg], ['sheet group', p.sheetGroup],
  ];
  const layered: Array<[string, string]> = [
    ['fill/bg', over(FILL_RGB, a.fill, p.bg)],
    ['fill/surface', over(FILL_RGB, a.fill, p.surface)],
    ['fill-strong/surface', over(FILL_RGB, a.fillStrong, p.surface)],
    ['fill-strong/sheet group', over(FILL_RGB, a.fillStrong, p.sheetGroup)],
    ['accent tint/bg', over(p.accent, a.accentTint, p.bg)], // Chat: your own message bubble
    ['accent tint/surface', over(p.accent, a.accentTint, p.surface)],
    ['danger tint/surface', over(p.danger, a.dangerTint, p.surface)],
    ['warning tint/bg', over(p.statusApproval, a.warningTint, p.bg)], // driving banner
  ];
  const pairs: Pair[] = [];
  for (const [label, bg] of [...surfaces, ...layered]) {
    pairs.push({ name: `text on ${label}`, fg: p.text, bg, min: BODY });
    pairs.push({ name: `secondary text on ${label}`, fg: p.textSecondary, bg, min: BODY });
  }
  for (const [label, bg] of surfaces) {
    pairs.push({ name: `tertiary text on ${label}`, fg: p.textTertiary, bg, min: BODY });
    pairs.push({ name: `accent on ${label}`, fg: p.accent, bg, min: BODY });
    pairs.push({ name: `danger on ${label}`, fg: p.danger, bg, min: BODY });
    pairs.push({ name: `approval on ${label}`, fg: p.statusApproval, bg, min: BODY });
    pairs.push({ name: `question on ${label}`, fg: p.statusQuestion, bg, min: BODY });
    pairs.push({ name: `working on ${label}`, fg: p.statusWorking, bg, min: BODY });
    pairs.push({ name: `finished on ${label}`, fg: p.statusFinished, bg, min: BODY });
  }
  // Secondary buttons: accent (A− / A+, Retry) or danger ("Deny") text on the fill.
  for (const [label, base] of [['bg', p.bg], ['surface', p.surface], ['sheet group', p.sheetGroup]] as const) {
    pairs.push({ name: `accent on fill/${label} (secondary button)`, fg: p.accent, bg: over(FILL_RGB, a.fill, base), min: BODY });
    pairs.push({ name: `danger on fill/${label} (secondary button)`, fg: p.danger, bg: over(FILL_RGB, a.fill, base), min: BODY });
  }
  // Large / bold labels and status rings on the tints.
  pairs.push({ name: 'accent on accent tint', fg: p.accent, bg: over(p.accent, a.accentTint, p.surface), min: LARGE });
  pairs.push({ name: 'danger on danger tint', fg: p.danger, bg: over(p.danger, a.dangerTint, p.surface), min: LARGE });
  pairs.push({ name: 'approval on warning tint', fg: p.statusApproval, bg: over(p.statusApproval, a.warningTint, p.bg), min: LARGE });
  pairs.push({ name: 'text on selected segment', fg: p.text, bg: p.segmentSelected, min: BODY });
  pairs.push({ name: 'on-accent on accent (buttons)', fg: p.onAccent, bg: p.accent, min: BODY });
  pairs.push({ name: 'on-danger on danger', fg: p.onDanger, bg: p.danger, min: BODY });
  pairs.push({ name: 'white on badge', fg: '#ffffff', bg: p.badge, min: BODY });
  const term = phoneTerminalTheme(p.name);
  pairs.push({ name: 'terminal text', fg: term.foreground!, bg: term.background!, min: BODY });
  return pairs;
}

const NAMES = THEMES.map((t) => t.name);

describe('phone palettes', () => {
  it('has one for each of the desktop’s ten themes, in the desktop’s order', () => {
    expect(NAMES).toEqual(['command-center', 'cyberpunk', 'warm', 'dracula', 'solarized', 'nord', 'monokai', 'light', 'blonde', 'windows-xp']);
    expect(Object.keys(PHONE_PALETTES).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) expect(phonePalette(name).name).toBe(name);
  });

  it('is light or dark exactly as the desktop theme declares (color-scheme in its stylesheet)', () => {
    const light: ThemeName[] = [];
    for (const name of NAMES) {
      const file = resolve(process.cwd(), `src/styles/themes/${name}.css`);
      // command-center is base.css's :root, dark
      const isLight = existsSync(file) && /color-scheme:\s*light/.test(readFileSync(file, 'utf8'));
      expect(PHONE_PALETTES[name].scheme, name).toBe(isLight ? 'light' : 'dark');
      if (isLight) light.push(name);
    }
    expect(light).toEqual(['warm', 'light', 'blonde', 'windows-xp']);
  });

  it('falls back to the default theme for an unknown name', () => {
    expect(phonePalette('sepia').name).toBe('windows-xp');
  });

  it('mirrors the translucent layers phoneTokens.css draws', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/modules/mobile/phoneTokens.css'), 'utf8');
    const light = css.slice(css.indexOf('.phoneApp {'), css.indexOf("[data-ph-appearance='dark'] {"));
    const dark = css.slice(css.indexOf("[data-ph-appearance='dark'] {"));
    for (const [block, a] of [[light, ALPHAS.light], [dark, ALPHAS.dark]] as const) {
      expect(block).toContain(`--ph-fill: rgba(118, 118, 128, ${a.fill})`);
      expect(block).toContain(`--ph-fill-strong: rgba(118, 118, 128, ${a.fillStrong})`);
      expect(block).toContain(`--ph-accent-tint: color-mix(in srgb, var(--ph-accent) ${Math.round(a.accentTint * 100)}%, transparent)`);
      expect(block).toContain(`--ph-danger-tint: color-mix(in srgb, var(--ph-danger) ${Math.round(a.dangerTint * 100)}%, transparent)`);
      expect(block).toContain(`--ph-warning-tint: color-mix(in srgb, var(--ph-status-approval) ${Math.round(a.warningTint * 100)}%, transparent)`);
    }
  });

  describe.each(NAMES)('%s', (name) => {
    const palette = PHONE_PALETTES[name];
    it.each(pairsFor(palette).map((p) => [p.name, p] as const))('%s clears its contrast minimum', (_label, pair) => {
      const ratio = contrast(pair.fg, pair.bg);
      expect(ratio, `${name}: ${pair.name} ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(pair.min);
    });
  });
});

describe('applying a theme', () => {
  afterEach(() => clearPhoneTheme(document.body));

  it('maps every palette colour onto a --ph-* token', () => {
    const vars = phoneThemeVars('dracula');
    const p = PHONE_PALETTES.dracula;
    expect(vars).toMatchObject({
      '--ph-bg': p.bg,
      '--ph-surface': p.surface,
      '--ph-surface-raised': p.surfaceRaised,
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
      '--ph-terminal-bg': phoneTerminalTheme('dracula').background,
    });
    expect(vars['--ph-bar-bg']).toMatch(/^rgba\(40, 42, 54, 0\.94\)$/);
  });

  it('puts the tokens and light / dark on the element, and takes them all off again', () => {
    const el = document.body;
    applyPhoneTheme(el, 'nord');
    expect(el.getAttribute(PHONE_SCHEME_ATTR)).toBe('dark');
    expect(el.style.getPropertyValue('--ph-bg')).toBe(PHONE_PALETTES.nord.bg);
    applyPhoneTheme(el, 'blonde');
    expect(el.getAttribute(PHONE_SCHEME_ATTR)).toBe('light');
    expect(el.style.getPropertyValue('--ph-accent')).toBe(PHONE_PALETTES.blonde.accent);
    clearPhoneTheme(el);
    expect(el.hasAttribute(PHONE_SCHEME_ATTR)).toBe(false);
    expect(el.style.getPropertyValue('--ph-bg')).toBe('');
    expect(el.style.getPropertyValue('--ph-terminal-bg')).toBe('');
  });
});

describe('the phone terminal’s palette', () => {
  it('uses the desktop’s own xterm palette where one belongs to the theme', () => {
    expect(phoneTerminalTheme('command-center')).toEqual(XTERM_THEMES.default);
    expect(phoneTerminalTheme('dracula')).toEqual(XTERM_THEMES.dracula);
    expect(phoneTerminalTheme('monokai')).toEqual(XTERM_THEMES.monokai);
    expect(phoneTerminalTheme('nord')).toEqual(XTERM_THEMES.nord);
    expect(phoneTerminalTheme('solarized')).toEqual(XTERM_THEMES['solarized-dark']);
  });

  it.each(['cyberpunk', 'warm', 'light', 'blonde', 'windows-xp'] as const)('builds %s’s from its phone palette, every colour readable', (name) => {
    const p = PHONE_PALETTES[name];
    const t = phoneTerminalTheme(name);
    expect(t.background).toBe(p.bg);
    expect(t.foreground).toBe(p.text);
    const ink = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.brightRed, t.brightGreen, t.brightYellow, t.brightBlue, t.brightMagenta, t.brightCyan, t.brightBlack];
    // The "white" family on a dark terminal and the "black" one on a light terminal are text there too.
    ink.push(...(p.scheme === 'dark' ? [t.white, t.brightWhite] : [t.black]));
    for (const c of ink) expect(contrast(c!, t.background!), `${name} ${c}`).toBeGreaterThanOrEqual(BODY);
  });

  it('is light on a light theme and dark on a dark one (the terminal never fights the app)', () => {
    for (const name of NAMES) {
      const t = phoneTerminalTheme(name);
      const dark = luminance(t.background!) < 0.2;
      expect(dark, name).toBe(PHONE_PALETTES[name].scheme === 'dark');
    }
  });
});
