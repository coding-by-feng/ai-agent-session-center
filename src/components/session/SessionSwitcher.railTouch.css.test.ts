// The left rail's header on a touch screen (iPad, Nov 2 2026), found in a rendered check: every icon button is a
// 44px target under `pointer: coarse`, and at 230px the title row ran past the rail's edge. No unit test lays
// out CSS and no lint rule reads a width, so the stylesheets are read here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string) => readFileSync(resolve(process.cwd(), f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const panel = read('src/styles/modules/DetailPanel.module.css');
const kit = read('src/styles/modules/Button.module.css');
const switcher = readFileSync(resolve(process.cwd(), 'src/components/session/SessionSwitcher.tsx'), 'utf8');

/** The `@media (pointer: coarse)` blocks of a stylesheet, joined. */
function coarse(css: string): string {
  const out: string[] = [];
  const re = /@media \(pointer: coarse\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    out.push(css.slice(m.index + m[0].length, i - 1));
  }
  return out.join('\n');
}

const TOUCH_TARGET = 44;
const KILL_SEPARATION = 8;
const RAIL_BORDER = 1;
const RAIL_PADDING = 8;
/** Pin, rename, label, remark, kill: the row a browser on an iPad draws. */
const TITLE_ROW_BUTTONS = 5;

describe('the session rail on a touch screen', () => {
  it('is wide enough for the title row of 44px targets', () => {
    const width = /\.switcherBarVertical\s*\{[^}]*width:\s*(\d+)px/.exec(coarse(panel));
    expect(width).not.toBeNull();
    const content = Number(width![1]) - RAIL_BORDER - 2 * RAIL_PADDING;
    expect(content).toBeGreaterThanOrEqual(TITLE_ROW_BUTTONS * TOUCH_TARGET + KILL_SEPARATION);
  });

  it('wraps the title row rather than clipping it, with no gaps between the targets', () => {
    const rule = /\.switcherBarVertical \.switcherTitleActions\s*\{([^}]*)\}/.exec(coarse(panel))?.[1] ?? '';
    expect(rule).toMatch(/gap:\s*0/);
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
  });

  it('ends the View row after « so starting a session gets its own row', () => {
    const touch = coarse(panel);
    expect(touch).toMatch(/\.switcherMeta::after\s*\{[^}]*order:\s*8[^}]*flex:\s*0 0 100%/);
    expect(touch).toMatch(/\.switcherMinimizeBtn,\s*\.switcherBarVertical \.switcherCollapseBtn\s*\{[^}]*order:\s*7/);
    expect(touch).toMatch(/\.switcherLaunch,\s*\.switcherBarVertical \.switcherPinnedToggle\s*\{[^}]*order:\s*9/);
  });

  it('keeps the folded strip wider than its 44px expand button, over the 38px rule', () => {
    const folded = /\.switcherBar\.switcherBarVertical\.switcherBarCollapsed\s*\{[^}]*width:\s*(\d+)px/.exec(coarse(panel));
    expect(Number(folded?.[1])).toBeGreaterThan(TOUCH_TARGET);
  });

  it('grows the glyphs to fit the target when the rail asks for roomy icons', () => {
    expect(switcher).toContain("data-touch-icons={isVertical ? 'roomy' : undefined}");
    const touch = coarse(kit);
    expect(touch).toMatch(/\[data-touch-icons='roomy'\] \.iconSm svg\s*\{[^}]*width:\s*16px/);
    expect(touch).toMatch(/\[data-touch-icons='roomy'\] \.iconSm::before\s*\{[^}]*inset:\s*4px/);
  });

  it('leaves the mouse layout at 230px', () => {
    expect(panel).toMatch(/\.switcherBarVertical\s*\{[^}]*width:\s*230px/);
  });
});
