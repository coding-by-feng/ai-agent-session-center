import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeModelOption } from '@/types/api';
import {
  STATIC_CLAUDE_MODELS,
  mergeClaudeModels,
  resetClaudeModelsForTests,
  useClaudeModels,
} from './claudeModels';

const row = (id: string, resolvedModel = id): ClaudeModelOption => ({ id, resolvedModel, displayName: id, description: '' });

/** A future CLI: Fable 5.3 behind the alias, a new tier, and an older pin. */
const CATALOG = [
  row('opus', 'claude-opus-5-5'),
  row('fable', 'claude-fable-5-3'),
  row('sonnet', 'claude-sonnet-5-5'),
  row('haiku', 'claude-haiku-5-5'),
  row('mythos', 'claude-mythos-5-2'),
  row('claude-fable-5-2'),
];

describe('mergeClaudeModels', () => {
  it('follows the CLI: aliases in its order, each alias pinnable at what it means today', () => {
    const merged = mergeClaudeModels(CATALOG);
    expect(merged.options.slice(0, 5)).toEqual(['opus', 'fable', 'sonnet', 'haiku', 'mythos']);
    expect(merged.options.slice(5, 11)).toEqual([
      'claude-opus-5-5', 'claude-fable-5-3', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-mythos-5-2', 'claude-fable-5-2',
    ]);
    expect(merged.aliasVersions).toMatchObject({ fable: 'claude-fable-5-3', mythos: 'claude-mythos-5-2' });
  });

  it('keeps older static pins after the CLI rows, each listed once', () => {
    const { options } = mergeClaudeModels(CATALOG);
    expect(options).toContain('claude-opus-4-8');
    expect(options.indexOf('claude-opus-4-8')).toBeGreaterThan(options.indexOf('claude-fable-5-2'));
    expect(new Set(options).size).toBe(options.length);
  });

  it('an empty list keeps the static one', () => {
    expect(mergeClaudeModels([])).toBe(STATIC_CLAUDE_MODELS);
  });

  it('the static fallback already says Fable 5.2', () => {
    expect(STATIC_CLAUDE_MODELS.aliasVersions.fable).toBe('claude-fable-5-2');
    expect(STATIC_CLAUDE_MODELS.options).toContain('claude-fable-5-2');
  });
});

describe('useClaudeModels', () => {
  afterEach(() => {
    resetClaudeModelsForTests();
    vi.unstubAllGlobals();
  });

  const serve = (body: unknown, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }));

  it('shows the static list at once, then the CLI list; one fetch for every picker', async () => {
    const fetchMock = serve({ models: CATALOG, refreshedAt: '', source: 'claude-cli', stale: false });
    vi.stubGlobal('fetch', fetchMock);
    const a = renderHook(() => useClaudeModels());
    const b = renderHook(() => useClaudeModels());
    expect(a.result.current).toBe(STATIC_CLAUDE_MODELS);
    await waitFor(() => expect(a.result.current.aliasVersions.fable).toBe('claude-fable-5-3'));
    expect(b.result.current.aliasVersions.fable).toBe('claude-fable-5-3');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/claude/models', { cache: 'no-store' });
  });

  it('does not fetch while inactive', () => {
    const fetchMock = serve({ models: CATALOG });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useClaudeModels(false));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the static list when the Mac cannot read it, and tries again next time', async () => {
    const failing = serve({ error: 'Claude model catalog unavailable' }, false);
    vi.stubGlobal('fetch', failing);
    const first = renderHook(() => useClaudeModels());
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(first.result.current).toBe(STATIC_CLAUDE_MODELS);
    first.unmount();

    const working = serve({ models: CATALOG });
    vi.stubGlobal('fetch', working);
    const second = renderHook(() => useClaudeModels());
    await waitFor(() => expect(second.result.current.aliasVersions.fable).toBe('claude-fable-5-3'));
  });
});
