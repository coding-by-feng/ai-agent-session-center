/**
 * Text, colour and layout rules for the diorama style's name chip (`RobotChip`) and the attention
 * pin that floats over it.
 *
 * Import-free and Three-free, so every rule is testable on its own.
 */

// ---------------------------------------------------------------------------
// Pill colours
// ---------------------------------------------------------------------------

/** The light pill, the navy "selected" pill, and the title colour on each. */
export const CHIP_PILL = '#f6f8ff';
export const CHIP_PILL_SELECTED = '#1e2a52';
export const CHIP_TEXT = '#1b2a4e';
export const CHIP_TEXT_SELECTED = '#ffffff';

// ---------------------------------------------------------------------------
// Status word
// ---------------------------------------------------------------------------

const STATUS_WORDS: Record<string, string> = {
  idle: 'Idle',
  prompting: 'Thinking',
  working: 'Working',
  waiting: 'Waiting',
  approval: 'Needs approval',
  input: 'Needs input',
  connecting: 'Connecting',
  ended: 'Offline',
};

/** The chip's status word for a session status — short, since it shares the chip with the title. */
export function chipStatusWord(status: string): string {
  if (!status) return '';
  return STATUS_WORDS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

// The word is small text, so it has to reach 4.5:1 (WCAG) on the pill it sits on. Two palettes, one
// per pill: deep hues on the light pill, light ones on the navy one. Both are pinned by tests that
// measure the contrast, because a colour that "looks right" on a monitor is how an amber word ends up
// at 2.1:1.
const ON_LIGHT: Record<string, string> = {
  idle: '#0f7a3d',
  prompting: '#08718c',
  working: '#a84a08',
  waiting: '#08718c',
  approval: '#8a6200',
  input: '#6d3fd1',
  ended: '#c4262b',
  connecting: '#5f6b82',
};
const ON_DARK: Record<string, string> = {
  idle: '#3ad583',
  prompting: '#3cc6e8',
  working: '#ff8f3a',
  waiting: '#3cc6e8',
  approval: '#ffc233',
  input: '#b79cff',
  ended: '#ff7a7e',
  connecting: '#a9b3c6',
};

/** The status dot and word colour for a status, for the light pill or (`onDark`) the navy one. */
export function chipStatusColor(status: string, onDark = false): string {
  const palette = onDark ? ON_DARK : ON_LIGHT;
  return palette[status] ?? palette.connecting;
}

/**
 * The colour of the pin a robot in this state wears, or null when it needs nothing from the user.
 * Takes the ROBOT state (`alert` is a pending approval, `input` a question), not the session status.
 */
export function attentionPinColor(robotState: string): string | null {
  if (robotState === 'alert') return '#f5a300';
  if (robotState === 'input') return '#8b5cf6';
  return null;
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/** Most columns of title the chip shows before cutting it with an ellipsis (a CJK character is two). */
export const CHIP_TITLE_MAX = 20;

/**
 * Columns one character takes in the chip: East Asian wide / fullwidth characters and emoji are as
 * wide as two Latin ones, everything else is one. Twenty CJK characters would run straight through
 * the status word beside them, so the title is cut by columns, not by characters.
 */
export function charWidth(codePoint: number): 1 | 2 {
  if (codePoint < 0x1100) return 1;
  const wide =
    codePoint <= 0x115f || // Hangul Jamo
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) || // CJK radicals … Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK compatibility forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji and pictographs
    (codePoint >= 0x20000 && codePoint <= 0x3fffd); // CJK extensions
  return wide ? 2 : 1;
}

/** Columns a string takes, counted by character (code point), not by UTF-16 unit. */
export function textWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character.codePointAt(0)!);
  return width;
}

/**
 * The title cut to `max` columns, the last being the ellipsis: as much of the title as fits beside
 * it, never a character split in the middle, never a space left dangling before the ellipsis.
 */
export function chipTitle(title: string, max: number = CHIP_TITLE_MAX): string {
  if (textWidth(title) <= max) return title;
  let kept = '';
  let width = 0;
  for (const character of title) {
    const w = charWidth(character.codePointAt(0)!);
    if (width + w > max - 1) break; // one column is kept back for the ellipsis
    kept += character;
    width += w;
  }
  return `${kept.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const BASE_FONT = 13;
const BASE_WIDTH = 2.1;
const BASE_HEIGHT = 0.19;
const BASE_BILLBOARD_Y = 2.1;
/** Clear space between the top of the chip and the point of the pin. */
const PIN_GAP = 0.04;

/** How far the pin's head reaches above its point: head centre 0.2 up, radius 0.1, plus the 0.04 bob. */
export const PIN_TOP_ABOVE_TIP = 0.34;

/** Height of the approval/input speech bubble above the robot's origin (`RobotDialogue`). */
export const DIALOGUE_Y = 2.8;
/** How far that bubble is lifted while a pin is up, so the pin never reaches it. */
export const PIN_BUBBLE_LIFT = 0.3;

export interface ChipLayout {
  /** Font Size setting relative to its default. */
  scale: number;
  width: number;
  height: number;
  /** Height of the chip's centre above the robot's origin. */
  billboardY: number;
  /** Height of the pin's point: just above the top of the chip. */
  pinBaseY: number;
}

/** Where the chip and the pin sit for a Font Size setting — one source for both, so they cannot drift. */
export function chipLayout(fontSize: number): ChipLayout {
  const scale = fontSize / BASE_FONT;
  const height = BASE_HEIGHT * scale;
  const billboardY = BASE_BILLBOARD_Y + (scale - 1) * 0.3;
  return {
    scale,
    width: BASE_WIDTH * scale,
    height,
    billboardY,
    pinBaseY: billboardY + height / 2 + PIN_GAP,
  };
}
