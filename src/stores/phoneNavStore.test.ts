// phoneNavStore.test.ts — the new phone frame's navigation (AASC-39): one stack per
// tab, every push a history entry, every pop a history.back() that popstate applies,
// a root sentinel so the first back at a tab root warns instead of leaving the page,
// and the last tab and stack restored on reopen (from ?m= or storage).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LEAVE_WINDOW_MS,
  PENDING_TIMEOUT_MS,
  PHONE_NAV_KEY,
  handleSystemBack,
  initialPhoneNav,
  installPhoneNav,
  usePhoneNavStore,
  type NavHistory,
} from './phoneNavStore';
import { openBackLayer } from '@/lib/backLayers';

/** A browser history: entries, an index, popstate delivered on flush() (browsers deliver it later). */
class FakeHistory implements NavHistory {
  entries: Array<{ state: unknown; url: string }>;
  index = 0;
  left = false;
  private pending: number[] = [];
  private listeners = new Set<(state: unknown) => void>();

  constructor(url = '/', state: unknown = null) {
    this.entries = [{ state: null, url: '/shell' }, { state, url }];
    this.index = 1;
  }
  get state() { return this.entries[this.index].state; }
  get url() { return this.entries[this.index].url; }
  currentUrl() { return `http://mac:3333${this.url}`; }
  pushState(state: unknown, url: string) {
    this.entries = [...this.entries.slice(0, this.index + 1), { state, url }];
    this.index += 1;
  }
  replaceState(state: unknown, url: string) {
    this.entries = this.entries.map((e, i) => (i === this.index ? { state, url } : e));
  }
  go(delta: number) { this.pending.push(delta); }
  subscribe(onPop: (state: unknown) => void) {
    this.listeners.add(onPop);
    return () => { this.listeners.delete(onPop); };
  }
  /** The browser getting round to the queued traversals. */
  flush() {
    while (this.pending.length > 0) {
      const delta = this.pending.shift()!;
      const next = this.index + delta;
      if (next < 1) { this.left = true; this.index = 0; continue; } // off the Mac page
      if (next >= this.entries.length) continue;
      this.index = next;
      for (const l of this.listeners) l(this.state);
    }
  }
  /** The Android back button. */
  back() { this.go(-1); this.flush(); }
}

const nav = () => usePhoneNavStore.getState();
const stack = () => nav().stacks[nav().tab];

let history: FakeHistory;
let onLeaveAttempt: ReturnType<typeof vi.fn<() => void>>;
let uninstall: () => void;

function install(url = '/', state: unknown = null) {
  history = new FakeHistory(url, state);
  onLeaveAttempt = vi.fn<() => void>();
  uninstall = installPhoneNav({ history, onLeaveAttempt, search: new URL(`http://mac${url}`).search });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  uninstall?.();
  vi.useRealTimers();
});

describe('installing', () => {
  it('starts on Sessions with a sentinel entry under the tab root', () => {
    install();
    expect(nav().tab).toBe('sessions');
    expect(stack()).toEqual(['/sessions']);
    expect(history.entries.slice(2)).toHaveLength(1);
    expect(history.url).toBe('/?m=/sessions');
    // The entry under the root is the sentinel the first back lands on.
    expect(history.entries[1].state).toMatchObject({ idx: 0 });
  });

  it('restores a ?m= link with its parent screens under it', () => {
    install('/?m=/more/gallery');
    expect(nav().tab).toBe('more');
    // The UI kit sits under This phone since About folded into it (Oct 20 2026).
    expect(stack()).toEqual(['/more', '/more/phone', '/more/gallery']);
    expect(history.url).toBe('/?m=/more/gallery');
    history.back();
    expect(stack()).toEqual(['/more', '/more/phone']);
  });
});

