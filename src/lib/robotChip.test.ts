import { describe, it, expect } from 'vitest';
import {
  CHIP_PILL,
  CHIP_PILL_SELECTED,
  CHIP_TEXT,
  CHIP_TEXT_SELECTED,
  CHIP_TITLE_MAX,
  DIALOGUE_Y,
  PIN_BUBBLE_LIFT,
  PIN_TOP_ABOVE_TIP,
  attentionPinColor,
  charWidth,
  chipLayout,
  chipStatusColor,
  chipStatusWord,
  chipTitle,
  textWidth,
} from './robotChip';

/** WCAG relative luminance and contrast ratio of two #rrggbb colours. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const STATUSES = ['idle', 'prompting', 'working', 'waiting', 'approval', 'input', 'ended', 'connecting'];

describe('chipStatusWord', () => {
  it.each([
    ['idle', 'Idle'],
    ['prompting', 'Thinking'],
    ['working', 'Working'],
    ['waiting', 'Waiting'],
    ['approval', 'Needs approval'],
    ['input', 'Needs input'],
    ['connecting', 'Connecting'],
    ['ended', 'Offline'],
  ])('%s reads as %s', (status, word) => {
    expect(chipStatusWord(status)).toBe(word);
  });

  it('shows an unknown status as it is, capitalised, rather than hiding it', () => {
    expect(chipStatusWord('rebooting')).toBe('Rebooting');
  });

  it('copes with an empty status', () => {
    expect(chipStatusWord('')).toBe('');
  });
});

// The word is small text on a pill: WCAG wants 4.5:1 for it, and the original palette (picked to
// match the cyberdrome label, which sits on a dark panel) managed 2.1:1 for approval on the light pill.
describe('chipStatusColor', () => {
  it.each(STATUSES)('reads at 4.5:1 or better for %s on the light pill', (status) => {
    expect(contrast(chipStatusColor(status), CHIP_PILL)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUSES)('reads at 4.5:1 or better for %s on the navy selected pill', (status) => {
    expect(contrast(chipStatusColor(status, true), CHIP_PILL_SELECTED)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the title readable on both pills too', () => {
    expect(contrast(CHIP_TEXT, CHIP_PILL)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(CHIP_TEXT_SELECTED, CHIP_PILL_SELECTED)).toBeGreaterThanOrEqual(4.5);
  });

  it('gives every status its own hue on each pill, so two states are never confused at a glance', () => {
    for (const onDark of [false, true]) {
      const distinct = ['idle', 'prompting', 'working', 'approval', 'input', 'ended', 'connecting'];
      const colours = distinct.map((s) => chipStatusColor(s, onDark));
      expect(new Set(colours).size).toBe(distinct.length);
    }
  });

  it('colours "waiting" like "prompting": both are the quiet cyan between turns', () => {
    expect(chipStatusColor('waiting')).toBe(chipStatusColor('prompting'));
    expect(chipStatusColor('waiting', true)).toBe(chipStatusColor('prompting', true));
  });

  it('uses a lighter shade on the dark pill than on the light one', () => {
    for (const status of STATUSES) {
      expect(luminance(chipStatusColor(status, true))).toBeGreaterThan(luminance(chipStatusColor(status, false)));
    }
  });

  it('falls back to the neutral grey for a status it does not know', () => {
    expect(chipStatusColor('rebooting')).toBe(chipStatusColor('connecting'));
    expect(chipStatusColor('rebooting', true)).toBe(chipStatusColor('connecting', true));
  });

  it('always returns a hex colour', () => {
    for (const status of [...STATUSES, 'nope']) {
      expect(chipStatusColor(status)).toMatch(/^#[0-9a-f]{6}$/);
      expect(chipStatusColor(status, true)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('attentionPinColor', () => {
  it('pins a robot waiting on an approval (amber) or an answer (purple)', () => {
    expect(attentionPinColor('alert')).toBe('#f5a300');
    expect(attentionPinColor('input')).toBe('#8b5cf6');
  });

  it.each(['idle', 'thinking', 'working', 'waiting', 'offline', 'connecting', ''])(
    'leaves a %s robot unpinned',
    (state) => {
      expect(attentionPinColor(state)).toBeNull();
    },
  );

  it('uses a different pin for each reason, so the pin alone says what is wanted', () => {
    expect(attentionPinColor('alert')).not.toBe(attentionPinColor('input'));
  });
});

describe('charWidth / textWidth', () => {
  it('counts Latin letters, digits and punctuation as one column', () => {
    expect(textWidth('Queue float window')).toBe('Queue float window'.length);
    expect(textWidth('a-b_c.d 1')).toBe(9);
  });

  it('counts CJK ideographs, kana and Hangul as two columns', () => {
    expect(charWidth('测'.codePointAt(0)!)).toBe(2);
    expect(charWidth('あ'.codePointAt(0)!)).toBe(2);
    expect(charWidth('한'.codePointAt(0)!)).toBe(2);
    expect(textWidth('测试')).toBe(4);
  });

  it('counts fullwidth forms and emoji as two columns', () => {
    expect(charWidth('Ａ'.codePointAt(0)!)).toBe(2);
    expect(charWidth('（'.codePointAt(0)!)).toBe(2);
    expect(charWidth('😀'.codePointAt(0)!)).toBe(2);
  });

  it('sums a mixed title by character, not by UTF-16 unit', () => {
    expect(textWidth('AASC 测试😀')).toBe(5 + 4 + 2);
  });
});

describe('chipTitle', () => {
  it('leaves a short title alone', () => {
    expect(chipTitle('AASC Q & A')).toBe('AASC Q & A');
  });

  it('keeps a title that exactly fills the chip', () => {
    const exact = 'x'.repeat(CHIP_TITLE_MAX);
    expect(chipTitle(exact)).toBe(exact);
  });

  it('cuts a longer one to the chip width with a single ellipsis character', () => {
    const cut = chipTitle('y'.repeat(CHIP_TITLE_MAX + 15));
    expect(cut).toHaveLength(CHIP_TITLE_MAX);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    const title = `${'a'.repeat(CHIP_TITLE_MAX - 2)} bbbbbb`;
    expect(chipTitle(title).endsWith(' …')).toBe(false);
  });

  it('does not split a character made of two UTF-16 units', () => {
    const cut = chipTitle('😀'.repeat(CHIP_TITLE_MAX + 5));
    expect([...cut].slice(0, -1).every((c) => c === '😀')).toBe(true);
    expect(cut.endsWith('…')).toBe(true);
  });

  // A CJK character is as wide as two Latin ones: twenty of them would run into the status word.
  it('cuts a CJK title by width, so it leaves room for the status word', () => {
    const cut = chipTitle('测试'.repeat(CHIP_TITLE_MAX));
    expect(textWidth(cut)).toBeLessThanOrEqual(CHIP_TITLE_MAX);
    expect([...cut].length).toBeLessThan(CHIP_TITLE_MAX); // fewer characters than a Latin title gets
    expect(cut.endsWith('…')).toBe(true);
  });

  it('keeps as much of a long title as fits, and no more', () => {
    for (const title of ['测试'.repeat(30), '😀'.repeat(30), 'ab测cd试'.repeat(10), 'y'.repeat(50)]) {
      const cut = chipTitle(title);
      expect(textWidth(cut)).toBeLessThanOrEqual(CHIP_TITLE_MAX);
      // one more character of the title would not have fitted beside the ellipsis
      const kept = [...cut].slice(0, -1).join('');
      const next = [...title.slice(kept.length)][0];
      expect(textWidth(kept) + textWidth(next) + 1).toBeGreaterThan(CHIP_TITLE_MAX);
    }
  });

  it('never exceeds the chip, whatever mix of scripts it is given', () => {
    for (const title of ['混合 mixed 标题 with 😀 emoji and more words after', 'ＡＢＣ'.repeat(12), '한국어 제목이 아주 길어요 정말로 길어요']) {
      expect(textWidth(chipTitle(title))).toBeLessThanOrEqual(CHIP_TITLE_MAX);
    }
  });
});

describe('chipLayout', () => {
  it('scales the chip with the Font Size setting', () => {
    expect(chipLayout(26).width).toBeCloseTo(chipLayout(13).width * 2, 9);
    expect(chipLayout(26).height).toBeCloseTo(chipLayout(13).height * 2, 9);
  });

  it('raises the chip a little less than the scale, as the cyberdrome label does', () => {
    expect(chipLayout(13).billboardY).toBeCloseTo(2.1, 9);
    expect(chipLayout(26).billboardY).toBeLessThan(2.1 * 2);
    expect(chipLayout(26).billboardY).toBeGreaterThan(chipLayout(13).billboardY);
  });

  // The pin's point must clear the chip, at every Font Size the setting allows (10 to 20).
  it.each([10, 13, 16, 20])('puts the pin\'s point above the chip at font size %i', (fontSize) => {
    const { billboardY, height, pinBaseY } = chipLayout(fontSize);
    expect(pinBaseY).toBeGreaterThan(billboardY + height / 2);
  });

  // The approval/input speech bubble floats above everything and is drawn on top of it (no depth
  // test). The pin may not reach it: the bubble is lifted by PIN_BUBBLE_LIFT while a pin is up.
  it.each([10, 13, 16, 20])('keeps the pin\'s head clear of the lifted speech bubble at font size %i', (fontSize) => {
    const { pinBaseY } = chipLayout(fontSize);
    const bubbleBottom = DIALOGUE_Y + PIN_BUBBLE_LIFT - 0.13; // panel 0.22 high + its 0.02 border
    expect(pinBaseY + PIN_TOP_ABOVE_TIP).toBeLessThan(bubbleBottom);
  });

  it('would collide without the lift at the largest font size — the lift is what prevents it', () => {
    const { pinBaseY } = chipLayout(20);
    expect(pinBaseY + PIN_TOP_ABOVE_TIP).toBeGreaterThan(DIALOGUE_Y - 0.13);
  });
});
