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
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScreenSlotContext } from '../kit/screenSlot';
import RouteScreen from './RouteScreen';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useEdgeSwipeBack } from './useEdgeSwipeBack';
import styles from '@/styles/modules/mobile/PhoneStack.module.css';

export interface PhoneStackProps {
  stack: readonly string[];
  registerScroller: (el: HTMLElement | null) => void;
  onBack: () => void;
}

const noop = () => {};

function Slot({ path, index, isTop, isUnder, exiting, entering, registerScroller, onExited }: {
  path: string;
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
      inert={!isTop}
      aria-hidden={isTop ? undefined : true}
      onAnimationEnd={exiting ? onExited : undefined}
    >
      <ScreenSlotContext.Provider value={slot}>
        <Suspense fallback={<div className={styles.loading} role="status">Loading…</div>}>
          <RouteScreen path={path} />
        </Suspense>
      </ScreenSlotContext.Provider>
    </div>
  );
}

/** How long an exit animation may take before the old screen is dropped anyway. */
const EXIT_FALLBACK_MS = 400;

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
  // One keyed list, the leaving screen last: the same key keeps the same instance,
  // so a popped screen slides out as it was instead of mounting again.
  const slots = stack.map((path, index) => ({ path, index, leaving: false }));
  // (Unless the same screen was pushed straight back: then the new one is it.)
  if (exiting && stack[exiting.index] !== exiting.path) slots.push({ ...exiting, leaving: true });
  return (
    <div ref={containerRef} className={styles.stack}>
      {slots.map(({ path, index, leaving }) => (
        <Slot
          key={`${index}:${path}`}
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
