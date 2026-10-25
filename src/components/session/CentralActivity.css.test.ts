// What the ACTIVITY list's stylesheet must keep, found in a rendered check (P2 UI check): none of it shows in a unit
// test of the component, and no lint rule reads a column width or a spacing value, so the source is read here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/styles/modules/CentralActivity.module.css'), 'utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The longest tool that writes a row (server/mcp/tools/queueWrite*.ts), in characters. */
const LONGEST_TOOL = 'queue_resume_after_cancel';
/** The widest mono face a theme has is 0.6em per character. */
const MONO_EM_PER_CHAR = 0.6;

describe('CentralActivity.module.css', () => {
  it('gives the tool column room for the longest tool name', () => {
    const wide = /\.row\s*\{[^}]*grid-template-columns:\s*92px\s+minmax\(0,\s*([\d.]+)em\)/.exec(code);

    expect(wide).not.toBeNull();
    expect(Number(wide![1])).toBeGreaterThanOrEqual(LONGEST_TOOL.length * MONO_EM_PER_CHAR);
  });

  it('starts the stacked layout where the target would be squeezed under 160px', () => {
    // 24 padding + 92 time + 16em tool (176px at 11px) + 84 outcome + 3 gaps of 8 = 400, leaving 160px for the target at 560.
    expect(/@container centralactivity \(max-width:\s*560px\)/.test(code)).toBe(true);
  });

  it('stops the list at a width a row of four short fields can use', () => {
    expect(/\.root\s*\{[^}]*max-width:\s*\d+px/.test(code)).toBe(true);
  });

  it('keeps every gap and padding on the 4px grid (a row is 8px 12px, as the AGENTS rows are)', () => {
    const lengths = [...code.matchAll(/(?:gap|padding|margin)[a-z-]*\s*:\s*([^;}]+)[;}]/g)].flatMap(
      (m) => m[1].match(/-?\d+(?:\.\d+)?px/g) ?? [],
    );

    expect(lengths.length).toBeGreaterThanOrEqual(4);
    expect(lengths.filter((l) => Number.parseFloat(l) % 4 !== 0)).toEqual([]);
  });
});
