// ResourceCompare.test.tsx — what Compare shows when there is nothing to show.
//
// For an identical pair the `diff` library still emits its file header
// (`====`, `--- left`, `+++ right`) with no hunk after it. Rendering those
// three lines as a patch reads as "something differs but the diff is empty";
// the honest answer is "No differences."
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResourceCompare as CompareResult } from '@/types/resources';
import ResourceCompare from './ResourceCompare';

function stubCompare(data: CompareResult): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, data }),
    json: async () => ({ success: true, data }),
  })));
}

const SIDES = {
  left: { label: 'Live', path: '~/.claude/skills/tdd' },
  right: { label: 'agent-skills repo', path: '~/Documents/agent-skills/claude/skills/tdd' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResourceCompare', () => {
  it('says "No differences." for an identical pair whose patch is only the file header', async () => {
    stubCompare({
      ...SIDES,
      files: [{ path: 'SKILL.md', status: 'same' }],
      patch: '===================================================================\n--- ~/.claude/skills/tdd\n+++ ~/Documents/agent-skills/claude/skills/tdd\n',
    });
    const { container } = render(<ResourceCompare id="sk-claude-tdd" options={[{ value: 'repo', label: 'agent-skills repo' }]} />);

    expect(await screen.findByText('No differences.')).toBeInTheDocument();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('still renders the patch when it has a hunk', async () => {
    stubCompare({
      ...SIDES,
      files: [{ path: 'SKILL.md', status: 'changed' }],
      patch: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
    });
    const { container } = render(<ResourceCompare id="sk-claude-tdd" options={[{ value: 'repo', label: 'agent-skills repo' }]} />);

    await screen.findByText('+new');
    expect(container.querySelector('pre')).not.toBeNull();
    expect(screen.queryByText('No differences.')).toBeNull();
  });
});
