// useQueueStripCollapsed.test.tsx — whether the docked queue strip is folded. Full keeps one stored flag. Lite goes by
// what the session's queue holds until a click, and never writes the flag, which Full reads on the same port.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const edition = vi.hoisted(() => ({ lite: false }));
vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  get IS_LITE() { return edition.lite; },
}));

import { useQueueStripCollapsed } from './useQueueStripCollapsed';
import { useQueueStore } from '@/stores/queueStore';
import type { QueueItem } from '@/stores/queueStore';
import { useUiStore } from '@/stores/uiStore';

function queue(sessionId: string, items: number): void {
  const queued = Array.from({ length: items }, (_, id) => ({ id }) as unknown as QueueItem);
  useQueueStore.setState({ queues: new Map([[sessionId, queued]]) });
}

describe('useQueueStripCollapsed', () => {
  beforeEach(() => {
    useQueueStore.setState({ queues: new Map(), composeDrafts: new Map() });
    useUiStore.setState({ queuePanelCollapsed: false, queueStripChoice: null });
  });

  describe('in Full', () => {
    beforeEach(() => { edition.lite = false; });

    it('follows the stored flag whatever the queue holds', () => {
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      expect(result.current[0]).toBe(false);
      act(() => result.current[1](true));
      expect(result.current[0]).toBe(true);
      expect(useUiStore.getState().queuePanelCollapsed).toBe(true);
    });
  });

  describe('in Lite', () => {
    beforeEach(() => { edition.lite = true; });

    it('is one line while the queue is empty, and opens when prompts arrive', () => {
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      expect(result.current[0]).toBe(true);
      act(() => queue('s1', 1));
      expect(result.current[0]).toBe(false);
      act(() => queue('s1', 0));
      expect(result.current[0]).toBe(true);
    });

    it('stays open while a prompt is being typed, even as the last queued one sends', () => {
      queue('s1', 1);
      useQueueStore.getState().setComposeDraft('s1', { text: 'half a thought' });
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => queue('s1', 0));
      expect(result.current[0]).toBe(false);
    });

    it('stays open for a draft with only an image in it', () => {
      queue('s1', 1);
      useQueueStore.getState().setComposeDraft('s1', { images: [{ name: 'a.png' }] as never });
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => queue('s1', 0));
      expect(result.current[0]).toBe(false);
    });

    describe('with the cursor in the compose box', () => {
      const composeBox = (sessionId: string): HTMLTextAreaElement => {
        const wrapper = document.body.appendChild(document.createElement('div'));
        wrapper.setAttribute('data-queue-compose', sessionId);
        const box = wrapper.appendChild(document.createElement('textarea'));
        box.focus();
        return box;
      };
      afterEach(() => { document.body.innerHTML = ''; });

      it('stays open when the last prompt sends, so the box can\'t vanish between two prompts', () => {
        queue('s1', 1);
        composeBox('s1');
        const { result } = renderHook(() => useQueueStripCollapsed('s1'));
        act(() => queue('s1', 0));
        expect(result.current[0]).toBe(false);
        expect(useUiStore.getState().queuePanelCollapsed).toBe(false);
      });

      it('holds with two readers of the hook, as DetailPanel and QueueTab both are', () => {
        queue('s1', 1);
        composeBox('s1');
        const useTwoReaders = () => [useQueueStripCollapsed('s1')[0], useQueueStripCollapsed('s1')[0]];
        const { result } = renderHook(useTwoReaders);
        act(() => queue('s1', 0));
        expect(result.current).toEqual([false, false]);
      });

      it('replaces a fold made while prompts were queued', () => {
        queue('s1', 2);
        composeBox('s1');
        const { result } = renderHook(() => useQueueStripCollapsed('s1'));
        act(() => result.current[1](true));
        act(() => queue('s1', 0));
        expect(result.current[0]).toBe(false);
      });

      it('can still be folded by hand afterwards', () => {
        queue('s1', 1);
        composeBox('s1');
        const { result } = renderHook(() => useQueueStripCollapsed('s1'));
        act(() => queue('s1', 0));
        act(() => result.current[1](true));
        expect(result.current[0]).toBe(true);
      });

      it('folds as usual once the cursor has left', () => {
        queue('s1', 1);
        composeBox('s1').blur();
        const { result } = renderHook(() => useQueueStripCollapsed('s1'));
        act(() => queue('s1', 0));
        expect(result.current[0]).toBe(true);
      });

      it('is not held by another session\'s box', () => {
        queue('s1', 1);
        composeBox('s2');
        const { result } = renderHook(() => useQueueStripCollapsed('s1'));
        act(() => queue('s1', 0));
        expect(result.current[0]).toBe(true);
      });
    });

    it('ignores the flag Full stored', () => {
      useUiStore.setState({ queuePanelCollapsed: true });
      queue('s1', 1);
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      expect(result.current[0]).toBe(false);
    });

    it('follows a click, without writing the flag Full reads', () => {
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => result.current[1](false));
      expect(result.current[0]).toBe(false);
      expect(useUiStore.getState().queuePanelCollapsed).toBe(false);

      act(() => queue('s1', 1));
      act(() => result.current[1](true));
      expect(result.current[0]).toBe(true);
      expect(useUiStore.getState().queuePanelCollapsed).toBe(false);
    });

    it('keeps a strip opened by hand open while a prompt is typed and deleted', () => {
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => result.current[1](false));
      act(() => useQueueStore.getState().setComposeDraft('s1', { text: 'a' }));
      act(() => useQueueStore.getState().setComposeDraft('s1', { text: '' }));
      expect(result.current[0]).toBe(false);
    });

    it('opens for the next prompts after being folded by hand', () => {
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => result.current[1](false));
      act(() => result.current[1](true));
      act(() => queue('s1', 1));
      expect(result.current[0]).toBe(false);
    });

    it('forgets a fold once the queue empties, so it can\'t hide later prompts', () => {
      queue('s1', 2);
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => result.current[1](true));
      act(() => queue('s1', 3));
      expect(result.current[0]).toBe(true);

      act(() => queue('s1', 0));
      expect(useUiStore.getState().queueStripChoice).toBeNull();
      act(() => queue('s1', 1));
      expect(result.current[0]).toBe(false);
    });

    it('folds again when the last prompt sends, even after being opened by hand', () => {
      const { result } = renderHook(() => useQueueStripCollapsed('s1'));
      act(() => result.current[1](false));
      act(() => queue('s1', 1));
      act(() => queue('s1', 0));
      expect(result.current[0]).toBe(true);
    });

    it('keeps a click to its own session', () => {
      const { result, rerender } = renderHook(({ id }) => useQueueStripCollapsed(id), { initialProps: { id: 's1' } });
      act(() => result.current[1](false));
      expect(result.current[0]).toBe(false);
      rerender({ id: 's2' });
      expect(result.current[0]).toBe(true);
    });
  });
});
