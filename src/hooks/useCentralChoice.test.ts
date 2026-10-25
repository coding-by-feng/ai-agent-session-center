import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useCentralChoice } from './useCentralChoice';
import { useUiStore } from '@/stores/uiStore';

const show = (activeModal: string | null) => act(() => useUiStore.setState({ activeModal }));

describe('useCentralChoice', () => {
  beforeEach(() => {
    useUiStore.setState({ activeModal: null });
  });

  afterEach(() => {
    show(null);
  });

  it('starts as Off', () => {
    const { result } = renderHook(() => useCentralChoice('new-session'));
    expect(result.current[0]).toBe('off');
  });

  it('holds the choice while the modal stays open, through re-renders', () => {
    show('new-session');
    const { result, rerender } = renderHook(() => useCentralChoice('new-session'));

    act(() => result.current[1]('global'));
    rerender();
    act(() => result.current[1]('project'));
    rerender();

    expect(result.current[0]).toBe('project');
  });

  it('is Off again at the next opening: a central is made on purpose, never carried over', () => {
    const { result } = renderHook(() => useCentralChoice('new-session'));
    show('new-session');
    act(() => result.current[1]('global'));
    expect(result.current[0]).toBe('global');

    show(null);
    show('new-session');

    expect(result.current[0]).toBe('off');
  });

  it('is Off again when another dialog replaced the form and the form came back', () => {
    show('new-session');
    const { result } = renderHook(() => useCentralChoice('new-session'));
    act(() => result.current[1]('room'));

    show('kill-confirm');
    show('new-session');

    expect(result.current[0]).toBe('off');
  });

  it('is reset by its own modal opening only, never by another one', () => {
    const { result } = renderHook(() => useCentralChoice('quick-session'));
    show('quick-session');
    act(() => result.current[1]('global'));
    show(null);

    show('new-session');
    show(null);
    expect(result.current[0]).toBe('global');

    show('quick-session');
    expect(result.current[0]).toBe('off');
  });
});
