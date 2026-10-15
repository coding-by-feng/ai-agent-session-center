import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CloudReview from './CloudReview';
import type { InstallPlan, PublicationPlan } from '@/types/cloudResources';
const publish: PublicationPlan = {
  id: 'plan',
  items: [],
  blocked: [{ catalogId: 'settings', reason: 'Unsupported settings' }],
};
describe('Cloud review', () => {
  it('save_review_shows_blocked_count and never counts unsupported as publishable', () => {
    render(<CloudReview publication={publish} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('0 ready · 1 blocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish reviewed resources' })).toBeDisabled();
  });
  it('requires explicit replacement decision and displays file comparison', () => {
    const confirm = vi.fn();
    const plan: InstallPlan = {
      id: 'plan',
      items: [
        {
          id: 'item',
          resourceId: 'resource',
          version: 2,
          destinationLabel: '~/.claude/skills/example',
          action: 'replace',
          files: [{ path: 'example/SKILL.md', change: 'change' }],
        },
      ],
    };
    render(<CloudReview install={plan} onConfirm={confirm} onClose={vi.fn()} />);
    const run = screen.getByRole('button', { name: 'Install reviewed resources' });
    expect(run).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Decision for ~/.claude/skills/example'), {
      target: { value: 'replace-with-backup' },
    });
    fireEvent.click(run);
    expect(confirm).toHaveBeenCalledWith({ item: 'replace-with-backup' });
    expect(screen.getByText(/example\/SKILL.md/)).toBeInTheDocument();
  });
});

it('mixed ready and blocked publication remains disabled', () => {
  const confirm = vi.fn();
  render(
    <CloudReview
      publication={{
        ...publish,
        items: [
          {
            catalogId: 'ready',
            sourceDigest: 'a'.repeat(64),
            baseVersion: null,
            manifest: {
              resourceId: 'id',
              agent: 'claude',
              kind: 'skill',
              name: 'Ready',
              scope: 'global',
              projectId: null,
              files: [],
              dependencies: [],
            },
          },
        ],
      }}
      onConfirm={confirm}
      onClose={vi.fn()}
    />,
  );
  const button = screen.getByRole('button', { name: 'Publish reviewed resources' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(confirm).not.toHaveBeenCalled();
});
