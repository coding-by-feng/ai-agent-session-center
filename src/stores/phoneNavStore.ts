/**
 * phoneNavStore — the new phone frame's navigation (AASC-39): four tabs, one
 * stack of screens per tab (paths from lib/chat/phoneRoutes.ts), mirrored into
 * the browser history so the Android back button and reloads behave.
 *
 * ## History model
 *
 *   index 0          the root SENTINEL (same URL as the tab root)
 *   index 1          the shown tab's root
 *   index 2 … n      the shown tab's pushed screens
 *
 * The history is always exactly as deep as the SHOWN stack. `push` / `replace` /
 * `switchTab` / `openSession` change the store at once and write history to match
 * (`pushState` / `replaceState`, or `history.go(-k)` when the new stack is
 * shallower). `pop` / `popToRoot` change nothing themselves: they call
 * `history.go(-k)`, and the popstate that follows applies the pop, so the in-app
 * back chevron, the edge swipe and the Android back button share one path. Every
 * landing re-writes its entry, so an entry left over from another tab is fixed
 * the moment it is reached. While a history.go() is on its way, every action
 * waits for it to land and then runs in order: a double tap on back pops once,
 * and a push right after a pop lands after it instead of being cut off.
 *
 * Android has no bridge on Mac-served pages (AASC-17): its back button is the
 * WebView's own, which walks this history. Landing on the sentinel means "back at
 * a tab root": the frame warns ("Press back again to leave") and a second back
 * within LEAVE_WINDOW_MS leaves the Mac page; after the window the root entry is
 * pushed again so the next back warns again. Entries that aren't the frame's (the
 * classic layout's router, when "New design" was turned on mid-session) are
 * walked straight through on the way out.
 *
 * The tab and stacks persist in localStorage (`aasc.phoneNav`, paths only) and
 * the address bar carries the shown screen as `?m=<path>`; a reload or a link
 * restores both (initialPhoneNav).
 */
import { create } from 'zustand';
import { z } from 'zod';
import {
  PHONE_TABS,
  parsePhonePath,
  pathChain,
  phonePathFromSearch,
  renameSessionInPath,
  sessionPath,
  tabOfPath,
  tabRootPath,
  withPhonePath,
  type PhoneTab,
  type SessionSegment,
} from '@/lib/chat/phoneRoutes';

export type PhoneStacks = Record<PhoneTab, string[]>;

export interface PhoneNav {
  tab: PhoneTab;
  stacks: PhoneStacks;
}

/** What changed the stack last: the frame animates a push in and a pop out, nothing else. */
export type NavAction = 'restore' | 'push' | 'pop' | 'replace' | 'switch';

interface PhoneNavState extends PhoneNav {
  /** Back was pressed at a tab root; one more back within the window leaves the page. */
  leaveArmed: boolean;
  lastAction: NavAction;
  /** Push a screen onto the shown tab's stack. A path this frame can't draw is ignored. */
  push: (path: string) => void;
  /** Back one screen (through history; popstate applies it). No-op at a tab root. */
  pop: () => void;
  /** Swap the top screen in place: no new history entry (a segment switch, the next waiting session). */
  replace: (path: string) => void;
  /** Back to the shown tab's root in one history traversal. */
  popToRoot: () => void;
  /** Show another tab; each tab keeps its stack. */
  switchTab: (tab: PhoneTab) => void;
  /** Open a session from anywhere: the given tab (Sessions by default) shows [root, session]. */
  openSession: (sessionId: string, segment?: SessionSegment, tab?: PhoneTab) => void;
  /**
   * A session re-keyed (/clear, a resume: `replacesId`): every screen of it, on
   * every tab, follows the new id in place: same screens, same segment, no
   * history traversal. Only the shown entry is rewritten now; the others are
   * rewritten as they are reached (each landing writes its entry).
   */
  renameSession: (oldId: string, newId: string) => void;
}

export const PHONE_NAV_KEY = 'aasc.phoneNav';
export const LEAVE_WINDOW_MS = 2500;

export function defaultStacks(): PhoneStacks {
  return { sessions: ['/sessions'], inbox: ['/inbox'], queue: ['/queue'], more: ['/more'] };
}

