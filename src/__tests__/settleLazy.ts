/**
 * settleLazy — let the React.lazy boundaries rendered so far resolve (AASC-31).
 *
 * The phone's screens are `lazy()` imports, so right after `render()` they are not
 * there yet. To find one, `await screen.findBy…`. To assert that something is
 * ABSENT, first settle: otherwise the assertion passes before the phone component
 * has even loaded, and would keep passing if it drew the very thing it must not.
 *
 * Awaits the given modules (the same ones the boundaries load), then one macrotask
 * so every resolved boundary has been pinged, all inside act() so React commits the
 * retry. Real timers only: under fake timers the macrotask never comes.
 */
import { act } from '@testing-library/react';

export async function settleLazy(...modules: Array<() => Promise<unknown>>): Promise<void> {
  await act(async () => {
    await Promise.all(modules.map((load) => load()));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
