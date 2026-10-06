import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent, act, within } from '@testing-library/react';

import SessionSwitcher from './SessionSwitcher';
import type { PlanUsage, Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore, ROOM_KILL_MODAL_ID } from '@/stores/uiStore';
import { useQueueStore } from '@/stores/queueStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { projectColorIndex } from '@/lib/projectGroups';
import { getClientId } from '@/lib/deviceIdentity';
import type { DevicePresence } from '@/types/websocket';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The strip hosts the panel's recent-directories menu, whose known-projects
// fetch would otherwise resolve outside act() after every test here. One stable
// array: a fresh literal per call re-runs the menu's effect forever.
const { KNOWN_PROJECTS } = vi.hoisted(() => ({ KNOWN_PROJECTS: [] as string[] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN_PROJECTS }));

/**
 * Progress remark — the note icon in the title row is the entry point for the
 * empty state, and the row below the title only exists once there is something
 * to show. See SessionSwitcher.tsx "Progress remark" block.
 */
describe('SessionSwitcher — progress remark', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: 's1',
    title: 'AASC Promotion',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: 'approval',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  const renderSwitcher = (session: Session) =>
    render(
      <SessionSwitcher
        currentSession={session}
        sessions={new Map([[session.sessionId, session]])}
        onSwitch={vi.fn()}
      />,
    );

  // The real store action, captured before any test swaps it out.
  const realSetSessionRemark = useSessionStore.getState().setSessionRemark;
  let setSessionRemark: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Swap a fresh mock in per test rather than vi.spyOn(getState(), ...):
    // Zustand's set() copies the action onto a NEW state object, so a spy
    // survives restoreAllMocks() on the old one and leaks calls between tests.
    setSessionRemark = vi.fn();
    useSessionStore.setState({ setSessionRemark } as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useSessionStore.setState({ sessions: new Map(), setSessionRemark: realSetSessionRemark } as never);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers the note icon as the entry point when the session has no remark', () => {
    renderSwitcher(makeSession());
    expect(screen.getByLabelText('Add a session remark')).toBeInTheDocument();
  });

  it('renders no remark row until there is a remark (bar stays one line)', () => {
    renderSwitcher(makeSession({ remark: undefined }));
    // The old "+ add remark" placeholder is gone — nothing but the icon.
    expect(screen.queryByText('+ add remark')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Remark:/)).not.toBeInTheDocument();
  });

  it('opens a focused editor when the note icon is clicked', () => {
    renderSwitcher(makeSession());
    fireEvent.click(screen.getByLabelText('Add a session remark'));

    const input = screen.getByLabelText('Session remark') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it('saves the remark on Enter', () => {
    renderSwitcher(makeSession());

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'waiting on design review' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setSessionRemark).toHaveBeenCalledWith('s1', 'waiting on design review');
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('saves the remark on blur (click-away)', () => {
    renderSwitcher(makeSession());

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'blurred note' } });
    fireEvent.blur(input);

    expect(setSessionRemark).toHaveBeenCalledWith('s1', 'blurred note');
  });

  it('discards the draft on Escape', () => {
    renderSwitcher(makeSession());

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'never mind' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(setSessionRemark).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('renders an existing remark as a clickable row below the title', () => {
    renderSwitcher(makeSession({ remark: 'blocked on review' }));
    expect(screen.getByText('blocked on review')).toBeInTheDocument();
  });

  it('seeds the editor with the existing remark when the row is clicked', () => {
    renderSwitcher(makeSession({ remark: 'blocked on review' }));
    fireEvent.click(screen.getByText('blocked on review'));

    expect((screen.getByLabelText('Session remark') as HTMLInputElement).value)
      .toBe('blocked on review');
  });

  it('clears the remark when the editor is emptied and committed', () => {
    renderSwitcher(makeSession({ remark: 'blocked on review' }));

    fireEvent.click(screen.getByText('blocked on review'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Clearing is a legitimate edit — it must reach the store, not be swallowed
    // by a truthiness guard.
    expect(setSessionRemark).toHaveBeenCalledWith('s1', '');
  });

  it('closing via the note icon saves rather than discarding', () => {
    renderSwitcher(makeSession());

    const icon = screen.getByLabelText('Add a session remark');
    fireEvent.click(icon);
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'typed then clicked the icon' } });

    fireEvent.click(icon);

    // Proves the commit branch of toggleRemarkEdit (remarkEditing === true).
    expect(setSessionRemark).toHaveBeenCalledWith('s1', 'typed then clicked the icon');
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('suppresses the note icon mousedown so the open editor never blurs first', () => {
    // The guard the test above RELIES ON but cannot observe: jsdom does not
    // shift focus on mousedown, so a blur→click sequence would pass even with
    // the guard deleted. Assert the preventDefault directly instead.
    renderSwitcher(makeSession());
    const icon = screen.getByLabelText('Add a session remark');
    fireEvent.click(icon); // open the editor

    const md = createEvent.mouseDown(icon);
    fireEvent(icon, md);
    expect(md.defaultPrevented).toBe(true);
  });

  it('does not hijack into the rename editor on a double-click of the note icon', () => {
    // The note button sits inside .switcherName, which renames on double-click.
    // Its onDoubleClick stopPropagation must keep a double-click from opening
    // the title editor (which would mount with the title pre-selected, so the
    // next keystroke would overwrite it).
    renderSwitcher(makeSession());
    const icon = screen.getByLabelText('Add a session remark');

    fireEvent.click(icon);
    fireEvent.click(icon);
    fireEvent.doubleClick(icon);

    expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument();
  });

  it('caps the remark at 200 chars to match the server schema', () => {
    renderSwitcher(makeSession());
    fireEvent.click(screen.getByLabelText('Add a session remark'));

    expect(screen.getByLabelText('Session remark')).toHaveAttribute('maxlength', '200');
  });

  it('abandons an open editor when the session changes', () => {
    const a = makeSession({ sessionId: 'a', title: 'A' });
    const b = makeSession({ sessionId: 'b', title: 'B' });
    const { rerender } = render(
      <SessionSwitcher currentSession={a} sessions={new Map([['a', a]])} onSwitch={vi.fn()} />,
    );

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    fireEvent.change(screen.getByLabelText('Session remark'), { target: { value: 'draft for A' } });

    rerender(
      <SessionSwitcher currentSession={b} sessions={new Map([['b', b]])} onSwitch={vi.fn()} />,
    );

    // A's draft must not be sitting in an editor pointed at B.
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('shows the note icon in the docked-left rail too', () => {
    useUiStore.setState({ navPosition: 'left', maximized: false, navRailCollapsed: false });
    renderSwitcher(makeSession());

    expect(screen.getByLabelText('Add a session remark')).toBeInTheDocument();
  });
});

/**
 * Queue-hint badge — the session tab card shows a cyan list-glyph + count when
 * that session has queued prompts (source: client queueStore). See the
 * `.sessionTabQueueBadge` block in SessionSwitcher.tsx.
 */
describe('SessionSwitcher — queue hint badge', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: 's1',
    title: 'AASC Promotion',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    // Not mid-turn: a running turn also lists the card in the RECENT frame,
    // and these tests look for one badge on one card.
    status: 'idle',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  // The tab strip shows the *other* sessions (the current one lives in the detail
  // view), so the badge is exercised on a non-current session's card.
  const renderWithCard = (carded: Session) => {
    const current = makeSession({ sessionId: 'cur', title: 'Current' });
    return render(
      <SessionSwitcher
        currentSession={current}
        sessions={new Map([[current.sessionId, current], [carded.sessionId, carded]])}
        onSwitch={vi.fn()}
      />,
    );
  };

  const queue = (sessionId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      sessionId,
      text: `prompt ${i + 1}`,
      position: i,
      createdAt: i + 1,
      type: 'once' as const,
    }));

  beforeEach(() => {
    useUiStore.setState({ navPosition: 'top', maximized: false });
    useQueueStore.setState({ queues: new Map() } as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useSessionStore.setState({ sessions: new Map() } as never);
    useQueueStore.setState({ queues: new Map() } as never);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the badge with the count when the session has queued prompts', () => {
    useQueueStore.getState().setQueue('s2', queue('s2', 2) as never);
    renderWithCard(makeSession({ sessionId: 's2', title: 'Queued Agent' }));
    expect(screen.getByLabelText('2 queued prompts')).toBeInTheDocument();
  });

  it('singularizes the label for a single queued prompt', () => {
    useQueueStore.getState().setQueue('s2', queue('s2', 1) as never);
    renderWithCard(makeSession({ sessionId: 's2', title: 'Queued Agent' }));
    expect(screen.getByLabelText('1 queued prompt')).toBeInTheDocument();
  });

  it('shows no badge when the queue is empty (no "0")', () => {
    renderWithCard(makeSession({ sessionId: 's2', title: 'Idle Agent' }));
    expect(screen.queryByLabelText(/queued prompt/)).not.toBeInTheDocument();
  });
});

/**
 * Pin toggle — the header icon row's own pin button (distinct from the
 * other-session tab cards' 📌 emoji .sessionTabPin further down), but the
 * same togglePin store action. See SessionSwitcher.tsx's PinIcon block.
 */
describe('SessionSwitcher — pin toggle', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: 's1',
    title: 'AASC Promotion',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: 'approval',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  const renderSwitcher = (session: Session) =>
    render(
      <SessionSwitcher
        currentSession={session}
        sessions={new Map([[session.sessionId, session]])}
        onSwitch={vi.fn()}
      />,
    );

  // The HEADER pin is a real <button>. The current session's own card — now
  // listed in the strip too — carries a pin <span> with the same label, so a
  // bare getByLabelText would be ambiguous; querying by button role is not.
  const headerPin = (name: string) => screen.getByRole('button', { name });

  // Same rationale as the remark block above: swap a fresh mock in per test
  // rather than vi.spyOn(getState(), ...), which a Zustand set() would outlive.
  const realTogglePin = useSessionStore.getState().togglePin;
  let togglePin: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    togglePin = vi.fn();
    useSessionStore.setState({ togglePin } as never);
  });

  afterEach(() => {
    useSessionStore.setState({ sessions: new Map(), togglePin: realTogglePin } as never);
    vi.restoreAllMocks();
  });

  it('offers a "Pin session" label when the session is not pinned', () => {
    renderSwitcher(makeSession({ pinned: false }));
    expect(headerPin('Pin session')).toBeInTheDocument();
  });

  it('offers an "Unpin session" label when the session is pinned', () => {
    renderSwitcher(makeSession({ pinned: true }));
    expect(headerPin('Unpin session')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin session' })).not.toBeInTheDocument();
  });

  it('reflects pinned state via aria-pressed', () => {
    renderSwitcher(makeSession({ pinned: true }));
    expect(headerPin('Unpin session')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls togglePin with the session id on click', () => {
    renderSwitcher(makeSession({ pinned: false }));
    fireEvent.click(headerPin('Pin session'));
    expect(togglePin).toHaveBeenCalledWith('s1');
  });

  it('does not open the rename editor on double-click (stopPropagation guard)', () => {
    renderSwitcher(makeSession({ pinned: false }));
    const btn = headerPin('Pin session');
    fireEvent.click(btn);
    fireEvent.doubleClick(btn);
    expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument();
  });
});