export const usePhoneNavStore = create<PhoneNavState>((set, get) => ({
  tab: 'sessions',
  stacks: defaultStacks(),
  leaveArmed: false,
  lastAction: 'restore',

  push: (path) => {
    if (!parsePhonePath(path) || deferred(() => get().push(path))) return;
    const { tab, stacks } = get();
    showStack(tab, { ...stacks, [tab]: [...stacks[tab], path] }, 'push');
  },

  pop: () => {
    if (deferred(() => get().pop())) return;
    traverseBack(1);
  },

  popToRoot: () => {
    if (deferred(() => get().popToRoot())) return;
    traverseBack(Infinity);
  },

  replace: (path) => {
    if (!parsePhonePath(path) || deferred(() => get().replace(path))) return;
    const { tab, stacks } = get();
    showStack(tab, { ...stacks, [tab]: [...stacks[tab].slice(0, -1), path] }, 'replace');
  },

  switchTab: (tab) => {
    if (deferred(() => get().switchTab(tab))) return;
    if (tab === get().tab) return;
    showStack(tab, get().stacks, 'switch');
  },

  renameSession: (oldId, newId) => {
    if (oldId === newId || deferred(() => get().renameSession(oldId, newId))) return;
    const { tab, stacks } = get();
    const next = { ...stacks };
    let changed = false;
    for (const t of PHONE_TABS) {
      const renamed = stacks[t].map((p) => renameSessionInPath(p, oldId, newId));
      if (renamed.some((p, i) => p !== stacks[t][i])) {
        next[t] = renamed;
        changed = true;
      }
    }
    if (!changed) return;
    usePhoneNavStore.setState({ stacks: next, lastAction: 'replace' });
    const shown = next[tab];
    if (binding && shown !== stacks[tab] && binding.idx >= 1 && binding.idx <= shown.length) {
      writeEntry('replace', binding.idx, tab, shown[binding.idx - 1]);
    }
  },

  openSession: (sessionId, segment = 'chat', tab = 'sessions') => {
    const path = sessionPath(sessionId, segment);
    if (!parsePhonePath(path) || deferred(() => get().openSession(sessionId, segment, tab))) return;
    showStack(tab, { ...get().stacks, [tab]: [tabRootPath(tab), path] }, 'switch');
  },
}));

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const persistedSchema = z.object({
  tab: z.enum(PHONE_TABS),
  stacks: z.record(z.string(), z.unknown()),
});

/** A stack is trusted only whole: its tab's root, then screens this frame draws (no other root). */
function validStack(tab: PhoneTab, value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value[0] !== tabRootPath(tab)) return null;
  const ok = value.slice(1).every((p) => {
    const route = typeof p === 'string' ? parsePhonePath(p) : null;
    return !!route && route.kind !== 'tab-root';
  });
  return ok ? (value as string[]) : null;
}

/** The nav to open with: the `?m=` screen if any, the saved stacks otherwise (pure). */
export function initialPhoneNav(search: string, persisted: unknown): PhoneNav {
  const parsed = persistedSchema.safeParse(persisted);
  const stacks = defaultStacks();
  let tab: PhoneTab = 'sessions';
  if (parsed.success) {
    for (const t of PHONE_TABS) stacks[t] = validStack(t, parsed.data.stacks[t]) ?? stacks[t];
    tab = parsed.data.tab;
  }
  const linked = phonePathFromSearch(search);
  if (!linked) return { tab, stacks };
  const savedTop = stacks[tab][stacks[tab].length - 1];
  if (savedTop === linked) return { tab, stacks };
  const linkedTab = tabOfPath(linked);
  return { tab: linkedTab, stacks: { ...stacks, [linkedTab]: pathChain(linked) } };
}

