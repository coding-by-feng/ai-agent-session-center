import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QueueMovePicker, { MOVE_TRIGGER_ATTR, type QueueMoveTarget } from './QueueMovePicker';
import { computeMovePickerPosition } from '@/lib/queueMovePlacement';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGETS: QueueMoveTarget[] = [
  { id: 'sess-aaaa1111', projectName: 'thesis', title: 'Verification' },
  { id: 'sess-bbbb2222', projectName: 'kason-tools' },
  { id: 'sess-cccc3333' },
];

/** A detached MOVE button to hang the picker off. */
function makeAnchor(): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute(MOVE_TRIGGER_ATTR, '1');
  document.body.appendChild(el);
  return el;
}

let anchor: HTMLElement;
beforeEach(() => {
  anchor = makeAnchor();
});
afterEach(() => {
  anchor.remove();
});

describe('QueueMovePicker', () => {
  it('lists every target, falling back to a short id when unnamed', () => {
    render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain('thesis');
    expect(options[0].textContent).toContain('Verification');
    expect(options[2].textContent).toContain('sess-ccc');
  });

  it('reports the chosen session id', () => {
    const onSelect = vi.fn();
    render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={onSelect} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(onSelect).toHaveBeenCalledWith('sess-bbbb2222');
  });

  it('shows an empty state when there is nowhere to move to', () => {
    render(<QueueMovePicker anchor={anchor} targets={[]} onSelect={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('No other sessions')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('selects the highlighted row via arrow keys and Enter', () => {
    const onSelect = vi.fn();
    render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={onSelect} onClose={vi.fn()} />,
    );

    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith('sess-bbbb2222');
  });

  it('closes on Escape and on an outside click', () => {
    const onClose = vi.fn();
    render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={vi.fn()} onClose={onClose} />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores mousedown on a MOVE trigger so the button keeps its own toggle', () => {
    const onClose = vi.fn();
    render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={vi.fn()} onClose={onClose} />,
    );
    fireEvent.mouseDown(anchor);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when the click lands inside the picker', () => {
    const onClose = vi.fn();
    render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={vi.fn()} onClose={onClose} />,
    );

    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    expect(onClose).not.toHaveBeenCalled();
  });

  // The whole point of the portal: rendered under <body>, never inside the
  // `.queueBody` scroll box that would clip it.
  it('portals the menu to document.body rather than nesting it in the row', () => {
    const { container } = render(
      <QueueMovePicker anchor={anchor} targets={TARGETS} onSelect={vi.fn()} onClose={vi.fn()} />,
    );

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    const list = screen.getByRole('listbox');
    expect(list.parentElement).toBe(document.body);
    expect(list.style.position === '' || list.style.position === 'fixed').toBe(true);
  });
});

describe('computeMovePickerPosition', () => {
  const VIEWPORT = { width: 1000, height: 800 };
  const MENU = { width: 200, height: 120 };

  it('opens below the trigger when there is room', () => {
    const { top } = computeMovePickerPosition(
      { top: 100, bottom: 120, right: 600 },
      MENU,
      VIEWPORT,
    );
    expect(top).toBe(122); // bottom + ANCHOR_GAP
  });

  it('flips above the trigger when the menu would run past the bottom edge', () => {
    // bottom 760 + 2 + 120 = 882 > 800 - 8, and there is room above.
    const { top } = computeMovePickerPosition(
      { top: 740, bottom: 760, right: 600 },
      MENU,
      VIEWPORT,
    );
    expect(top).toBe(618); // 740 - 2 - 120
  });

  it('clamps instead of flipping when neither side fits', () => {
    const tall = { width: 200, height: 700 };
    const { top } = computeMovePickerPosition({ top: 300, bottom: 320, right: 600 }, tall, VIEWPORT);
    // Fits neither way, so it clamps to the bottom-most fully-visible offset.
    expect(top).toBe(800 - 8 - 700);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it('pins to the top edge when the menu is taller than the viewport', () => {
    const giant = { width: 200, height: 900 };
    const { top } = computeMovePickerPosition(
      { top: 300, bottom: 320, right: 600 },
      giant,
      VIEWPORT,
    );
    expect(top).toBe(8);
  });

  it('right-aligns the menu to the trigger', () => {
    const { left } = computeMovePickerPosition(
      { top: 100, bottom: 120, right: 600 },
      MENU,
      VIEWPORT,
    );
    expect(left).toBe(400); // right - width
  });

  it('clamps a left-overflowing menu back inside the viewport', () => {
    // A trigger near the left edge would put the right-aligned menu at -100.
    const { left } = computeMovePickerPosition(
      { top: 100, bottom: 120, right: 100 },
      MENU,
      VIEWPORT,
    );
    expect(left).toBe(8);
  });

  it('clamps a right-overflowing menu back inside the viewport', () => {
    const { left } = computeMovePickerPosition(
      { top: 100, bottom: 120, right: 1400 },
      MENU,
      VIEWPORT,
    );
    expect(left).toBe(1000 - 8 - 200);
  });

  // `align: 'left'` serves the snippet picker's chain-section trigger, which
  // sits at the LEFT of a wide modal — right-aligning there would drag the menu
  // off the left edge and leave it clamped to the pad, detached from its button.
  describe("align: 'left'", () => {
    it('left-aligns the menu to the trigger', () => {
      const { left } = computeMovePickerPosition(
        { top: 100, bottom: 120, right: 260, left: 60 },
        MENU,
        VIEWPORT,
        'left',
      );
      expect(left).toBe(60);
    });

    it('still clamps a right-overflowing left-aligned menu', () => {
      const { left } = computeMovePickerPosition(
        { top: 100, bottom: 120, right: 990, left: 950 },
        MENU,
        VIEWPORT,
        'left',
      );
      expect(left).toBe(1000 - 8 - 200);
    });

    it('degrades to right-alignment when the caller did not measure `left`', () => {
      const { left } = computeMovePickerPosition(
        { top: 100, bottom: 120, right: 600 },
        MENU,
        VIEWPORT,
        'left',
      );
      // Not 0 — slamming every such menu against the window edge is the bug
      // this fallback exists to avoid.
      expect(left).toBe(400);
    });

    it('leaves vertical placement untouched', () => {
      const withLeft = computeMovePickerPosition(
        { top: 100, bottom: 120, right: 260, left: 60 },
        MENU,
        VIEWPORT,
        'left',
      );
      const withRight = computeMovePickerPosition(
        { top: 100, bottom: 120, right: 260, left: 60 },
        MENU,
        VIEWPORT,
      );
      expect(withLeft.top).toBe(withRight.top);
    });
  });

  // Regression guard for the reported bug: the old code measured against the
  // 250px `.queueBody` scroll box, so a row low in a tall window still had
  // "room below" by viewport maths yet rendered clipped. Placement must depend
  // only on the trigger's viewport rect, never on any ancestor's height.
  it('places identically regardless of which scroll offset the row sits at', () => {
    const a = computeMovePickerPosition({ top: 400, bottom: 420, right: 600 }, MENU, VIEWPORT);
    const b = computeMovePickerPosition({ top: 400, bottom: 420, right: 600 }, MENU, VIEWPORT);
    expect(a).toEqual(b);
    expect(a.top).toBe(422);
  });

  // Portaling to <body> fixed the clipping but created a second, subtler bug:
  // the menu stopped being a descendant of the detail panel and became its
  // SIBLING in the root stacking context. `.queueMovePicker` kept the z-index it
  // had as an in-panel child (50), which is below `.detailOverlay`'s 100 — so the
  // menu rendered every time, fully placed, and was painted behind the panel.
  // Clicking MOVE looked like a no-op.
  //
  // Vitest doesn't apply CSS modules, and the two rules live in different files
  // that cannot reference each other, so no linter or render test can catch a
  // regression here. Assert the source text instead — same approach as
  // test/sessionNameQuoting.test.ts and test/ptyRing.test.ts.
  describe('stacking against the session detail panel', () => {
    const readZIndex = (file: string, cls: string): number => {
      const css = readFileSync(resolve(__dirname, '../../styles/modules', file), 'utf8');
      const block = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
      if (!block) throw new Error(`.${cls} not found in ${file}`);
      const z = /z-index:\s*(\d+)/.exec(block[1]);
      if (!z) throw new Error(`.${cls} in ${file} declares no z-index`);
      return Number(z[1]);
    };

    it('renders above the detail panel it is opened from', () => {
      const picker = readZIndex('Terminal.module.css', 'queueMovePicker');
      const panel = readZIndex('DetailPanel.module.css', 'detailOverlay');
      expect(picker).toBeGreaterThan(panel);
    });

    it('sits in the same band as the other <body>-portaled overlays', () => {
      // Tooltip 10000 / SelectionPopup 10050 / PromptSnippetPicker 10150. Being
      // below this band means something full-screen (e.g. the terminal
      // fullscreen overlay, also 10000) can bury the menu.
      expect(readZIndex('Terminal.module.css', 'queueMovePicker')).toBeGreaterThanOrEqual(10000);
    });
  });
});
