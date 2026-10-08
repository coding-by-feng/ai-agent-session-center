import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResourceSummary } from '@/types/resources';
import { resourceIsSelected, type ResourceSelection as Selection } from '@/types/resourceTransfers';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import ResourceSelection from './ResourceSelection';

function res(over: Partial<ResourceSummary> & { id: string }): ResourceSummary {
  return {
    type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown', name: over.id,
    path: `~/.claude/skills/${over.id}`, fileCount: 1, bytes: 1, mtimeMs: 0, hash: 'h',
    repo: { status: 'not-tracked' }, variantIds: [], findingCodes: [], ...over,
  } as ResourceSummary;
}

const RESOURCES = [
  res({ id: 'a', name: 'tdd' }),
  res({ id: 'b', name: 'plan' }),
  res({ id: 'c', name: 'deploy', agent: 'codex' }),
  res({ id: 'd', name: 'rule-x', type: 'rule' }),
];

const probe = { latest: [] as Selection };
function Harness() {
  const [selection, setSelection] = useState<Selection>([]);
  return (
    <ResourceSelection
      resources={RESOURCES}
      projects={[]}
      selection={selection}
      onChange={(next) => { probe.latest = next; setSelection(next); }}
    />
  );
}
const selectedIds = () => RESOURCES.filter((r) => resourceIsSelected(r, probe.latest)).map((r) => r.id);

describe('ResourceSelection — by my notes', () => {
  beforeEach(() => {
    probe.latest = [];
    useSkillNotesStore.setState({
      notes: {
        'claude:tdd': { fav: true, tags: ['review'] },
        'claude:plan': { fav: false, tags: ['review', 'ops'] },
        'codex:deploy': { fav: true, tags: ['ops'] },
      },
    });
  });

  it('selects every favourite with one tick, and shows a count', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByRole('checkbox', { name: 'Favourites (0/2)' });
    await user.click(box);
    expect(selectedIds()).toEqual(['a', 'c']);
    expect(screen.getByRole('checkbox', { name: 'Favourites (2/2)' })).toBeChecked();
  });

  it('selects by one tag, and several tags add up', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'Tag review (0/2)' }));
    expect(selectedIds()).toEqual(['a', 'b']);
    await user.click(screen.getByRole('checkbox', { name: 'Tag ops (1/2)' }));
    expect(selectedIds()).toEqual(['a', 'b', 'c']);
  });

  it('unticking removes only that group\'s items', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('checkbox', { name: 'Tag review (0/2)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Favourites (1/2)' }));
    expect(selectedIds()).toEqual(['a', 'b', 'c']);
    await user.click(screen.getByRole('checkbox', { name: /^Favourites/ }));
    expect(selectedIds()).toEqual(['b']);
  });

  it('follows the agent filter', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText('Agent selection'), 'codex');
    expect(screen.getByRole('checkbox', { name: 'Favourites (0/1)' })).toBeInTheDocument();
  });

  it('says it selects what is marked now, not what is marked later', () => {
    render(<Harness />);
    expect(screen.getByText(/the items marked now/i)).toBeInTheDocument();
  });

  it('shows no branch when nothing is marked', () => {
    useSkillNotesStore.setState({ notes: {} });
    render(<Harness />);
    expect(screen.queryByText(/By my notes/)).toBeNull();
  });
});