function readPersisted(): unknown {
  try {
    const raw = localStorage.getItem(PHONE_NAV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writePersisted(nav: PhoneNav): void {
  try {
    localStorage.setItem(PHONE_NAV_KEY, JSON.stringify({ tab: nav.tab, stacks: nav.stacks }));
  } catch {
    /* storage unavailable: the frame opens on Sessions next time */
  }
}

// ---------------------------------------------------------------------------
// History binding
// ---------------------------------------------------------------------------

/** The slice of window.history + location the store needs (a fake in tests). */
export interface NavHistory {
  readonly state: unknown;
  pushState(state: unknown, url: string): void;
  replaceState(state: unknown, url: string): void;
  go(delta: number): void;
  /** Call `onPop` with the landed entry's state on every popstate; returns the unsubscribe. */
  subscribe(onPop: (state: unknown) => void): () => void;
  /** The page's full current URL (location.href), to build `?m=` addresses from. */
  currentUrl(): string;
}

interface EntryState {
  aascPhone: true;
  idx: number;
  tab: PhoneTab;
  path: string;
}

function isEntry(state: unknown): state is EntryState {
  const s = state as Partial<EntryState> | null;
  return !!s && s.aascPhone === true && typeof s.idx === 'number' && typeof s.path === 'string';
}

interface Binding {
  history: NavHistory;
  /** Where in our entries the browser is now (0 = sentinel). */
  idx: number;
  onLeaveAttempt: () => void;
  rearm: ReturnType<typeof setTimeout> | null;
  /** Actions that came while a traversal was on its way; they run once it lands. */
  queue: Array<() => void>;
}

let binding: Binding | null = null;

/**
 * A history.go() on its way: where it should land. Module-level, not on the
 * binding, so a frame re-installed meanwhile (StrictMode mounts twice) waits
 * for it instead of starting a second one.
 */
let inFlight: { target: number; timer: ReturnType<typeof setTimeout> } | null = null;

/** How long to wait for a popstate before assuming the traversal landed. */
export const PENDING_TIMEOUT_MS = 1000;

function writeEntry(mode: 'push' | 'replace', idx: number, tab: PhoneTab, path: string): void {
  if (!binding) return;
  const state: EntryState = { aascPhone: true, idx, tab, path };
  const url = withPhonePath(binding.history.currentUrl(), path);
  if (mode === 'push') binding.history.pushState(state, url);
  else binding.history.replaceState(state, url);
}

/** Run `action` now, or, while a traversal is on its way, once it has landed. True if deferred. */
function deferred(action: () => void): boolean {
  if (!binding || !inFlight) return false;
  binding.queue.push(action);
  return true;
}

function startTraversal(target: number, delta: number): void {
  if (!binding) return;
  if (inFlight) clearTimeout(inFlight.timer);
  // A popstate that never comes (a browser that coalesced it) must not freeze the queue.
  inFlight = { target, timer: setTimeout(() => settle(target), PENDING_TIMEOUT_MS) };
  binding.history.go(delta);
}

/** The traversal landed (or timed out): run what waited for it, in order. */
function settle(landedIdx: number): void {
  if (inFlight) clearTimeout(inFlight.timer);
  inFlight = null;
  if (!binding) return;
  binding.idx = landedIdx;
  const waiting = binding.queue;
  binding.queue = [];
  for (const action of waiting) action();
}

function clearLeave(): void {
  if (binding?.rearm) clearTimeout(binding.rearm);
  if (binding) binding.rearm = null;
  if (usePhoneNavStore.getState().leaveArmed) usePhoneNavStore.setState({ leaveArmed: false });
}

/** Make the history exactly as deep as `stack`, its entries naming the stack's screens. */
function writeHistory(tab: PhoneTab, stack: string[]): void {
  if (!binding) return;
  const from = binding.idx;
  const target = stack.length;
  if (from > target) {
    // The landing popstate rewrites the entry it reaches (onPopState).
    startTraversal(target, target - from);
    return;
  }
  if (from >= 1) writeEntry('replace', from, tab, stack[from - 1]);
  for (let i = from + 1; i <= target; i++) writeEntry('push', i, tab, stack[i - 1]);
  binding.idx = target;
}

function showStack(tab: PhoneTab, stacks: PhoneStacks, lastAction: NavAction): void {
  clearLeave();
  usePhoneNavStore.setState({ tab, stacks, lastAction });
  writeHistory(tab, stacks[tab]);
}

/** Go back `steps` screens (at most to the root): through history when bound, else directly. */
function traverseBack(steps: number): void {
  const { tab, stacks } = usePhoneNavStore.getState();
  const n = Math.min(stacks[tab].length - 1, steps);
  if (n <= 0) return;
  if (binding) {
    startTraversal(binding.idx - n, -n);
    return;
  }
  usePhoneNavStore.setState({ stacks: { ...stacks, [tab]: stacks[tab].slice(0, stacks[tab].length - n) }, lastAction: 'pop' });
}

/** Back at a tab root (the sentinel): warn, and give the next back a short window to leave. */
function landOnSentinel(): void {
  if (!binding) return;
  const { tab, stacks } = usePhoneNavStore.getState();
  const stack = stacks[tab];
  binding.idx = 0;
  usePhoneNavStore.setState({
    leaveArmed: true,
    ...(stack.length > 1 ? { stacks: { ...stacks, [tab]: stack.slice(0, 1) }, lastAction: 'pop' as const } : {}),
  });
  binding.onLeaveAttempt();
  if (binding.rearm) clearTimeout(binding.rearm);
  binding.rearm = setTimeout(() => {
    if (!binding) return;
    binding.rearm = null;
    usePhoneNavStore.setState({ leaveArmed: false });
    const now = usePhoneNavStore.getState();
    if (binding.idx === 0) writeHistory(now.tab, now.stacks[now.tab]);
  }, LEAVE_WINDOW_MS);
}

/**
 * An entry that isn't the frame's: the classic layout's router entries sit under
 * the sentinel when "New design" was turned on mid-session. Reached with leave
 * armed, the user is on the way out: keep going. Reached without (a jump past the
 * sentinel), this entry becomes the sentinel.
 */
function onForeignEntry(): void {
  if (!binding) return;
  if (usePhoneNavStore.getState().leaveArmed) {
    binding.history.go(-1);
    return;
  }
  const { tab, stacks } = usePhoneNavStore.getState();
  binding.idx = 0;
  writeEntry('replace', 0, tab, stacks[tab][0]);
  landOnSentinel();
}

function onPopState(state: unknown): void {
  if (!binding) return;
  if (!isEntry(state)) {
    onForeignEntry();
    if (inFlight) settle(0);
    return;
  }
  const { tab, stacks } = usePhoneNavStore.getState();
  const stack = stacks[tab];
  binding.idx = state.idx;

  if (state.idx === 0) {
    landOnSentinel();
  } else {
    clearLeave();
    if (state.idx < stack.length) {
      const next = stack.slice(0, state.idx);
      usePhoneNavStore.setState({ stacks: { ...stacks, [tab]: next }, lastAction: 'pop' });
      writeEntry('replace', state.idx, tab, next[next.length - 1]);
    } else if (state.idx === stack.length) {
      writeEntry('replace', state.idx, tab, stack[stack.length - 1]);
    } else if (state.idx === stack.length + 1 && state.tab === tab && parsePhonePath(state.path)) {
      // Forward (a desktop browser's button): the screen is still named in the entry.
      usePhoneNavStore.setState({ stacks: { ...stacks, [tab]: [...stack, state.path] }, lastAction: 'push' });
    } else {
      // Further forward than the stack can follow: walk back to where it is.
      startTraversal(stack.length, stack.length - state.idx);
      return;
    }
  }
  if (inFlight && state.idx <= inFlight.target) settle(state.idx);
}

export interface InstallOptions {
  history: NavHistory;
  /** Back was pressed at a tab root (show "Press back again to leave"). */
  onLeaveAttempt: () => void;
  /** The page's query string at load, for `?m=`. */
  search: string;
}

/**
 * Restore the nav (URL, then storage), take over the history and start saving.
 * One frame at a time; returns the uninstall.
 */
export function installPhoneNav({ history, onLeaveAttempt, search }: InstallOptions): () => void {
  const nav = initialPhoneNav(search, readPersisted());
  usePhoneNavStore.setState({ ...nav, leaveArmed: false, lastAction: 'restore' });
  const stack = nav.stacks[nav.tab];
  const current = history.state;

  binding = { history, idx: 0, onLeaveAttempt, rearm: null, queue: [] };
  if (inFlight) {
    // A traversal from a frame mounted a moment ago is still landing: its popstate fixes the entry.
    binding.idx = inFlight.target;
  } else if (isEntry(current) && current.idx >= 1) {
    // A reload on our own entry: the sentinel and the stack's entries are still under it.
    binding.idx = current.idx;
    writeHistory(nav.tab, stack);
  } else {
    writeEntry('replace', 0, nav.tab, stack[0]);
    writeHistory(nav.tab, stack);
  }

  const unsubscribeHistory = history.subscribe(onPopState);
  writePersisted(nav);
  const unsubscribeStore = usePhoneNavStore.subscribe((s, prev) => {
    if (s.tab !== prev.tab || s.stacks !== prev.stacks) writePersisted(s);
  });

  return () => {
    unsubscribeHistory();
    unsubscribeStore();
    if (binding?.rearm) clearTimeout(binding.rearm);
    binding = null;
    // A traversal in flight survives only an immediate re-install (StrictMode's
    // second mount, in the same task); a frame really gone forgets it.
    queueMicrotask(() => {
      if (binding || !inFlight) return;
      clearTimeout(inFlight.timer);
      inFlight = null;
    });
  };
}

/** The browser's history, for the frame. */
export function browserNavHistory(): NavHistory {
  return {
    get state() { return window.history.state; },
    pushState: (state, url) => window.history.pushState(state, '', url),
    replaceState: (state, url) => window.history.replaceState(state, '', url),
    go: (delta) => window.history.go(delta),
    subscribe: (onPop) => {
      const handler = (e: PopStateEvent) => onPop(e.state);
      window.addEventListener('popstate', handler);
      return () => window.removeEventListener('popstate', handler);
    },
    currentUrl: () => window.location.href,
  };
}