describe('push and pop', () => {
  it('pushes a history entry per screen and pops through history.back()', () => {
    install();
    nav().push('/sessions/s1/chat');
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
    expect(history.url).toBe('/?m=/sessions/s1/chat');

    nav().pop();
    // Nothing changes until the browser delivers the popstate.
    expect(stack()).toHaveLength(2);
    history.flush();
    expect(stack()).toEqual(['/sessions']);
    expect(history.url).toBe('/?m=/sessions');
  });

  it('pops on the hardware back button the same way', () => {
    install();
    nav().push('/sessions/s1/chat');
    history.back();
    expect(stack()).toEqual(['/sessions']);
  });

  it('ignores a pop at a tab root', () => {
    install();
    nav().pop();
    history.flush();
    expect(stack()).toEqual(['/sessions']);
    expect(onLeaveAttempt).not.toHaveBeenCalled();
  });

  it('refuses a path it cannot draw', () => {
    install();
    nav().push('/nope');
    expect(stack()).toEqual(['/sessions']);
  });

  it('replaces the top screen in place (a segment switch, the next waiting session)', () => {
    install();
    nav().push('/sessions/s1/chat');
    const entries = history.entries.length;
    nav().replace('/sessions/s1/terminal');
    expect(stack()).toEqual(['/sessions', '/sessions/s1/terminal']);
    expect(history.entries).toHaveLength(entries);
    expect(history.url).toBe('/?m=/sessions/s1/terminal');
    history.back();
    expect(stack()).toEqual(['/sessions']);
  });

  it('pops to the root in one traversal', () => {
    install('/?m=/more/gallery');
    nav().popToRoot();
    history.flush();
    expect(stack()).toEqual(['/more']);
    expect(history.url).toBe('/?m=/more');
  });
});

describe('tabs', () => {
  it('keeps each tab its own stack', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().switchTab('more');
    expect(stack()).toEqual(['/more']);
    history.flush(); // a shallower tab walks history back first
    nav().push('/more/history');
    nav().switchTab('sessions');
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
    nav().switchTab('more');
    expect(stack()).toEqual(['/more', '/more/history']);
  });

  it('keeps the history as deep as the shown stack, so back pops the shown tab', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().switchTab('inbox');
    history.flush(); // the switch to a shallower stack walks history back
    expect(history.url).toBe('/?m=/inbox');
    nav().switchTab('more');
    nav().push('/more/about');
    nav().push('/more/gallery');
    history.back();
    expect(stack()).toEqual(['/more', '/more/about']);
    nav().switchTab('sessions');
    expect(history.url).toBe('/?m=/sessions/s1/chat');
    history.back();
    expect(nav().tab).toBe('sessions');
    expect(stack()).toEqual(['/sessions']);
  });

  it('opens a session on the Sessions tab from anywhere', () => {
    install();
    nav().switchTab('more');
    nav().push('/more/history');
    nav().openSession('s9', 'terminal');
    history.flush();
    expect(nav().tab).toBe('sessions');
    // The terminal is pushed over the chat (AASC-56): Back returns to Chat, then the list.
    expect(stack()).toEqual(['/sessions', '/sessions/s9/chat', '/sessions/s9/terminal']);
    expect(history.url).toBe('/?m=/sessions/s9/terminal');
    history.back();
    expect(stack()).toEqual(['/sessions', '/sessions/s9/chat']);
    history.back();
    expect(stack()).toEqual(['/sessions']);
  });

  it('opens a shell’s terminal as its own segment, nothing under it', () => {
    install();
    nav().openSession('s9', 'terminal', 'sessions', false);
    history.flush();
    expect(stack()).toEqual(['/sessions', '/sessions/s9/terminal']);
  });
});

describe('the terminal and the Project segment (AASC-56)', () => {
  it('pushes the terminal over Chat, and Back returns to Chat', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().openTerminal('s1');
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat', '/sessions/s1/terminal']);
    expect(history.url).toBe('/?m=/sessions/s1/terminal');
    expect(nav().lastAction).toBe('push');
    history.back();
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
    expect(history.url).toBe('/?m=/sessions/s1/chat');
  });

  it('opened from Project, puts Chat under the terminal', () => {
    install();
    nav().push('/sessions/s1/project');
    nav().openTerminal('s1');
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat', '/sessions/s1/terminal']);
    history.back();
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
  });

  it('switches a shell to its Terminal segment in place', () => {
    install();
    nav().push('/sessions/s1/project');
    const depth = history.entries.length;
    nav().openTerminal('s1', false);
    expect(stack()).toEqual(['/sessions', '/sessions/s1/terminal']);
    expect(history.entries.length).toBe(depth);
  });

  it('Info → Files: back to the session screen, on Project, in one traversal', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().push('/sessions/s1/info');
    nav().showSegment('s1', 'project');
    history.flush();
    expect(stack()).toEqual(['/sessions', '/sessions/s1/project']);
    expect(history.url).toBe('/?m=/sessions/s1/project');
    history.back();
    expect(stack()).toEqual(['/sessions']);
  });

  it('pops several screens at once (a shell’s Back past a chat path under its terminal)', () => {
    install('/?m=/sessions/s1/terminal');
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat', '/sessions/s1/terminal']);
    nav().popScreens(2);
    history.flush();
    expect(stack()).toEqual(['/sessions']);
  });
});

