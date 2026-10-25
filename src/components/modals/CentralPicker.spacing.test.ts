// The Central picker's field sits on the project's 4/8 px spacing grid. A `gap: 3px` slipped in beside the 4px and 8px
// values around it (review of the P2 client, D-M7). No lint rule sees a spacing value, so the source is read here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/styles/modules/CentralPicker.module.css'), 'utf8');

/** Every px length of a gap, padding or margin declaration (shorthands and sides included). */
function spacingLengths(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/(?:gap|padding|margin)[a-z-]*\s*:\s*([^;}]+)[;}]/g)].flatMap(
    (m) => m[1].match(/-?\d+(?:\.\d+)?px/g) ?? [],
  );
}

describe('CentralPicker.module.css spacing', () => {
  it('reads the gaps, paddings and margins it should check (a guard that the check is not empty)', () => {
    expect(spacingLengths(css).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps every gap, padding and margin on the 4px grid', () => {
    const offGrid = spacingLengths(css).filter((length) => Number.parseFloat(length) % 4 !== 0);

    expect(offGrid).toEqual([]);
  });
});

// The modal panel styles every paragraph in it (`.panel p` in Modal.module.css: 12px, --text-secondary, a 16px bottom
// margin), and one class loses to that. The hints stood 16px apart and the warning lost its amber text until every
// `.hint` / `.warning` rule was written with the picker's own class in front (rendered check, P2 UI check).
describe('CentralPicker.module.css specificity', () => {
  it("writes every hint and warning rule under .picker, so the modal panel's paragraph rule cannot beat it", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...code.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',').map((part) => part.trim()));
    const mentionsHintOrWarning = selectors.filter((sel) => /\.(hint|warning)\b/.test(sel));
    const bare = mentionsHintOrWarning.filter((sel) => !/^\.picker\s/.test(sel));

    expect(mentionsHintOrWarning.length).toBeGreaterThan(0);
    expect(bare).toEqual([]);
  });
});
