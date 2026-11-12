import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceSummary } from '@/types/resources';
import { buildResourceShortcuts } from '@/lib/commandShortcuts';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import ResourceList from './ResourceList';
import { db } from '@/lib/db';

function res(over: Partial<ResourceSummary> & { id: string }): ResourceSummary {
  return {
    type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown', name: over.id,
    path: `~/.claude/skills/${over.id}`, fileCount: 1, bytes: 1, mtimeMs: 0,
    repo: { status: 'not-tracked' }, variantIds: [], findingCodes: [], ...over,
  } as ResourceSummary;
}

function renderList(resources: ResourceSummary[], onSelect = vi.fn()) {
  render(
    <ResourceList
      type="skill"
      resources={resources}
      selectedId={null}
      projectsById={new Map()}
      emptyMessage="none"
      scrollResetKey="k"
      shortcuts={buildResourceShortcuts(resources)}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe('ResourceList — skill notes', () => {
  beforeEach(async () => {
    localStorage.clear();
    await useSkillNotesStore.getState().flush();
    await Promise.all([db.skillNoteRecords.clear(), db.skillNoteOutbox.clear(), db.skillNoteSyncMeta.clear()]);
    await useSkillNotesStore.getState().useLocalNotes();
    expect(useSkillNotesStore.getState().ready).toBe(true);
  });

  it('puts a favourite toggle beside each skill row, not inside the row button', async () => {
    const user = userEvent.setup();
    const onSelect = renderList([res({ id: 'tdd' }), res({ id: 'plan' })]);
    const heart = screen.getByRole('button', { name: 'Favourite tdd' });
    expect(heart.parentElement?.closest('button')).toBeNull();
    expect(heart.closest('li')).not.toBeNull();
    await act(async () => {
      await user.click(heart);
      await useSkillNotesStore.getState().flush();
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(useSkillNotesStore.getState().notes['claude:tdd'].fav).toBe(true);
    expect(screen.getByRole('button', { name: 'Favourite tdd' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Favourite plan' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('shows a skill\'s tags and abbreviation on its row', () => {
    useSkillNotesStore.setState({
      notes: { 'claude:tdd': { fav: false, tags: ['review', 'workflow'], abbr: 'td' } },
    });
    renderList([res({ id: 'tdd' })]);
    const item = screen.getAllByRole('listitem')[0];
    expect(within(item).getByText('#review')).toBeTruthy();
    expect(within(item).getByText('#workflow')).toBeTruthy();
    expect(within(item).getByText('abbr td')).toBeTruthy();
  });

  it('offers no heart on types that cannot carry notes', () => {
    render(
      <ResourceList
        type="rule" resources={[res({ id: 'r1', type: 'rule' })]} selectedId={null} projectsById={new Map()}
        emptyMessage="none" scrollResetKey="k" shortcuts={buildResourceShortcuts([])} onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Favourite/ })).toBeNull();
  });

  it('shows who made a skill beside its origin, and nothing extra on your own', () => {
    renderList([
      res({ id: 'xlsx', origin: 'synced', publisher: { kind: 'anthropic', name: 'Anthropic' } }),
      res({ id: 'brainstorming', origin: 'plugin', pluginName: 'superpowers', publisher: { kind: 'third-party', name: 'Jesse Vincent' } }),
      res({ id: 'imagegen', agent: 'codex', origin: 'system', publisher: { kind: 'openai', name: 'OpenAI' } }),
      res({ id: 'rar' }),
    ]);
    const [xlsx, brainstorming, imagegen, rar] = screen.getAllByRole('listitem');
    expect(within(xlsx).getByText('synced')).toBeTruthy();
    expect(within(xlsx).getByText('Claude official')).toBeTruthy();
    expect(within(brainstorming).getByText('by Jesse Vincent')).toBeTruthy();
    expect(within(imagegen).getByText('Codex official')).toBeTruthy();
    expect(within(rar).queryByText(/official|^by /)).toBeNull();
  });
});