describe('the root sentinel (Android back at a tab root)', () => {
  it('warns on the first back instead of leaving the Mac page', () => {
    install();
    history.back();
    expect(onLeaveAttempt).toHaveBeenCalledTimes(1);
    expect(nav().leaveArmed).toBe(true);
    expect(stack()).toEqual(['/sessions']);
    expect(history.left).toBe(false);
  });

  it('leaves on a second back within the window', () => {
    install();
    history.back();
    history.back();
    expect(history.left).toBe(true);
  });

  it('re-arms itself when the window passes', () => {
    vi.useFakeTimers();
    install();
    history.back();
    vi.advanceTimersByTime(LEAVE_WINDOW_MS + 10);
    expect(nav().leaveArmed).toBe(false);
    history.back();
    expect(onLeaveAttempt).toHaveBeenCalledTimes(2);
    expect(history.left).toBe(false);
  });

  it('carries on normally after a push from the sentinel', () => {
    install();
    history.back();
    nav().push('/sessions/s1/chat');
    expect(nav().leaveArmed).toBe(false);
    expect(history.url).toBe('/?m=/sessions/s1/chat');
    history.back();
    expect(stack()).toEqual(['/sessions']);
    history.back();
    expect(onLeaveAttempt).toHaveBeenCalledTimes(2);
  });
});

describe('a sheet or menu open on top (AASC-48)', () => {
  const releases: Array<() => void> = [];
  const layer = (close: () => void) => { releases.push(openBackLayer(close)); };
  afterEach(() => { while (releases.length) releases.pop()!(); });

  it('the system back closes it, and the screen under it stays', () => {
    install('/');
    nav().push('/sessions/s1/chat');
    const close = vi.fn();
    layer(close);
    history.back();
    expect(close).toHaveBeenCalledTimes(1);
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
    // The entry the back used is back: the next back pops the screen.
    history.back();
    expect(stack()).toEqual(['/sessions']);
  });

  it('at a tab root it closes the sheet instead of warning', () => {
    install('/');
    const close = vi.fn();
    layer(close);
    history.back();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onLeaveAttempt).not.toHaveBeenCalled();
    expect(nav().leaveArmed).toBe(false);
  });

  it('closes only the top one of two', () => {
    install('/');
    nav().push('/sessions/s1/chat');
    const under = vi.fn();
    const top = vi.fn();
    layer(under);
    layer(top);
    history.back();
    expect(top).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it('never swallows the app’s own back (a sheet action that pops the screen)', () => {
    install('/');
    nav().push('/sessions/s1/chat');
    const close = vi.fn();
    layer(close);
    nav().pop();
    history.flush();
    expect(close).not.toHaveBeenCalled();
    expect(stack()).toEqual(['/sessions']);
  });
});

describe('the app’s back button, asked by the native shell (AASC-48)', () => {
  // Android's WebView skips history entries a page added without a tap, so the
  // button can't be left to walk the history: MainActivity asks the page instead.
  it('pops a pushed screen', () => {
    install('/');
    nav().push('/sessions/s1/chat');
    expect(handleSystemBack()).toBe('handled');
    history.flush();
    expect(stack()).toEqual(['/sessions']);
  });

  it('closes an open sheet first', () => {
    install('/');
    nav().push('/sessions/s1/chat');
    const close = vi.fn();
    const release = openBackLayer(close);
    expect(handleSystemBack()).toBe('handled');
    expect(close).toHaveBeenCalledTimes(1);
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
    release();
  });

  it('at a tab root warns once, then says leave within the window', () => {
    install('/');
    expect(handleSystemBack()).toBe('handled');
    expect(onLeaveAttempt).toHaveBeenCalledTimes(1);
    expect(nav().leaveArmed).toBe(true);
    expect(handleSystemBack()).toBe('leave');
    expect(nav().leaveArmed).toBe(false);
  });

  it('warns again once the window has passed', () => {
    vi.useFakeTimers();
    install('/');
    handleSystemBack();
    vi.advanceTimersByTime(LEAVE_WINDOW_MS + 10);
    expect(nav().leaveArmed).toBe(false);
    expect(handleSystemBack()).toBe('handled');
    expect(onLeaveAttempt).toHaveBeenCalledTimes(2);
  });
});

describe('restoring on reopen', () => {
  it('saves the tab and stacks as they change', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().switchTab('more');
    const saved = JSON.parse(localStorage.getItem(PHONE_NAV_KEY) ?? 'null');
    expect(saved.tab).toBe('more');
    expect(saved.stacks.sessions).toEqual(['/sessions', '/sessions/s1/chat']);
  });

  it('reopens the last tab and stack', () => {
    const persisted = { tab: 'inbox', stacks: { sessions: ['/sessions'], inbox: ['/inbox', '/sessions/s2/chat'], queue: ['/queue'], more: ['/more'] } };
    expect(initialPhoneNav('', persisted)).toEqual(persisted);
  });

  it('prefers the URL, but keeps the saved stack when it ends on the same screen', () => {
    const persisted = { tab: 'inbox', stacks: { sessions: ['/sessions'], inbox: ['/inbox', '/sessions/s2/chat'], queue: ['/queue'], more: ['/more'] } };
    expect(initialPhoneNav('?m=/sessions/s2/chat', persisted).tab).toBe('inbox');
    const fromLink = initialPhoneNav('?m=/queue', persisted);
    expect(fromLink.tab).toBe('queue');
    expect(fromLink.stacks.inbox).toEqual(['/inbox', '/sessions/s2/chat']);
  });

  it('drops a saved stack it cannot trust', () => {
    const bad = { tab: 'sessions', stacks: { sessions: ['/inbox', '/sessions/x/chat'], inbox: 'no', queue: ['/queue', '/nope'], more: [] } };
    expect(initialPhoneNav('', bad)).toEqual({
      tab: 'sessions',
      stacks: { sessions: ['/sessions'], inbox: ['/inbox'], queue: ['/queue'], more: ['/more'] },
    });
    expect(initialPhoneNav('', 'garbage').tab).toBe('sessions');
  });

  it('adopts its own history entry after a reload instead of stacking a second sentinel', () => {
    install('/?m=/sessions/s1/chat', { aascPhone: true, idx: 2, tab: 'sessions', path: '/sessions/s1/chat' });
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
    expect(history.entries).toHaveLength(2);
  });
});

