/**
 * PhoneStack — draws the shown tab's stack of screens (AASC-39).
 *
 * Every screen of the stack stays mounted (a pop returns to the list where it
 * was scrolled); only the top one is visible and reachable, the others are
 * `inert` and hidden. A push slides the new screen in from the right, a pop
 * slides the old one out (250 ms, none under Reduce Motion), and on a pushed
 * screen the left-edge swipe drags the top screen away to pop it.
 *
 * The top screen's scroller is handed to the frame through screenSlot, for the
 * tab bar's scroll-to-top.
 *
 * Focus follows the stack (AASC-48): a pushed screen (or the next waiting session
 * swapped in) takes it, so a screen reader names the new screen; a pop gives it
 * back to what had it on the screen underneath (the row that opened it). Neither
 * scrolls. A first paint or a tab switch leaves it where it is.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ScreenSlotContext } from '../kit/screenSlot';
import RouteScreen from './RouteScreen';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { parsePhonePath } from '@/lib/chat/phoneRoutes';
import { useEdgeSwipeBack } from './useEdgeSwipeBack';
import styles from '@/styles/modules/mobile/PhoneStack.module.css';

export interface PhoneStackProps {
  stack: readonly string[];
  registerScroller: (el: HTMLElement | null) => void;
  onBack: () => void;
}

const noop = () => {};

function Slot({ path, slotId, index, isTop, isUnder, exiting, entering, registerScroller, onExited }: {
  path: string;
  slotId: string;
  index: number;
  isTop: boolean;
  isUnder: boolean;
  exiting: boolean;
  entering: boolean;
  registerScroller: (el: HTMLElement | null) => void;
  onExited: () => void;
}) {
  const slot = useMemo(
    () => ({ isTop, registerScroller: isTop ? registerScroller : noop }),
    [isTop, registerScroller],
  );
  return (
    <div
      className={styles.slot}
      data-top={isTop ? '' : undefined}
      data-under={isUnder ? '' : undefined}
      data-exiting={exiting ? '' : undefined}
      data-entering={entering ? '' : undefined}
      data-depth={index}
      data-path={path}
      data-slot={slotId}
      inert={!isTop}
      aria-hidden={isTop ? undefined : true}
      onAnimationEnd={exiting ? (e) => { if (e.target === e.currentTarget) onExited(); } : undefined}
    >
      <ScreenSlotContext.Provider value={slot}>
        <Suspense fallback={<div className={styles.loading} role="status">Loading…</div>}>
          <RouteScreen path={path} />
        </Suspense>
      </ScreenSlotContext.Provider>
    </div>
  );
}

/**
 * A screen's identity in the stack. A session keeps one instance across its
 * segments (a segment switch is a replace of the path, not a new screen: focus,
 * scroll and the selection survive it).
 */
function slotKey(index: number, path: string): string {
  const route = parsePhonePath(path);
  return route?.kind === 'session' ? `${index}:session:${route.sessionId}` : `${index}:${path}`;
}

/** How long an exit animation may take before the old screen is dropped anyway. */
const EXIT_FALLBACK_MS = 400;

/** The screen a push brings in, as a focus target: its section (named by its title), else its slot. */
function focusScreen(slot: HTMLElement): void {
  const target = slot.querySelector<HTMLElement>('section') ?? slot;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * Remembers what had focus on each screen of the stack, and moves focus when the
 * top screen changes: back to that element on a pop, into the new screen on a push.
 */
function useStackFocus(containerRef: RefObject<HTMLDivElement | null>, topSlot: string): void {
  const lastAction = usePhoneNavStore((s) => s.lastAction);
  const focused = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      const slot = target.closest<HTMLElement>('[data-slot]');
      if (slot?.dataset.slot) focused.current.set(slot.dataset.slot, target);
    };
    container.addEventListener('focusin', onFocusIn);
    return () => container.removeEventListener('focusin', onFocusIn);
  }, [containerRef]);
  useEffect(() => {
    if (lastAction === 'restore' || lastAction === 'switch') return;
    const top = containerRef.current?.querySelector<HTMLElement>(':scope > [data-top]');
    // Something on the new top screen took focus itself (a field that autofocuses).
    if (!top || top.contains(document.activeElement)) return;
    const before = lastAction === 'pop' ? focused.current.get(topSlot) : undefined;
    if (before?.isConnected && top.contains(before)) before.focus({ preventScroll: true });
    else focusScreen(top);
  }, [containerRef, topSlot, lastAction]);
}

export default function PhoneStack({ stack, registerScroller, onBack }: PhoneStackProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastAction = usePhoneNavStore((s) => s.lastAction);

  // A pop keeps the old top on screen while it slides out (state adjusted during
  // render when the stack shrinks, not in an effect).
  const [prevStack, setPrevStack] = useState(stack);
  const [exiting, setExiting] = useState<{ path: string; index: number } | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  // A pop the edge swipe finished: the screen has already slid away.
  const [swipedAway, setSwipedAway] = useState(false);
  if (prevStack !== stack) {
    setPrevStack(stack);
    const popped = stack.length < prevStack.length && stack.every((p, i) => prevStack[i] === p);
    setExiting(popped && lastAction === 'pop' && !swipedAway
      ? { path: prevStack[prevStack.length - 1], index: prevStack.length - 1 }
      : null);
    setEntering(lastAction === 'push' && stack.length > prevStack.length ? stack[stack.length - 1] : null);
    setSwipedAway(false);
  }

  useEffect(() => {
    if (!exiting) return;
    const t = setTimeout(() => setExiting(null), EXIT_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [exiting]);

  const clearExit = useCallback(() => setExiting(null), []);
  const swipeBack = useCallback(() => {
    setSwipedAway(true);
    onBack();
  }, [onBack]);
  useEdgeSwipeBack(containerRef, stack.length > 1, swipeBack);

  const topIndex = stack.length - 1;
  useStackFocus(containerRef, slotKey(topIndex, stack[topIndex]));
  // One keyed list, the leaving screen last: the same key keeps the same instance,
  // so a popped screen slides out as it was instead of mounting again.
  const slots = stack.map((path, index) => ({ path, index, leaving: false }));
  // (Unless the same screen was pushed straight back: then the new one is it.)
  if (exiting && (stack[exiting.index] === undefined || slotKey(exiting.index, stack[exiting.index]) !== slotKey(exiting.index, exiting.path))) {
    slots.push({ ...exiting, leaving: true });
  }
  return (
    <div ref={containerRef} className={styles.stack}>
      {slots.map(({ path, index, leaving }) => (
        <Slot
          key={slotKey(index, path)}
          slotId={slotKey(index, path)}
          path={path}
          index={index}
          isTop={!leaving && index === topIndex}
          isUnder={!leaving && index === topIndex - 1}
          exiting={leaving}
          entering={!leaving && index === topIndex && entering === path}
          registerScroller={registerScroller}
          onExited={clearExit}
        />
      ))}
    </div>
  );
}
