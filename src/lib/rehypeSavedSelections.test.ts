import { describe, it, expect } from 'vitest';
import { makeSavedSelectionsPlugin, type SavedSelectionTerm } from './rehypeSavedSelections';

// Minimal hast-ish node shape for building test trees.
interface N {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: N[];
}

const text = (value: string): N => ({ type: 'text', value });
const el = (tagName: string, children: N[]): N => ({ type: 'element', tagName, properties: {}, children });
const root = (children: N[]): N => ({ type: 'root', children });

function run(tree: N, terms: SavedSelectionTerm[]): N {
  const transform = makeSavedSelectionsPlugin(terms)() as (t: N) => void;
  transform(tree);
  return tree;
}

const marks = (node: N): N[] => (node.children ?? []).filter((c) => c.tagName === 'mark');

describe('makeSavedSelectionsPlugin', () => {
  it('wraps a matching term in a <mark> carrying data-saved-uuid, splitting the text', () => {
    const tree = root([el('p', [text('land at portfolio scale, so')])]);
    run(tree, [{ text: 'scale', uuid: 'u1', alias: 'A' }]);
    const p = tree.children![0];
    expect(p.children).toHaveLength(3); // before, mark, after
    expect(p.children![0].value).toBe('land at portfolio ');
    const mark = p.children![1];
    expect(mark.tagName).toBe('mark');
    expect(mark.properties?.dataSavedUuid).toBe('u1');
    expect(mark.properties?.className).toEqual(['saved-selection']);
    expect(mark.children![0].value).toBe('scale');
    expect(p.children![2].value).toBe(', so');
  });

  it('does not highlight inside code/pre', () => {
    const tree = root([el('pre', [el('code', [text('scale')])])]);
    run(tree, [{ text: 'scale', uuid: 'u1', alias: '' }]);
    const code = tree.children![0].children![0];
    expect(code.children).toHaveLength(1);
    expect(code.children![0].type).toBe('text');
  });

  it('prefers the longer term when two start at the same position', () => {
    const tree = root([el('p', [text('the lower resolution here')])]);
    run(tree, [
      { text: 'lower', uuid: 'short', alias: '' },
      { text: 'lower resolution', uuid: 'long', alias: '' },
    ]);
    const [mark] = marks(tree.children![0]);
    expect(mark.children![0].value).toBe('lower resolution');
    expect(mark.properties?.dataSavedUuid).toBe('long');
  });

  it('is case-insensitive but preserves the original casing', () => {
    const tree = root([el('p', [text('Scale up')])]);
    run(tree, [{ text: 'scale', uuid: 'u1', alias: '' }]);
    const [mark] = marks(tree.children![0]);
    expect(mark.children![0].value).toBe('Scale');
  });

  it('leaves text untouched when nothing matches', () => {
    const tree = root([el('p', [text('nothing here')])]);
    run(tree, [{ text: 'scale', uuid: 'u1', alias: '' }]);
    expect(tree.children![0].children).toHaveLength(1);
    expect(tree.children![0].children![0].value).toBe('nothing here');
  });

  it('ignores trivially short terms (< 2 chars)', () => {
    const tree = root([el('p', [text('a b c')])]);
    run(tree, [{ text: 'a', uuid: 'u1', alias: '' }]);
    expect(marks(tree.children![0])).toHaveLength(0);
  });

  it('highlights every occurrence of a term in a line', () => {
    const tree = root([el('p', [text('scale and scale again')])]);
    run(tree, [{ text: 'scale', uuid: 'u1', alias: '' }]);
    expect(marks(tree.children![0])).toHaveLength(2);
  });
});