describe('taps that arrive before the browser has traversed', () => {
  it('a double tap on back pops one screen, not off the stack', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().pop();
    nav().pop();
    history.flush();
    expect(stack()).toEqual(['/sessions']);
    expect(onLeaveAttempt).not.toHaveBeenCalled();
    expect(nav().leaveArmed).toBe(false);
  });

  it('a double tap on the active tab pops to the root once and stays on the page', () => {
    install('/?m=/more/gallery');
    nav().popToRoot();
    nav().popToRoot();
    history.flush();
    expect(stack()).toEqual(['/more']);
    expect(history.left).toBe(false);
  });

  it('a push made while a pop is on its way lands after it', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().pop();
    nav().push('/sessions/s2/chat');
    history.flush();
    expect(stack()).toEqual(['/sessions', '/sessions/s2/chat']);
    expect(history.url).toBe('/?m=/sessions/s2/chat');
    history.back();
    expect(stack()).toEqual(['/sessions']);
  });

  it('a push right after switching to a shallower tab lands on that tab', () => {
    install();
    nav().push('/sessions/s1/chat');
    nav().switchTab('more');
    nav().push('/more/about');
    history.flush();
    expect(nav().tab).toBe('more');
    expect(stack()).toEqual(['/more', '/more/about']);
    expect(history.url).toBe('/?m=/more/about');
  });

  it('a pop right after opening a session from a deep stack pops that session', () => {
    install('/?m=/more/gallery');
    nav().openSession('s9');
    nav().pop();
    history.flush();
    expect(nav().tab).toBe('sessions');
    expect(stack()).toEqual(['/sessions']);
    expect(onLeaveAttempt).not.toHaveBeenCalled();
  });

  it('gives up waiting for a traversal that never comes', () => {
    vi.useFakeTimers();
    install();
    nav().push('/sessions/s1/chat');
    nav().pop(); // the browser never answers
    nav().push('/sessions/s2/chat');
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS + 10);
    expect(stack()[stack().length - 1]).toBe('/sessions/s2/chat');
  });
});

