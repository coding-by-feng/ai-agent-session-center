// phoneNavStore.test.ts — the new phone frame's navigation (AASC-39): one stack per
// tab, every push a history entry, every pop a history.back() that popstate applies,
// a root sentinel so the first back at a tab root warns instead of leaving the page,
// and the last tab and stack restored on reopen (from ?m= or storage).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LEAVE_WINDOW_MS,
  PHONE_NAV_KEY,
  initialPhoneNav,
  installPhoneNav,
  usePhoneNavStore,
  type NavHistory,
} from './phoneNavStore';

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
    expect(stack()).toEqual(['/more', '/more/about', '/more/gallery']);
    expect(history.url).toBe('/?m=/more/gallery');
    history.back();
    expect(stack()).toEqual(['/more', '/more/about']);
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
    expect(stack()).toEqual(['/sessions', '/sessions/s9/terminal']);
    expect(history.url).toBe('/?m=/sessions/s9/terminal');
    history.back();
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