/**
 * Room reorder — the three new icons (drag handle, ▲, ▼) write ONLY
 * Room.listOrder, never Room.roomIndex (the 3D scene's world-space room
 * slot — see roomStore.ts). This is the composition these tests exist to
 * prove: useRoomDragReorder / roomDragReorder.ts are already fully covered
 * in isolation, so what's actually at risk here is the WIRING — did
 * SessionSwitcher.tsx connect them to the real room list and the real store
 * correctly, and does the pre-existing kill-room skull still work once three
 * more icons share its row.
 */
describe('SessionSwitcher — room reorder', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? 'Session',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: over.status ?? 'idle',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  const makeRoom = (over: Partial<Room>): Room => ({
    id: over.id ?? 'room-a',
    name: over.name ?? 'Room',
    sessionIds: over.sessionIds ?? [],
    collapsed: false,
    createdAt: 0,
    ...over,
  });

  function renderWithRooms(rooms: Room[], sessions: Session[]) {
    const current = sessions[0];
    const sessionMap = new Map(sessions.map((s) => [s.sessionId, s]));
    useRoomStore.setState({ rooms });
    return render(
      <SessionSwitcher currentSession={current} sessions={sessionMap} onSwitch={vi.fn()} />,
    );
  }

  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map() } as never);
    // The docked-left rail — the only layout that renders the drag grip. Set
    // explicitly: earlier describe blocks leave navPosition behind ('top' from
    // the queue-hint block), and these tests must not depend on file order.
    useUiStore.setState({
      activeModal: null, roomKillTargetId: null, sessionSortMode: 'room',
      navPosition: 'left', maximized: false, navRailCollapsed: false,
    });
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ activeModal: null, roomKillTargetId: null, navPosition: 'top' });
  });

  /** Two stacked room frames with real (synthetic) boxes, plus the strip. */
  function renderTwoRoomsWithBoxes() {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 1 });
    const { container } = renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);
    const frames = [
      screen.getByText('Alpha').closest('[title="Alpha"]') as HTMLElement,
      screen.getByText('Beta').closest('[title="Beta"]') as HTMLElement,
    ];
    frames.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ top: i * 100, bottom: i * 100 + 80, left: 0, right: 200, width: 200, height: 80, x: 0, y: i * 100, toJSON() { return this; } }) as DOMRect;
    });
    const strip = container.querySelector('[class*="sessionTabStrip"]') as HTMLElement;
    return { container, frames, strip };
  }

  function dispatchPointer(type: 'pointermove' | 'pointerup', clientY: number) {
    window.dispatchEvent(new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
      type, { clientX: 10, clientY, bubbles: true, cancelable: true },
    ));
  }

  it('while a room is carried, the strip enters drag mode and the passed room slides — no caret is painted', () => {
    const { container, frames, strip } = renderTwoRoomsWithBoxes();
    const handle = frames[0].querySelector('[class*="roomDragHandle"]') as HTMLElement;

    act(() => {
      fireEvent.pointerDown(handle, { clientX: 10, clientY: 40, button: 0, pointerType: 'mouse' });
    });
    act(() => { dispatchPointer('pointermove', 150); }); // bottom half of Beta → after it

    expect(strip.className).toMatch(/roomDragActive/);
    expect(frames[0].className).toMatch(/roomGroupDragging/);
    // Beta slides up by Alpha's pitch (80 tall + 20 gap) to open the slot.
    expect(frames[1].style.getPropertyValue('--room-shift')).toBe('-100px');
    expect(frames[0].style.getPropertyValue('--room-shift')).toBe('');
    // The old inset caret is gone — the opened slot IS the drop indicator.
    expect(container.querySelector('[class*="roomGroupDrop"]')).toBeNull();
    // Alpha rides the pointer through the hook's getFrameEl wiring: 110px of
    // travel, clamped to the 100px it can sink before its bottom meets Beta's.
    expect(frames[0].style.getPropertyValue('--room-drag-dy')).toBe('100px');

    act(() => { dispatchPointer('pointerup', 150); });

    expect(strip.className).not.toMatch(/roomDragActive/);
    expect(frames[1].style.getPropertyValue('--room-shift')).toBe('');
    expect(frames[0].style.getPropertyValue('--room-drag-dy')).toBe('');
    expect(useRoomStore.getState().rooms.find((r) => r.id === 'room-a')!.listOrder).toBe(1);
  });

  // ---- Carry-preview CSS guards ----
  // Vitest's CSS-module stub returns a class name for ANY key, so no rendered
  // assertion can tell whether these rules exist. They are read from the
  // stylesheet instead, like the LIFT_SCALE guard in useRoomDragReorder.test.

  /** Every `selector { body }` pair in DetailPanel.module.css (rules nested
   *  in @media blocks included, as their own pairs). */
  function cssRules(): { selector: string; body: string }[] {
    const css = readFileSync(resolve(__dirname, '../../styles/modules/DetailPanel.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
  }
  const transitionOf = (body: string) => /transition\s*:\s*([^;]+);/.exec(body)?.[1] ?? '';

  it('a resting room frame never transitions its position — or every drop would bounce', () => {
    // On drop, the new order commits in the same render that removes the
    // drag state. If a resting frame transitioned translate/transform, each
    // slid room would jump back one pitch and visibly slide into place.
    const resting = cssRules().filter((r) => r.selector === '.sessionTabRoomGroup');
    expect(resting.length).toBeGreaterThan(0);
    for (const r of resting) {
      expect(transitionOf(r.body)).not.toMatch(/\b(translate|transform|all)\b/);
    }
  });

  it('the slide transition exists only while a room is being dragged', () => {
    const sliding = cssRules().filter((r) => /\btranslate\b/.test(transitionOf(r.body)));
    expect(sliding.length).toBeGreaterThan(0);
    for (const r of sliding) expect(r.selector).toContain('.roomDragActive');
  });

  it('the grip is rail-only: the top bar renders no drag handle, and ▲▼ still reorder there', () => {
    // Rooms sit side by side in the top bar, but the drop math compares Y
    // only — a drag there could never land where it was released.
    useUiStore.setState({ navPosition: 'top' });
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 1 });
    const { container } = renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    expect(container.querySelector('[class*="roomDragHandle"]')).toBeNull();

    fireEvent.click(screen.getByLabelText('Move room Alpha down'));
    expect(screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent)).toEqual(['Beta', 'Alpha']);
  });

  it('falls back to roomIndex when neither room has an explicit listOrder', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a', title: 'Session A' });
    const sB = makeSession({ sessionId: 'b', title: 'Session B' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 1 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 0 });
    renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    const labels = screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent);
    expect(labels).toEqual(['Beta', 'Alpha']); // roomIndex 0 (Beta) before 1 (Alpha)
  });

  it('listOrder overrides roomIndex once a room has been explicitly reordered', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a', title: 'Session A' });
    const sB = makeSession({ sessionId: 'b', title: 'Session B' });
    // Beta has the lower roomIndex but a HIGHER listOrder -> listOrder wins.
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 1, listOrder: 0 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 0, listOrder: 1 });
    renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    const labels = screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent);
    expect(labels).toEqual(['Alpha', 'Beta']);
  });

  // ---- Icon legibility ----
  // The reported bug: the collapse chevron and the "move down" chevron were
  // the same glyph, two slots apart in the same 10px-tall, 60%-opacity row.
  // These assert the two INDEPENDENT signals that now separate them, so
  // restyling either one back toward the other turns a test red rather than
  // silently recreating the confusion.

  it('collapse and move-down are different glyph FAMILIES, not just different coordinates', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 1 });
    renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    const collapse = screen.getByLabelText('Collapse room Alpha').querySelector('svg')!;
    const down = screen.getByLabelText('Move room Alpha down').querySelector('svg')!;
    const up = screen.getByLabelText('Move room Alpha up').querySelector('svg')!;

    // Collapse: a FILLED disclosure triangle — solid mass, no stroked head.
    expect(collapse.getAttribute('fill')).toBe('currentColor');
    expect(collapse.querySelector('polyline')).toBeNull();

    // Move: STROKED arrows that each carry a shaft (<path>) as well as a
    // head (<polyline>). The shaft is what a bare chevron lacks.
    for (const arrow of [up, down]) {
      expect(arrow.getAttribute('fill')).toBe('none');
      expect(arrow.querySelector('polyline')).toBeTruthy();
      expect(arrow.querySelector('path')).toBeTruthy();
    }

    expect(collapse.innerHTML).not.toBe(down.innerHTML);
  });

  it('groups the header controls with hairline dividers so collapse never abuts the reorder pair', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a', status: 'idle' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const { container } = renderWithRooms([roomA], [sCurrent, sA]);

    const row = container.querySelector('[class*="roomHeaderRow"]')!;
    const dividers = row.querySelectorAll('[class*="roomHeaderDivider"]');
    // One between [grip collapse] and [up down]; one before the kill skull,
    // which only renders while the room has live sessions.
    expect(dividers.length).toBe(2);

    const kids = [...row.children];
    const collapseIdx = kids.indexOf(screen.getByLabelText('Collapse room Alpha'));
    const upIdx = kids.indexOf(screen.getByLabelText('Move room Alpha up'));
    const dividerIdx = kids.indexOf(dividers[0]);
    expect(collapseIdx).toBeLessThan(dividerIdx);
    expect(dividerIdx).toBeLessThan(upIdx);
  });

  it('the drag handle no longer tells desktop users to press and hold', () => {
    // A native title tooltip is hover-only, so it is read by pointing devices
    // — exactly the path that no longer requires a hold.
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const { container } = renderWithRooms([roomA], [sCurrent, sA]);

    const handle = container.querySelector('[class*="roomDragHandle"]')!;
    expect(handle.getAttribute('title')).toBe('Drag to reorder this room');
  });

  it('▲ is disabled on the first room, ▼ is disabled on the last room', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 1 });
    renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    expect(screen.getByLabelText('Move room Alpha up')).toBeDisabled();
    expect(screen.getByLabelText('Move room Alpha down')).not.toBeDisabled();
    expect(screen.getByLabelText('Move room Beta up')).not.toBeDisabled();
    expect(screen.getByLabelText('Move room Beta down')).toBeDisabled();
  });

  it('▼ swaps adjacent rooms via listOrder — and leaves BOTH rooms\' roomIndex byte-identical', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 5 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 9 });
    renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    expect(screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent)).toEqual(['Alpha', 'Beta']);

    fireEvent.click(screen.getByLabelText('Move room Alpha down'));

    // Order flipped in the actual rendered DOM, not just in the store.
    expect(screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent)).toEqual(['Beta', 'Alpha']);

    // THE regression this feature must never cause: roomIndex (the 3D scene's
    // world-space room slot) is completely untouched by a sidebar reorder.
    const after = useRoomStore.getState().rooms;
    expect(after.find((r) => r.id === 'room-a')!.roomIndex).toBe(5);
    expect(after.find((r) => r.id === 'room-b')!.roomIndex).toBe(9);
    // listOrder is what actually moved.
    expect(after.find((r) => r.id === 'room-b')!.listOrder).toBe(0);
    expect(after.find((r) => r.id === 'room-a')!.listOrder).toBe(1);
  });

  it('▲ on the second room has the same effect as ▼ on the first (symmetric swap)', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 0 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 1 });
    renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

    fireEvent.click(screen.getByLabelText('Move room Beta up'));

    expect(screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent)).toEqual(['Beta', 'Alpha']);
    const after = useRoomStore.getState().rooms;
    expect(after.find((r) => r.id === 'room-a')!.roomIndex).toBe(0);
    expect(after.find((r) => r.id === 'room-b')!.roomIndex).toBe(1);
  });

  it('REGRESSION: the kill-all-sessions-in-room skull still opens the confirm modal with the three new icons present', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a', status: 'idle' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'] });
    renderWithRooms([roomA], [sCurrent, sA]);

    fireEvent.click(screen.getByLabelText(/^Kill all \d+ sessions? in room Alpha$/));

    expect(useUiStore.getState().activeModal).toBe(ROOM_KILL_MODAL_ID);
    expect(useUiStore.getState().roomKillTargetId).toBe('room-a');
  });

  // NOTE: this test logs a benign "not wrapped in act()" warning despite every
  // dispatch below being act()-wrapped. commitRoomOrder issues two sequential
  // Zustand set() calls (one per room); each notifies subscribers and
  // re-renders synchronously, and the second appears to fall outside the
  // outer act() boundary in this RTL/React combination. All assertions below
  // pass deterministically regardless — the warning is about render-batching
  // hygiene, not about the result being wrong. Not worth adding a batched
  // multi-room store setter solely to silence it.
  it('drag end-to-end through the real rendered component reorders and writes listOrder only', () => {
    const sCurrent = makeSession({ sessionId: 'cur' });
    const sA = makeSession({ sessionId: 'a' });
    const sB = makeSession({ sessionId: 'b' });
    const roomA = makeRoom({ id: 'room-a', name: 'Alpha', sessionIds: ['a'], roomIndex: 3 });
    const roomB = makeRoom({ id: 'room-b', name: 'Beta', sessionIds: ['b'], roomIndex: 7 });

    // Fake timers must be active BEFORE the press fires — the hook's hold
    // setTimeout is scheduled at pointerdown time, so switching to fake
    // timers afterward creates a second, unrelated timer context that has no
    // knowledge of the real one already pending.
    vi.useFakeTimers();
    try {
      renderWithRooms([roomA, roomB], [sCurrent, sA, sB]);

      // Real DOM measurement: stub getBoundingClientRect per room frame based
      // on its CURRENT position in the document, so the hook's one-time
      // measure-at-lift-off reads real (if synthetic) boxes rather than
      // jsdom's default all-zero rect.
      const frames = [
        screen.getByText('Alpha').closest('[title="Alpha"]') as HTMLElement,
        screen.getByText('Beta').closest('[title="Beta"]') as HTMLElement,
      ];
      frames.forEach((el, i) => {
        el.getBoundingClientRect = () =>
          ({ top: i * 100, bottom: i * 100 + 80, left: 0, right: 200, width: 200, height: 80, x: 0, y: i * 100, toJSON() { return this; } }) as DOMRect;
      });

      const handle = frames[0].querySelector('[aria-hidden="true"]') as HTMLElement;
      expect(handle).toBeTruthy();

      act(() => {
        fireEvent.pointerDown(handle, { clientX: 10, clientY: 40, button: 0, pointerType: 'touch' });
        vi.advanceTimersByTime(400);
      });
      // Raw window.dispatchEvent (unlike fireEvent) isn't auto-wrapped in
      // act() — both resulting setStates (insertIndex, then the drop commit)
      // need it.
      act(() => {
        window.dispatchEvent(new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
          'pointermove', { clientX: 10, clientY: 150, bubbles: true, cancelable: true },
        ));
      });
      act(() => {
        window.dispatchEvent(new Event('pointerup', { bubbles: true }));
      });

      const after = useRoomStore.getState().rooms;
      expect(after.find((r) => r.id === 'room-a')!.roomIndex).toBe(3);
      expect(after.find((r) => r.id === 'room-b')!.roomIndex).toBe(7);
      expect(after.find((r) => r.id === 'room-a')!.listOrder).toBe(1);
      expect(after.find((r) => r.id === 'room-b')!.listOrder).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The session you are in is listed too. The strip used to drop it (it was a
 * "switch to another session" list), which also removed any room whose only
 * session was the current one — the reported "SMS OPS is missing" case.
 */
describe('SessionSwitcher — the current session is listed too', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? 'Session',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: over.status ?? 'idle',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  const makeRoom = (over: Partial<Room>): Room => ({
    id: over.id ?? 'room-a',
    name: over.name ?? 'Room',
    sessionIds: over.sessionIds ?? [],
    collapsed: false,
    createdAt: 0,
    ...over,
  });

  const cur = makeSession({ sessionId: 'cur', title: 'SMS Fixing' });
  const other = makeSession({ sessionId: 'x', title: 'Exmouth' });
  const sms = makeRoom({ id: 'room-sms', name: 'SMS OPS', sessionIds: ['cur'], roomIndex: 0 });
  const exm = makeRoom({ id: 'room-exm', name: 'EXMOUTH', sessionIds: ['x'], roomIndex: 1 });

  function renderSwitcher(rooms: Room[], sessions: Session[]) {
    useRoomStore.setState({ rooms });
    const onSwitch = vi.fn();
    const utils = render(
      <SessionSwitcher
        currentSession={sessions[0]}
        sessions={new Map(sessions.map((s) => [s.sessionId, s]))}
        onSwitch={onSwitch}
      />,
    );
    return { ...utils, onSwitch };
  }
  const frameOf = (container: HTMLElement, name: string) =>
    container.querySelector(`[class*="sessionTabRoomGroup"][title="${name}"]`) as HTMLElement | null;

  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map() } as never);
    useUiStore.setState({
      activeModal: null, roomKillTargetId: null, sessionSortMode: 'room',
      navPosition: 'left', maximized: false, navRailCollapsed: false, selectedRoomIds: new Set(),
    });
  });

  afterEach(() => {
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ navPosition: 'top', selectedRoomIds: new Set() });
  });

  it('shows the current session inside its room frame, even as that room\'s only session', () => {
    const { container } = renderSwitcher([sms, exm], [cur, other]);
    const frame = frameOf(container, 'SMS OPS');
    expect(frame).toBeTruthy();
    expect(within(frame!).getByText('SMS Fixing')).toBeInTheDocument();
  });

  it('marks the current card as current, and only that card', () => {
    const { container } = renderSwitcher([sms, exm], [cur, other]);
    const marked = container.querySelectorAll('[aria-current="true"]');
    expect(marked).toHaveLength(1);
    expect(frameOf(container, 'SMS OPS')!.contains(marked[0])).toBe(true);
    expect(marked[0].className).toMatch(/sessionTabCardCurrent/);
  });

  it('numbers the current card the same as the header', () => {
    const { container } = renderSwitcher([sms, exm], [cur, other]);
    const header = container.querySelector('[class*="switcherIndex"]')!.textContent;
    const card = container.querySelector('[aria-current="true"] [class*="sessionTabIndex"]')!.textContent;
    expect(card).toBe(header);
  });

  it('clicking the current card keeps you where you are — it never re-selects it', () => {
    // Re-selecting the current session would overwrite previousSessionId
    // with itself and silently break the switch-to-previous shortcut.
    const { container, onSwitch } = renderSwitcher([sms, exm], [cur, other]);
    fireEvent.click(container.querySelector('[aria-current="true"]')!);
    expect(onSwitch).not.toHaveBeenCalled();
    fireEvent.click(within(frameOf(container, 'EXMOUTH')!).getByText('Exmouth'));
    expect(onSwitch).toHaveBeenCalledWith('x');
  });

  it('the room filter treats the current card like any other — the header still shows it', () => {
    useUiStore.setState({ selectedRoomIds: new Set(['room-exm']) });
    const { container } = renderSwitcher([sms, exm], [cur, other]);
    expect(frameOf(container, 'SMS OPS')).toBeNull();
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(frameOf(container, 'EXMOUTH')).toBeTruthy();
    expect(screen.getAllByText('SMS Fixing').length).toBeGreaterThan(0); // header
  });

  it('a workspace with only the current session shows a one-card list', () => {
    const { container } = renderSwitcher([], [cur]);
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  // ---- Review fixes: what listing the current card newly exposed ----

  /** Re-render the switcher as DetailPanel does after a switch. */
  function switchTo(rerender: (ui: React.ReactElement) => void, sessions: Session[], currentId: string, onSwitch = vi.fn()) {
    rerender(
      <SessionSwitcher
        currentSession={sessions.find((s) => s.sessionId === currentId)!}
        sessions={new Map(sessions.map((s) => [s.sessionId, s]))}
        onSwitch={onSwitch}
      />,
    );
  }
  const cardOf = (container: HTMLElement, title: string) =>
    [...container.querySelectorAll('button[class*="sessionTabCard"]')]
      .find((b) => b.querySelector('[class*="sessionTabTitle"]')?.textContent?.includes(title)) as HTMLElement;

  it('a completed ✓ never shows on the current card, and viewing a session clears it', () => {
    // B finishes while you are on A, then you reach B some way other than the
    // strip (sidebar, Cmd+N, Cmd+E) — its card is now the current one.
    const b = makeSession({ sessionId: 'x', title: 'Exmouth', status: 'working' });
    const { container, rerender } = renderSwitcher([sms, exm], [cur, b]);
    const bDone = { ...b, status: 'waiting' } as Session;
    switchTo(rerender, [cur, bDone], 'cur');
    expect(cardOf(container, 'Exmouth').querySelector('[class*="sessionTabAttentionBadge"]')).toBeTruthy();

    switchTo(rerender, [cur, bDone], 'x');
    expect(cardOf(container, 'Exmouth').querySelector('[class*="sessionTabAttentionBadge"]')).toBeNull();

    switchTo(rerender, [cur, bDone], 'cur'); // leave it: it has been seen
    expect(cardOf(container, 'Exmouth').querySelector('[class*="sessionTabAttentionBadge"]')).toBeNull();
  });

  // ---- The completed ✓ must not outlive the completion ----
  // Raised when a card finishes while you are elsewhere, cleared by viewing it. Nothing else cleared
  // it, and it outranks the status glyph — so a card that had moved on (a queued prompt fired, a tool
  // needed approval, the session was resumed) kept saying "completed" until it was clicked.
  const attentionOf = (container: HTMLElement) =>
    cardOf(container, 'Exmouth').querySelector('[class*="sessionTabAttentionBadge"]');
  const statusBadgeOf = (container: HTMLElement) =>
    cardOf(container, 'Exmouth').querySelector('[class*="sessionTabStatusBadge"]');

  /** B finishes while you are on `cur`; hands back the render so a test can move B on. */
  function finishedWhileAway() {
    const b = makeSession({ sessionId: 'x', title: 'Exmouth', status: 'working' });
    const utils = renderSwitcher([sms, exm], [cur, b]);
    switchTo(utils.rerender, [cur, { ...b, status: 'waiting' } as Session], 'cur');
    expect(attentionOf(utils.container)).toBeTruthy();
    return { ...utils, b };
  }

  it.each([
    ['working', 'Working'],
    ['prompting', 'Prompting'],
    ['approval', 'Approval needed'],
    ['input', 'Waiting for input'],
    ['connecting', 'Connecting'],
  ])('a completed ✓ gives way to the live status when the session becomes %s — no click needed', (status, label) => {
    const { container, rerender, b } = finishedWhileAway();
    switchTo(rerender, [cur, { ...b, status } as Session], 'cur');
    expect(attentionOf(container)).toBeNull();
    expect(statusBadgeOf(container)?.getAttribute('aria-label')).toBe(label);
  });

  it('…but it survives auto-idle: a finished session nobody has looked at is still ready for review', () => {
    const { container, rerender, b } = finishedWhileAway();
    switchTo(rerender, [cur, { ...b, status: 'idle' } as Session], 'cur');
    expect(attentionOf(container)).toBeTruthy();
  });

  it('a second completion raises the ✓ again', () => {
    const { container, rerender, b } = finishedWhileAway();
    switchTo(rerender, [cur, { ...b, status: 'working' } as Session], 'cur');
    expect(attentionOf(container)).toBeNull();
    switchTo(rerender, [cur, { ...b, status: 'waiting' } as Session], 'cur');
    expect(attentionOf(container)).toBeTruthy();
  });

  it('a session that ends and is resumed does not come back wearing the old ✓', () => {
    // An ended session has no card, so the stale flag is invisible until the same id returns.
    const { container, rerender, b } = finishedWhileAway();
    switchTo(rerender, [cur, { ...b, status: 'ended' } as Session], 'cur');
    switchTo(rerender, [cur, { ...b, status: 'connecting' } as Session], 'cur');
    expect(attentionOf(container)).toBeNull();
    expect(statusBadgeOf(container)?.getAttribute('aria-label')).toBe('Connecting');
  });

  it('a session that leaves and returns finished is a first sighting, not a completion', () => {
    // Its remembered status goes with it: a returning card has nothing to compare against, so it is
    // not raised as "just completed" (a restore would otherwise flag every finished session).
    const b = makeSession({ sessionId: 'x', title: 'Exmouth', status: 'working' });
    const { container, rerender } = renderSwitcher([sms, exm], [cur, b]);
    switchTo(rerender, [cur], 'cur'); // B leaves while it is still working
    switchTo(rerender, [cur, { ...b, status: 'waiting' } as Session], 'cur'); // …and returns finished
    expect(attentionOf(container)).toBeNull();
    expect(statusBadgeOf(container)?.getAttribute('aria-label')).toBe('Waiting');
  });

  it('a card that disappears takes its ✓ with it, so it cannot come back stale', () => {
    const { container, rerender, b } = finishedWhileAway();
    switchTo(rerender, [cur], 'cur'); // B is gone from the store
    switchTo(rerender, [cur, { ...b, status: 'idle' } as Session], 'cur'); // …and returns, idle
    expect(attentionOf(container)).toBeNull();
    expect(statusBadgeOf(container)?.getAttribute('aria-label')).toBe('Idle');
  });

  it('after switching to a card, clicking it again does nothing', () => {
    const onSwitch = vi.fn();
    useRoomStore.setState({ rooms: [sms, exm] });
    const sessions = [cur, other];
    const { container, rerender } = render(
      <SessionSwitcher currentSession={cur} sessions={new Map(sessions.map((s) => [s.sessionId, s]))} onSwitch={onSwitch} />,
    );
    fireEvent.click(cardOf(container, 'Exmouth'));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    switchTo(rerender, sessions, 'x', onSwitch);
    fireEvent.click(cardOf(container, 'Exmouth'));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });

  it('a double-click that OPENS a session never starts renaming it', () => {
    // Click 1 switches to the card; the card now stays (as the current one),
    // so click 2's dblclick lands on it. That is "open", not "rename".
    const onSwitch = vi.fn();
    useRoomStore.setState({ rooms: [sms, exm] });
    const untitled = makeSession({ sessionId: 'x', title: '', projectName: 'beta-proj' } as Partial<Session>);
    const sessions = [cur, untitled];
    const { container, rerender } = render(
      <SessionSwitcher currentSession={cur} sessions={new Map(sessions.map((s) => [s.sessionId, s]))} onSwitch={onSwitch} />,
    );
    const card = cardOf(container, 'beta-proj');
    fireEvent.mouseDown(card, { detail: 1 });
    fireEvent.click(card, { detail: 1 });
    switchTo(rerender, sessions, 'x', onSwitch);
    const same = cardOf(container, 'beta-proj');
    fireEvent.mouseDown(same, { detail: 2 });
    fireEvent.click(same, { detail: 2 });
    fireEvent.doubleClick(same.querySelector('[class*="sessionTabTitle"]')!);
    expect(within(same).queryByLabelText('Session title')).toBeNull();
  });

  it('double-clicking the current card renames it — and an untouched pre-fill is never saved', () => {
    const setSessionTitle = vi.fn();
    const real = useSessionStore.getState().setSessionTitle;
    useSessionStore.setState({ setSessionTitle } as never);
    try {
      const untitled = makeSession({ sessionId: 'cur', title: '', projectName: 'sms-ops' } as Partial<Session>);
      const { container } = renderSwitcher([sms, exm], [untitled, other]);
      const card = container.querySelector('[aria-current="true"]') as HTMLElement;
      fireEvent.mouseDown(card, { detail: 1 });
      fireEvent.doubleClick(card.querySelector('[class*="sessionTabTitle"]')!);
      const input = within(card).getByLabelText('Session title') as HTMLInputElement;
      expect(input.value).toBe('sms-ops');
      fireEvent.blur(input); // clicked away without typing
      // Saving the pre-filled project name would be a manual rename, which
      // permanently suppresses the automatic title from the first prompt.
      expect(setSessionTitle).not.toHaveBeenCalled();

      fireEvent.mouseDown(card, { detail: 1 });
      fireEvent.doubleClick(card.querySelector('[class*="sessionTabTitle"]')!);
      const again = within(card).getByLabelText('Session title');
      fireEvent.change(again, { target: { value: 'SMS Fixing' } });
      fireEvent.keyDown(again, { key: 'Enter' });
      expect(setSessionTitle).toHaveBeenCalledWith('cur', 'SMS Fixing');
    } finally {
      useSessionStore.setState({ setSessionTitle: real } as never);
    }
  });

  it('the header rename never saves an untouched pre-fill either', () => {
    const setSessionTitle = vi.fn();
    const real = useSessionStore.getState().setSessionTitle;
    useSessionStore.setState({ setSessionTitle } as never);
    try {
      const untitled = makeSession({ sessionId: 'cur', title: '', projectName: 'sms-ops' } as Partial<Session>);
      const { container } = renderSwitcher([sms, exm], [untitled, other]);
      fireEvent.doubleClick(container.querySelector('[class*="switcherNameText"]')!);
      const input = container.querySelector('input[class*="switcherNameInput"]') as HTMLInputElement;
      expect(input.value).toBe('sms-ops');
      fireEvent.blur(input);
      expect(setSessionTitle).not.toHaveBeenCalled();
    } finally {
      useSessionStore.setState({ setSessionTitle: real } as never);
    }
  });

  it('the current card\'s pin still toggles pinning, without switching', () => {
    const togglePin = vi.fn();
    const real = useSessionStore.getState().togglePin;
    useSessionStore.setState({ togglePin } as never);
    try {
      const { container, onSwitch } = renderSwitcher([sms, exm], [cur, other]);
      const pin = container.querySelector('[aria-current="true"] [class*="sessionTabPin"]') as HTMLElement;
      fireEvent.click(pin);
      expect(togglePin).toHaveBeenCalledWith('cur');
      expect(onSwitch).not.toHaveBeenCalled();
    } finally {
      useSessionStore.setState({ togglePin: real } as never);
    }
  });

  it('lists the current session in the top-bar layout too', () => {
    useUiStore.setState({ navPosition: 'top' });
    const { container } = renderSwitcher([sms, exm], [cur, other]);
    expect(frameOf(container, 'SMS OPS')).toBeTruthy();
    expect(container.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });
});


/**
 * The built-in RECENT frame: pinned above the user's rooms, listing sessions
 * with recent work. Each is listed there AND in its own room. The rule itself
 * (what counts as recent, the order) is covered in src/lib/recentSessions.test.ts.
 */
describe('SessionSwitcher — built-in RECENT frame', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;

  /** Recent work: a prompt `promptMin` ago, its turn ended `stopMin` ago. */
  const worked = (promptMin: number, stopMin = promptMin) => ({
    promptHistory: [{ text: 'go', timestamp: NOW - promptMin * MIN }],
    events: [
      { type: 'UserPromptSubmit', timestamp: NOW - promptMin * MIN, detail: '' },
      { type: 'Stop', timestamp: NOW - stopMin * MIN, detail: '' },
    ],
  });

  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? 'Session',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: over.status ?? 'idle',
    startedAt: NOW - 120 * MIN,
    // Fresh on every session, as after a workspace restore. RECENT must not
    // read it, or every session below would be "recent".
    lastActivityAt: NOW,
    events: [{ type: 'SessionStart', timestamp: NOW, detail: '' }],
    promptHistory: [],
    ...over,
  } as Session);

  const makeRoom = (over: Partial<Room>): Room => ({
    id: over.id ?? 'room-a',
    name: over.name ?? 'Room',
    sessionIds: over.sessionIds ?? [],
    collapsed: false,
    createdAt: 0,
    ...over,
  });

  const qa = makeSession({ sessionId: 'qa', title: 'AASC Q & A', ...worked(2, 1) });
  const builder = makeSession({ sessionId: 'b', title: 'AASC Codex Builder', ...worked(9, 4) });
  const sms = makeSession({ sessionId: 'sms', title: 'SMS Fixing', ...worked(20, 15) });
  const exm = makeSession({ sessionId: 'x', title: 'Exmouth' }); // restored, never worked since
  const roomSms = makeRoom({ id: 'room-sms', name: 'SMS OPS', sessionIds: ['sms'], roomIndex: 0 });
  const roomExm = makeRoom({ id: 'room-exm', name: 'EXMOUTH', sessionIds: ['x'], roomIndex: 1 });
  const roomAasc = makeRoom({ id: 'room-aasc', name: 'AASC', sessionIds: ['qa', 'b'], roomIndex: 2 });
  const allRooms = [roomSms, roomExm, roomAasc];

  function renderSwitcher(sessions: Session[], rooms: Room[] = allRooms) {
    useRoomStore.setState({ rooms });
    return render(
      <SessionSwitcher
        currentSession={sessions[0]}
        sessions={new Map(sessions.map((s) => [s.sessionId, s]))}
        onSwitch={vi.fn()}
      />,
    );
  }

  /** The strip's frames in render order (label spans are grandchildren). */
  const framesOf = (container: HTMLElement) =>
    [...container.querySelectorAll(':scope [class*="sessionTabStrip"] > [class*="sessionTabRoomGroup"]')] as HTMLElement[];
  const recentOf = (container: HTMLElement) =>
    container.querySelector('[class*="recentRoomGroup"]') as HTMLElement | null;
  const titlesIn = (frame: HTMLElement) =>
    [...frame.querySelectorAll('[class*="sessionTabTitle"]')].map((el) => el.textContent);
  const roomFrame = (container: HTMLElement, name: string) =>
    framesOf(container).find((f) => f.getAttribute('title') === name) as HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    useSessionStore.setState({ sessions: new Map() } as never);
    useUiStore.setState({
      activeModal: null, roomKillTargetId: null, sessionSortMode: 'room',
      navPosition: 'left', maximized: false, navRailCollapsed: false,
      selectedRoomIds: new Set(), recentRoomCollapsed: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ navPosition: 'top', selectedRoomIds: new Set(), recentRoomCollapsed: false, sessionSortMode: 'room' });
  });

  it('sits above every room and lists recent sessions, newest prompt first', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    const frames = framesOf(container);
    expect(frames[0]).toBe(recentOf(container));
    expect(within(frames[0]).getByText('Recent')).toBeInTheDocument();
    expect(titlesIn(frames[0])).toEqual(['AASC Q & A', 'AASC Codex Builder', 'SMS Fixing']);
  });

  it('keeps each recent session in its own room too, under the same number', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    const recent = recentOf(container)!;
    const aasc = roomFrame(container, 'AASC');
    // The room keeps its own order (status, then title); RECENT has its own.
    expect([...titlesIn(aasc)].sort()).toEqual(['AASC Codex Builder', 'AASC Q & A']);
    const numberIn = (frame: HTMLElement, title: string) =>
      within(frame).getByText(title).closest('button')!.querySelector('[class*="sessionTabIndex"]')!.textContent;
    expect(numberIn(recent, 'AASC Codex Builder')).toBe(numberIn(aasc, 'AASC Codex Builder'));
  });

  it('leaves out a session that only restarted (fresh lastActivityAt, no work)', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    expect(titlesIn(recentOf(container)!)).not.toContain('Exmouth');
    expect(titlesIn(roomFrame(container, 'EXMOUTH'))).toEqual(['Exmouth']);
  });

  it('is absent when nothing is recent', () => {
    const { container } = renderSwitcher([exm]);
    expect(recentOf(container)).toBeNull();
  });

  it('has a collapse toggle and nothing else — no grip, no ▲▼, no kill-all', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    const recent = recentOf(container)!;
    expect(within(recent).getByRole('button', { name: 'Collapse Recent' })).toBeInTheDocument();
    expect(recent.querySelector('[class*="roomDragHandle"]')).toBeNull();
    expect(recent.querySelector('[class*="roomMoveToggle"]')).toBeNull();
    expect(recent.querySelector('[class*="roomKillToggle"]')).toBeNull();
  });

  it('is not part of room reordering: ▲ on the first real room stays disabled', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    expect(screen.getByRole('button', { name: 'Move room SMS OPS up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move room AASC down' })).toBeDisabled();
    expect(framesOf(container)).toHaveLength(4);
  });

  it('collapses to a count, and remembers it through the ui store', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    fireEvent.click(within(recentOf(container)!).getByRole('button', { name: 'Collapse Recent' }));
    expect(useUiStore.getState().recentRoomCollapsed).toBe(true);
    const recent = recentOf(container)!;
    expect(titlesIn(recent)).toEqual([]);
    expect(recent.querySelector('[class*="roomCollapsedCount"]')!.textContent).toBe('3');
    expect(within(recent).getByRole('button', { name: 'Expand Recent' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('marks only the real-room copy of the current session as aria-current', () => {
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    const marked = container.querySelectorAll('[aria-current="true"]');
    expect(marked).toHaveLength(1);
    expect(roomFrame(container, 'AASC').contains(marked[0])).toBe(true);
    // The RECENT copy still looks current.
    const copy = within(recentOf(container)!).getByText('AASC Q & A').closest('button')!;
    expect(copy.className).toMatch(/sessionTabCardCurrent/);
  });

  it('follows the room filter like the rest of the list', () => {
    useUiStore.setState({ selectedRoomIds: new Set(['room-sms']) });
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    expect(titlesIn(recentOf(container)!)).toEqual(['SMS Fixing']);
  });

  it('is not shown in the flat recent-activity sort', () => {
    useUiStore.setState({ sessionSortMode: 'activity' });
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    expect(recentOf(container)).toBeNull();
  });

  it('lets a session go once it has been quiet for the whole window, with no update arriving', () => {
    const nearlyStale = makeSession({ sessionId: 'n', title: 'Nearly stale', ...worked(40, 29) });
    const { container } = renderSwitcher([qa, nearlyStale], [makeRoom({ id: 'r', name: 'R', sessionIds: ['qa', 'n'] })]);
    expect(titlesIn(recentOf(container)!)).toEqual(['AASC Q & A', 'Nearly stale']);
    act(() => { vi.advanceTimersByTime(2 * MIN); });
    expect(titlesIn(recentOf(container)!)).toEqual(['AASC Q & A']);
  });

  it('shows in the top-bar layout too, first', () => {
    useUiStore.setState({ navPosition: 'top' });
    const { container } = renderSwitcher([qa, builder, sms, exm]);
    expect(framesOf(container)[0]).toBe(recentOf(container));
  });

  it('a card in RECENT switches to its session like any other card', () => {
    useRoomStore.setState({ rooms: allRooms });
    const onSwitch = vi.fn();
    const sessions = [qa, builder, sms, exm];
    const { container } = render(
      <SessionSwitcher currentSession={qa} sessions={new Map(sessions.map((s) => [s.sessionId, s]))} onSwitch={onSwitch} />,
    );
    fireEvent.click(within(recentOf(container)!).getByText('SMS Fixing').closest('button')!);
    expect(onSwitch).toHaveBeenCalledWith('sms');
  });
});

/**
 * The PROJECT view: one frame per project directory instead of per room, each with buttons that start
 * a new Claude / Codex session there. The grouping rules themselves are projectGroups.test.ts's; the
 * header's launch behaviour is ProjectFrameHeader.test.tsx's. This block covers how the strip puts
 * them together.
 */
describe('SessionSwitcher — project view', () => {
  const mk = (over: Partial<Session> & { sessionId: string }): Session =>
    ({
      title: over.sessionId,
      projectName: '',
      projectPath: '',
      status: 'idle',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      ...over,
    }) as Session;

  const queueFloat = mk({ sessionId: 'a1', title: 'Queue float', projectName: 'agent-manager', projectPath: '/w/agent-manager' });
  // A trailing slash, and mid-turn so it sorts ahead of the idle one in the strip's status order.
  const pinnedKill = mk({ sessionId: 'a2', title: 'Pinned kill', projectName: 'agent-manager', projectPath: '/w/agent-manager/', status: 'working' });
  const kts = mk({ sessionId: 'k1', title: 'KTS Agent', projectName: 'kts', projectPath: '/w/kts' });
  const loose = mk({ sessionId: 'x1', title: 'Loose end', projectName: '', projectPath: '' });
  const deploy = mk({ sessionId: 'r1', title: 'Deploy', projectName: 'api', projectPath: '/srv/api', sshHost: 'build-box' });

  const makeRoom = (over: Partial<Room>): Room => ({
    id: 'room-a', name: 'Room', sessionIds: [], collapsed: false, createdAt: 0, ...over,
  });

  const realSelectSession = useSessionStore.getState().selectSession;
  let selectSession: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function renderProjects(sessions: Session[], rooms: Room[] = []) {
    useRoomStore.setState({ rooms });
    const view = render(
      <SessionSwitcher currentSession={sessions[0]} sessions={new Map(sessions.map((s) => [s.sessionId, s]))} onSwitch={vi.fn()} />,
    );
    return {
      ...view,
      /** Same strip, a fresh sessions Map: what the store hands the switcher on every update. */
      update: (next: Session[]) =>
        view.rerender(
          <SessionSwitcher currentSession={next[0]} sessions={new Map(next.map((s) => [s.sessionId, s]))} onSwitch={vi.fn()} />,
        ),
    };
  }

  const projectFrames = (container: HTMLElement) =>
    [...container.querySelectorAll('[class*="projectGroup"]')] as HTMLElement[];
  const labelOf = (frame: HTMLElement) => frame.querySelector('[class*="sessionTabRoomGroupLabel"]')?.textContent;
  const frameLabeled = (container: HTMLElement, label: string) =>
    projectFrames(container).find((f) => labelOf(f) === label)!;
  const titlesIn = (frame: HTMLElement) =>
    [...frame.querySelectorAll('[class*="sessionTabTitle"]')].map((el) => el.textContent);
  const terminalRequests = () => fetchMock.mock.calls.filter(([url]) => url === '/api/terminals');
  /** This device as the server's presence list reports it (the chips are offered only on the host machine). */
  const thisDevice = (isLocal: boolean): DevicePresence => ({
    clientId: getClientId(),
    label: isLocal ? 'Mac' : 'iPhone',
    address: isLocal ? '127.0.0.1' : '192.168.1.20',
    isLocal,
    connections: 1,
    connectedAt: 0,
    lastSeenAt: 0,
  });

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    usePresenceStore.setState({ devices: [thisDevice(true)] });
    useSessionStore.setState({ sessions: new Map() } as never);
    selectSession = vi.fn();
    useSessionStore.setState({ selectSession } as never);
    useUiStore.setState({
      activeModal: null, roomKillTargetId: null, sessionSortMode: 'project',
      navPosition: 'left', maximized: false, navRailCollapsed: false,
      selectedRoomIds: new Set(), recentRoomCollapsed: false, collapsedProjects: new Set(),
    });
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, terminalId: 'term-new' }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession } as never);
    usePresenceStore.setState({ devices: [] });
    vi.unstubAllGlobals();
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({
      navPosition: 'top', selectedRoomIds: new Set(), sessionSortMode: 'room', collapsedProjects: new Set(),
    });
  });

  describe('the frames', () => {
    it('draws one frame per project, alphabetical, each named for its project', () => {
      const { container } = renderProjects([kts, queueFloat, deploy]);
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager', 'api@build-box', 'kts']);
    });

    it("lists a project's sessions in its frame, trailing-slash spellings together", () => {
      const { container } = renderProjects([queueFloat, pinnedKill, kts]);
      expect(titlesIn(frameLabeled(container, 'agent-manager'))).toEqual(['Pinned kill', 'Queue float']);
      expect(titlesIn(frameLabeled(container, 'kts'))).toEqual(['KTS Agent']);
    });

    it('lists the current session like any other', () => {
      const { container } = renderProjects([queueFloat, kts]);
      const current = container.querySelector('[aria-current="true"]')!;
      expect(frameLabeled(container, 'agent-manager').contains(current)).toBe(true);
    });

    it('leaves a session with no project path as a plain card after the frames', () => {
      const { container } = renderProjects([queueFloat, loose]);
      const strip = container.querySelector('[class*="sessionTabStrip"]')!;
      const last = strip.lastElementChild as HTMLElement;
      expect(projectFrames(container)).toHaveLength(1);
      expect(last.matches('[class*="sessionTabCard"]')).toBe(true);
      expect(last.textContent).toContain('Loose end');
    });

    it('names each frame as a group for assistive technology', () => {
      renderProjects([queueFloat, kts]);
      expect(screen.getByRole('group', { name: 'Project agent-manager' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Project kts' })).toBeInTheDocument();
    });

    it("puts the full path in the frame's title, with the host when it is another machine", () => {
      const { container } = renderProjects([queueFloat, deploy]);
      expect(frameLabeled(container, 'agent-manager').getAttribute('title')).toBe('/w/agent-manager');
      expect(frameLabeled(container, 'api@build-box').getAttribute('title')).toBe('build-box:/srv/api');
    });

    it('gives neighbouring projects different colours', () => {
      const { container } = renderProjects([queueFloat, kts, deploy]);
      const colours = projectFrames(container).map((f) => f.style.getPropertyValue('--room-color'));
      expect(colours.every(Boolean)).toBe(true);
      expect(new Set(colours).size).toBe(colours.length);
    });

    it('is the same in the top bar', () => {
      useUiStore.setState({ navPosition: 'top' });
      const { container } = renderProjects([queueFloat, kts]);
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager', 'kts']);
    });

    // The strip skips regrouping while nothing it watches has changed, so these change ONLY the one
    // field under test: with projectName changing too, the strip would regroup for that reason alone.
    it('moves a session to its new project when only its directory changes', () => {
      const { container, update } = renderProjects([queueFloat, kts]);
      expect(titlesIn(frameLabeled(container, 'kts'))).toEqual(['KTS Agent']);
      update([queueFloat, { ...kts, projectPath: '/w/agent-manager' }]);
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager']);
      expect(titlesIn(frameLabeled(container, 'agent-manager')).sort()).toEqual(['KTS Agent', 'Queue float']);
    });

    it('moves a session to the other machine\'s frame when only its host changes', () => {
      const { container, update } = renderProjects([queueFloat, kts]);
      update([queueFloat, { ...kts, sshHost: 'build-box' }]);
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager', 'kts@build-box']);
      expect(titlesIn(frameLabeled(container, 'kts@build-box'))).toEqual(['KTS Agent']);
    });
  });

  describe('instead of rooms', () => {
    const rooms = [makeRoom({ id: 'room-1', name: 'SMS OPS', sessionIds: ['a1', 'k1'], roomIndex: 0 })];

    it('draws no room frames, whatever rooms exist', () => {
      const { container } = renderProjects([queueFloat, kts], rooms);
      expect(container.querySelector('[title="SMS OPS"]')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Move room/ })).toBeNull();
    });

    it('draws no RECENT frame — it says "also listed in its own room"', () => {
      const working = mk({ sessionId: 'a3', title: 'Busy', projectName: 'agent-manager', projectPath: '/w/agent-manager', status: 'working' });
      const { container } = renderProjects([working], rooms);
      expect(container.querySelector('[class*="recentRoomGroup"]')).toBeNull();
    });

    it('still narrows to the rooms picked in the room filter', () => {
      useUiStore.setState({ selectedRoomIds: new Set(['room-1']) });
      const { container } = renderProjects([queueFloat, kts, deploy], rooms);
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager', 'kts']);
    });
  });

  describe('folding a project', () => {
    it('hides its sessions behind a count, keeps the launch buttons, and remembers it', () => {
      const { container } = renderProjects([queueFloat, pinnedKill, kts]);
      const frame = frameLabeled(container, 'agent-manager');
      fireEvent.click(within(frame).getByRole('button', { name: 'Collapse project agent-manager' }));

      expect(useUiStore.getState().collapsedProjects.has('localhost|/w/agent-manager')).toBe(true);
      expect(titlesIn(frame)).toEqual([]);
      expect(frame.querySelector('[class*="roomCollapsedCount"]')?.textContent).toBe('2');
      expect(within(frame).getByRole('button', { name: 'New Claude session in agent-manager' })).toBeInTheDocument();
      expect(titlesIn(frameLabeled(container, 'kts'))).toEqual(['KTS Agent']); // the others stay open
    });

    it('unfolds again', () => {
      const { container } = renderProjects([queueFloat, kts]);
      const toggle = () => within(frameLabeled(container, 'agent-manager'));
      fireEvent.click(toggle().getByRole('button', { name: 'Collapse project agent-manager' }));
      fireEvent.click(toggle().getByRole('button', { name: 'Expand project agent-manager' }));
      expect(titlesIn(frameLabeled(container, 'agent-manager'))).toEqual(['Queue float']);
      expect(useUiStore.getState().collapsedProjects.size).toBe(0);
    });

    it('opens folded when it was left folded', () => {
      useUiStore.setState({ collapsedProjects: new Set(['localhost|/w/kts']) });
      const { container } = renderProjects([queueFloat, kts]);
      expect(titlesIn(frameLabeled(container, 'kts'))).toEqual([]);
      expect(titlesIn(frameLabeled(container, 'agent-manager'))).toEqual(['Queue float']);
    });
  });

  describe('quick launch', () => {
    it('offers Claude and Codex in every frame on this machine, and none on another', () => {
      const { container } = renderProjects([queueFloat, deploy]);
      const local = within(frameLabeled(container, 'agent-manager'));
      expect(local.getByRole('button', { name: 'New Claude session in agent-manager' })).toBeInTheDocument();
      expect(local.getByRole('button', { name: 'New Codex session in agent-manager' })).toBeInTheDocument();
      expect(within(frameLabeled(container, 'api@build-box')).queryByRole('button', { name: /^New / })).toBeNull();
    });

    it('asks the server for a NEW session of that CLI in that project, and selects it', async () => {
      const { container } = renderProjects([queueFloat, kts]);
      fireEvent.click(within(frameLabeled(container, 'kts')).getByRole('button', { name: 'New Codex session in kts' }));

      await vi.waitFor(() => expect(selectSession).toHaveBeenCalledWith('term-new'));
      // Only this feature's request: an earlier block's debounced queue push can land in the same stub.
      expect(terminalRequests()).toHaveLength(1);
      const [url, init] = terminalRequests()[0];
      expect(url).toBe('/api/terminals');
      expect(JSON.parse(String(init?.body))).toEqual({ workingDir: '/w/kts', command: 'codex', forceNew: true, requireExistingDir: true });
    });

    it('offers none to a phone: a session started from there is hidden from it, so each tap would start a PTY it cannot see', () => {
      usePresenceStore.setState({ devices: [thisDevice(false)] });
      const { container } = renderProjects([queueFloat, kts]);
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager', 'kts']); // the frames themselves are still there
      expect(screen.queryByRole('button', { name: /^New .* session in/ })).toBeNull();
    });

    it("launches in the path a session really used, as it stored it — not the tidied key the frame is grouped by", async () => {
      const { container } = renderProjects([pinnedKill]); // only the '/w/agent-manager/' session
      fireEvent.click(within(frameLabeled(container, 'agent-manager')).getByRole('button', { name: 'New Claude session in agent-manager' }));
      await vi.waitFor(() => expect(terminalRequests()).toHaveLength(1));
      expect(JSON.parse(String(terminalRequests()[0][1]?.body)).workingDir).toBe('/w/agent-manager/');
    });

    it('offers a folder the server would refuse (`site (old)`) as a disabled chip that says why, and sends nothing', () => {
      const awkward = mk({ sessionId: 'w1', title: 'Old site', projectName: 'site (old)', projectPath: '/w/site (old)' });
      const { container } = renderProjects([awkward]);
      const chip = within(frameLabeled(container, 'site (old)')).getByRole('button', { name: 'New Claude session in site (old)' });
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip.getAttribute('title')).toContain('( )');
      fireEvent.click(chip);
      expect(terminalRequests()).toHaveLength(0);
    });

    // The session the server starts has no room, and the strip under a room filter shows only sessions in the
    // selected rooms: before the new session joined its project's room it never appeared, the header switched to
    // it, and a user who thought the click had failed clicked again and started a second PTY.
    it('shows the session a chip started even with a room filter on', async () => {
      const ops = makeRoom({ id: 'room-ops', name: 'OPS', sessionIds: ['k1'], roomIndex: 0 });
      useUiStore.setState({ selectedRoomIds: new Set(['room-ops']) });
      const { container, update } = renderProjects([kts], [ops]);
      expect(titlesIn(frameLabeled(container, 'kts'))).toEqual(['KTS Agent']);

      fireEvent.click(within(frameLabeled(container, 'kts')).getByRole('button', { name: 'New Claude session in kts' }));
      await vi.waitFor(() => expect(selectSession).toHaveBeenCalledWith('term-new'));
      await vi.waitFor(() => expect(useRoomStore.getState().rooms[0].sessionIds).toContain('term-new'));

      // The card arrives over the WebSocket, with the project's path and no room of its own.
      const started = mk({ sessionId: 'term-new', title: 'Fresh one', projectName: 'kts', projectPath: '/w/kts', status: 'connecting' });
      act(() => update([kts, started]));
      expect(titlesIn(frameLabeled(container, 'kts')).sort()).toEqual(['Fresh one', 'KTS Agent']);
    });
  });

  describe('a frame is stable while the sessions in it change', () => {
    const colourOf = (frame: HTMLElement) => frame.style.getPropertyValue('--room-color');

    it('keeps its place and its colour when sessions with another name for the folder come and go', () => {
      // The server names a home-directory session "Home"; a card discovered from a process is named for the
      // folder. A label drawn from those names flipped, and the frame — sorted by it — jumped past its neighbour.
      const lz = mk({ sessionId: 'lz', title: 'LZ', projectName: 'lz', projectPath: '/Users/lz' });
      const me1 = mk({ sessionId: 'me1', title: 'Me 1', projectName: 'me', projectPath: '/Users/me' });
      const me2 = mk({ sessionId: 'me2', title: 'Me 2', projectName: 'me', projectPath: '/Users/me' });
      const { container, update } = renderProjects([lz, me1, me2]);
      const before = projectFrames(container).map((f) => [labelOf(f), colourOf(f)]);
      expect(before.map(([label]) => label)).toEqual(['lz', 'me']);

      const home1 = mk({ sessionId: 'h1', title: 'Home 1', projectName: 'Home', projectPath: '/Users/me' });
      const home2 = mk({ sessionId: 'h2', title: 'Home 2', projectName: 'Home', projectPath: '/Users/me' });
      act(() => update([lz, me1, me2, home1, home2]));

      expect(projectFrames(container).map((f) => [labelOf(f), colourOf(f)])).toEqual(before);
    });

    it('keeps a project\'s colour when the room filter hides the project it was colliding with', () => {
      // Two directories whose hashed colours collide: one of them is moved to the next free colour.
      const seen = new Map<number, string>();
      let pair: [string, string] | null = null;
      for (let n = 0; n < 200 && !pair; n++) {
        const path = `/w/project-${n}`;
        const colour = projectColorIndex(`localhost|${path}`, 8);
        const earlier = seen.get(colour);
        if (earlier) pair = [earlier, path];
        else seen.set(colour, path);
      }
      expect(pair).not.toBeNull();
      const [first, second] = [...pair!].sort((a, b) => (`localhost|${a}` < `localhost|${b}` ? -1 : 1));
      const sFirst = mk({ sessionId: 'f1', title: 'First', projectName: 'first', projectPath: first });
      const sSecond = mk({ sessionId: 's1', title: 'Second', projectName: 'second', projectPath: second });

      const { container, update } = renderProjects([sFirst, sSecond]);
      const unfiltered = colourOf(projectFrames(container).find((f) => f.getAttribute('title') === second)!);

      // A room that holds only the second project's session: the first is filtered out.
      useRoomStore.setState({ rooms: [makeRoom({ id: 'room-only-second', name: 'ONLY', sessionIds: ['s1'], roomIndex: 0 })] });
      act(() => useUiStore.setState({ selectedRoomIds: new Set(['room-only-second']) }));
      act(() => update([sFirst, sSecond]));

      const frames = projectFrames(container);
      expect(frames).toHaveLength(1);
      expect(colourOf(frames[0])).toBe(unfiltered);
    });
  });

  describe('switching views', () => {
    it('moves between rooms and projects from the header menu', () => {
      useUiStore.setState({ sessionSortMode: 'room' });
      const rooms = [makeRoom({ id: 'room-1', name: 'SMS OPS', sessionIds: ['a1'], roomIndex: 0 })];
      const { container } = renderProjects([queueFloat, kts], rooms);
      expect(container.querySelector('[title="SMS OPS"]')).not.toBeNull();
      expect(projectFrames(container)).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'Session view: Rooms' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Projects' }));
      expect(useUiStore.getState().sessionSortMode).toBe('project');
      expect(projectFrames(container).map(labelOf)).toEqual(['agent-manager', 'kts']);
      expect(container.querySelector('[title="SMS OPS"]')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Session view: Projects' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Rooms' }));
      expect(useUiStore.getState().sessionSortMode).toBe('room');
      expect(projectFrames(container)).toHaveLength(0);
      expect(container.querySelector('[title="SMS OPS"]')).not.toBeNull();
    });

    it('still reaches the flat recent-activity list', () => {
      const { container } = renderProjects([queueFloat, kts]);
      fireEvent.click(screen.getByRole('button', { name: 'Session view: Projects' }));
      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Recent activity' }));
      expect(useUiStore.getState().sessionSortMode).toBe('activity');
      expect(projectFrames(container)).toHaveLength(0);
      expect(container.querySelectorAll('[class*="sessionTabCard"]')).toHaveLength(2);
    });
  });
});


