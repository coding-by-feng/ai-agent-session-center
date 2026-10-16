// The phone's Project tab paints code with its own light/dark palette over highlight.js's
// github-dark-dimmed sheet (imported for the desktop and for Chat's dark code blocks). Found on a
// real iPhone (Oct 2026): `.hljs-title.function_` from that sheet ties `.code .hljs-title` on
// specificity, loads later and wins, so a function name was #dcbdfb on beige (1.35:1). Every
// selector the dark sheet colours needs a phone override, or it leaks its dark-theme colour.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

/** Selectors of every rule in the dark sheet that sets a colour, except the `.hljs` box itself. */
function colouredSelectors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const m of noComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/(^|[;\s])color\s*:/.test(m[2])) continue;
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (sel !== '.hljs') out.push(sel);
    }
  }
  return out;
}

describe('the phone Project tab code colours', () => {
  const dark = read('node_modules/highlight.js/styles/github-dark-dimmed.css');
  const phone = read('src/styles/modules/PhoneProject.module.css');

  it('override every selector the dark highlight sheet colours', () => {
    const selectors = colouredSelectors(dark);
    expect(selectors.length).toBeGreaterThan(20);
    const missing = selectors.filter((sel) => !phone.includes(`.code :global(${sel})`));
    expect(missing).toEqual([]);
  });
});