describe('entries that are not the frame’s', () => {
  it('keeps leaving through the classic layout’s entries under the sentinel', () => {
    history = new FakeHistory('/history', { usr: null, key: 'b', idx: 1 });
    history.entries = [{ state: null, url: '/shell' }, { state: { usr: null, key: 'a', idx: 0 }, url: '/' }, history.entries[1]];
    history.index = 2;
    onLeaveAttempt = vi.fn<() => void>();
    uninstall = installPhoneNav({ history, onLeaveAttempt, search: '' });
    history.back(); // the sentinel: warn
    expect(onLeaveAttempt).toHaveBeenCalledTimes(1);
    history.back(); // a router entry: carry on out
    expect(history.left).toBe(true);
  });

  it('treats a foreign entry reached without a warning as the sentinel', () => {
    history = new FakeHistory('/history', { usr: null, key: 'b', idx: 1 });
    history.entries = [{ state: null, url: '/shell' }, { state: { usr: null, key: 'a', idx: 0 }, url: '/' }, history.entries[1]];
    history.index = 2;
    onLeaveAttempt = vi.fn<() => void>();
    uninstall = installPhoneNav({ history, onLeaveAttempt, search: '' });
    history.go(-2); // straight past the sentinel (a long-press on a browser's back)
    history.flush();
    expect(onLeaveAttempt).toHaveBeenCalledTimes(1);
    expect(history.state).toMatchObject({ aascPhone: true, idx: 0 });
  });

  it('adopts its own entry after a reload even when the restored stack is shallower', () => {
    const own = (idx: number, path: string) => ({ aascPhone: true, idx, tab: 'sessions', path });
    history = new FakeHistory('/?m=/sessions', own(2, '/sessions/s1/chat'));
    history.entries = [{ state: null, url: '/shell' }, { state: own(0, '/sessions'), url: '/?m=/sessions' }, { state: own(1, '/sessions'), url: '/?m=/sessions' }, history.entries[1]];
    history.index = 3;
    onLeaveAttempt = vi.fn<() => void>();
    uninstall = installPhoneNav({ history, onLeaveAttempt, search: '' }); // storage empty: the default stack, length 1
    history.flush(); // walks back to the root entry
    expect(history.index).toBe(2);
    history.back(); // the original sentinel
    expect(onLeaveAttempt).toHaveBeenCalledTimes(1);
    history.back();
    expect(history.left).toBe(true);
  });
});

describe('a session re-keyed (/clear, a resume)', () => {
  it('follows it on every stack, in place: same screens, same segment, no history traversal', () => {
    install('/?m=/sessions/old-1/changes');
    nav().push('/sessions/old-1/info');
    nav().push('/sessions/old-1/info/notes');
    usePhoneNavStore.setState({ stacks: { ...nav().stacks, inbox: ['/inbox', '/sessions/old-1/chat'], queue: ['/queue', '/sessions/other/chat'] } });
    const depth = history.entries.length;
    const go = vi.spyOn(history, 'go');

    nav().renameSession('old-1', 'new-1');

    expect(nav().stacks.sessions).toEqual(['/sessions', '/sessions/new-1/changes', '/sessions/new-1/info', '/sessions/new-1/info/notes']);
    expect(nav().stacks.inbox).toEqual(['/inbox', '/sessions/new-1/chat']);
    expect(nav().stacks.queue).toEqual(['/queue', '/sessions/other/chat']);
    expect(go).not.toHaveBeenCalled();
    expect(history.entries.length).toBe(depth);
    expect(history.url).toBe('/?m=/sessions/new-1/info/notes');
    expect(nav().lastAction).toBe('replace');

    // Back still walks the screens, now under the new id.
    history.back();
    expect(stack()).toEqual(['/sessions', '/sessions/new-1/changes', '/sessions/new-1/info']);
    expect(history.url).toBe('/?m=/sessions/new-1/info');
  });

  it('changes nothing when no screen shows the session', () => {
    install('/?m=/sessions/s1/chat');
    const before = nav().stacks;
    nav().renameSession('gone', 'new');
    expect(nav().stacks).toBe(before);
  });
});