/**
 * Plan-usage chip — the CLI's plan limits at the top-left of the header. It is
 * the first child of the name row (before the status dot) and never part of the
 * meta row, whose icon count is fixed by the rail's width. See PlanUsageChip.tsx.
 */
describe('SessionSwitcher — plan usage chip', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: 's1',
    title: 'Queue float',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: 'idle',
    cliSource: 'claude',
    model: 'claude-opus-5-5',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  const usage = (over: Partial<PlanUsage> = {}): PlanUsage => ({
    cli: 'claude',
    windows: [{ minutes: 300, usedPercent: 63, resetsAt: Date.now() + 72 * 60_000 }],
    asOf: Date.now(),
    ...over,
  });

  const renderSwitcher = (session: Session) =>
    render(
      <SessionSwitcher
        currentSession={session}
        sessions={new Map([[session.sessionId, session]])}
        onSwitch={vi.fn()}
      />,
    );
  const nameRow = (container: HTMLElement) =>
    container.querySelector('[class*="switcherNameDisplay"]') as HTMLElement;
  const chips = (container: HTMLElement) => container.querySelectorAll('[class*="planUsageChip"]');

  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map() } as never);
    useUiStore.setState({
      activeModal: null, sessionSortMode: 'room', navPosition: 'top', maximized: false,
      navRailCollapsed: false, selectedRoomIds: new Set(),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useUiStore.setState({ navPosition: 'top', selectedRoomIds: new Set() });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is the first thing in the title row, before the status dot', () => {
    const { container } = renderSwitcher(makeSession({ planUsage: usage() }));
    const row = nameRow(container);
    expect(row.firstElementChild?.className).toMatch(/planUsageSlot/);
    expect(row.firstElementChild?.querySelector('[class*="planUsageChip"]')).toBeTruthy();
    expect(row.children[1].className).toMatch(/switcherDot/);
  });

  it('shows the figures a session carries', () => {
    renderSwitcher(makeSession({ planUsage: usage() }));
    const group = screen.getByRole('group', { name: /^Claude plan usage: 63% of the 5-hour limit used/ });
    expect(within(group).getByText('5h')).toBeInTheDocument();
    expect(within(group).getByText('63%')).toBeInTheDocument();
  });

  it('is there as a dash, with a reason, before any report has arrived', () => {
    renderSwitcher(makeSession());
    const group = screen.getByRole('group', { name: /^Claude plan usage unavailable:/ });
    expect(within(group).getByText('—')).toBeInTheDocument();
  });

  it('is absent for a session that is not Claude or Codex, and the dot leads the row', () => {
    const { container } = renderSwitcher(makeSession({ cliSource: undefined, model: '', startupCommand: 'zsh' }));
    expect(chips(container)).toHaveLength(0);
    expect(nameRow(container).firstElementChild?.className).toMatch(/switcherDot/);
  });

  it('is never in the meta row — its icon count is what the rail width is sized for', () => {
    const { container } = renderSwitcher(makeSession({ planUsage: usage() }));
    expect(container.querySelector('[class*="switcherMeta"] [class*="planUsageChip"]')).toBeNull();
    expect(chips(container)).toHaveLength(1);
  });

  it('is the same single chip, still first in the row, in the left rail', () => {
    useUiStore.setState({ navPosition: 'left' });
    const { container } = renderSwitcher(makeSession({ planUsage: usage() }));
    expect(container.querySelector('[class*="switcherBarVertical"]')).toBeTruthy();
    expect(chips(container)).toHaveLength(1);
    expect(nameRow(container).firstElementChild?.className).toMatch(/planUsageSlot/);
  });

  it('follows the session it is switched to', () => {
    const { container, rerender } = renderSwitcher(makeSession({ planUsage: usage() }));
    expect(chips(container)[0].getAttribute('data-cli')).toBe('claude');
    const codex = makeSession({ sessionId: 's2', cliSource: 'codex', model: 'gpt-5', title: 'KTS' });
    rerender(
      <SessionSwitcher currentSession={codex} sessions={new Map([[codex.sessionId, codex]])} onSwitch={vi.fn()} />,
    );
    expect(chips(container)).toHaveLength(1);
    expect(chips(container)[0].getAttribute('data-cli')).toBe('codex');
    expect(chips(container)[0].getAttribute('data-state')).toBe('empty');
  });
});

