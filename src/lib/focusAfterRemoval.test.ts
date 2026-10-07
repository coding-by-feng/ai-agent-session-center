import { describe, it, expect, beforeEach } from 'vitest';
import { focusSiblingAfterRemoval } from './focusAfterRemoval';

/** One <ul> per group, `n` rows each, plus a fallback button after them. */
function lists(...counts: number[]): { groups: HTMLLIElement[][]; fallback: HTMLButtonElement; root: HTMLElement } {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  const groups = counts.map((n, g) => {
    const ul = document.createElement('ul');
    const rows = Array.from({ length: n }, (_, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.open = '';
      b.textContent = `row ${g}.${i}`;
      li.append(b);
      ul.append(li);
      return li;
    });
    root.append(ul);
    return rows;
  });
  const fallback = document.createElement('button');
  fallback.textContent = 'compose';
  document.body.append(root, fallback);
  return { groups, fallback, root };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('focusSiblingAfterRemoval', () => {
  it('prefers the next row, then the previous, then the fallback', () => {
    const { groups: [rows], fallback } = lists(3);
    focusSiblingAfterRemoval(rows[1], '[data-open]', fallback);
    expect(document.activeElement?.textContent).toBe('row 0.2');

    focusSiblingAfterRemoval(rows[2], '[data-open]', fallback);
    expect(document.activeElement?.textContent).toBe('row 0.1');

    const single = lists(1);
    focusSiblingAfterRemoval(single.groups[0][0], '[data-open]', single.fallback);
    expect(document.activeElement).toBe(single.fallback);
  });

  it('skips a neighbour without the control instead of falling back', () => {
    const { groups: [rows], fallback } = lists(3);
    rows[1].querySelector('button')!.remove();
    focusSiblingAfterRemoval(rows[0], '[data-open]', fallback);
    expect(document.activeElement?.textContent).toBe('row 0.2');
  });

  it('stays inside the row’s own list by default', () => {
    const { groups, fallback } = lists(1, 2);
    focusSiblingAfterRemoval(groups[0][0], '[data-open]', fallback);
    expect(document.activeElement).toBe(fallback);
  });

  it('crosses into the next list, or back to the previous one, with a wider scope', () => {
    const { groups, fallback, root } = lists(1, 2, 1);
    focusSiblingAfterRemoval(groups[0][0], '[data-open]', fallback, root);
    expect(document.activeElement?.textContent).toBe('row 1.0');

    focusSiblingAfterRemoval(groups[2][0], '[data-open]', fallback, root);
    expect(document.activeElement?.textContent).toBe('row 1.1');
  });

  it('does nothing without a row or a fallback', () => {
    lists(1);
    const before = document.activeElement;
    focusSiblingAfterRemoval(null, '[data-open]');
    expect(document.activeElement).toBe(before);
  });
});