// App.tsx unmounts the top bar, and with it + NEW and DIRS, while a session
// panel is open. The strip carries both as icons, so starting a session never
// means minimizing the panel first.
describe('SessionSwitcher — start a session without leaving the panel', () => {
  const session = {
    sessionId: 's1',
    title: 'Zoe',
    projectName: 'nz-property-management-website',
    projectPath: '/Users/me/nz-property-management-website',
    status: 'waiting',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  } as Session;

  const renderSwitcher = () =>
    render(
      <SessionSwitcher
        currentSession={session}
        sessions={new Map([[session.sessionId, session]])}
        onSwitch={vi.fn()}
        onClose={vi.fn()}
      />,
    );

  beforeEach(() => {
    useUiStore.setState({ activeModal: null, workdirLauncherOpen: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ paths: [] }) }));
  });

  afterEach(() => {
    useUiStore.setState({ activeModal: null, workdirLauncherOpen: false });
    vi.unstubAllGlobals();
  });

  it('the + icon opens the new-session form', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
  });

  it('the folder icon opens the recent-directories menu', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Recent directories' }));
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
  });

  // A popped-out session window renders DetailPanel too, but not AppLayout,
  // so NewSessionModal is never mounted there: a + would set activeModal and
  // show nothing. The pair is the main window's.
  it('is absent from a popped-out session window', () => {
    const before = window.location.href;
    window.history.replaceState({}, '', '/?popout=session&sessionId=s1');
    try {
      renderSwitcher();
      expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Recent directories' })).toBeNull();
    } finally {
      window.history.replaceState({}, '', before);
    }
  });

  it('both are there in the left rail too', () => {
    const prev = useUiStore.getState().navPosition;
    useUiStore.setState({ navPosition: 'left' });
    try {
      const { container } = renderSwitcher();
      expect(container.querySelector('[class*="switcherBarVertical"]')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Recent directories' })).toBeInTheDocument();
    } finally {
      act(() => useUiStore.setState({ navPosition: prev }));
    }
  });
});
