import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CloudReview from './CloudReview';
import type { PublicationPlan } from '@/types/cloudResources';
const publish: PublicationPlan = {
  id: 'plan',
  items: [],
  blocked: [{ catalogId: 'settings', reason: 'Unsupported settings' }],
};
describe('Cloud review', () => {
  it('save_review_shows_blocked_count and never counts unsupported as publishable', () => {
    render(<CloudReview publication={publish} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("0 resources ready to save · 1 can't be saved")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save 0 resources to cloud' })).toBeDisabled();
  });
  it('names a blocked item by its local resource name, not its catalog id', () => {
    render(
      <CloudReview
        publication={publish}
        resourceName={(id) => (id === 'settings' ? 'Local settings' : undefined)}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Local settings: Unsupported settings')).toBeInTheDocument();
  });
});

it('mixed ready and blocked: saves the ready one and lists what is left out', () => {
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
  expect(screen.getByText("1 resource ready to save · 1 can't be saved")).toBeInTheDocument();
  expect(screen.getByText('settings: Unsupported settings')).toBeInTheDocument();
  expect(screen.getByText(/Claude skill · new/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save 1 resource to cloud' }));
  expect(confirm).toHaveBeenCalled();
});
it('memory waits for its OK before it can be saved', () => {
  const confirm = vi.fn();
  render(
    <CloudReview
      publication={{
        id: 'plan',
        blocked: [],
        items: [
          {
            catalogId: 'memory',
            sourceDigest: 'a'.repeat(64),
            baseVersion: 2,
            manifest: {
              resourceId: 'id',
              agent: 'codex',
              kind: 'memory',
              name: 'notes',
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
  const save = screen.getByRole('button', { name: 'Save 1 resource to cloud' });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByLabelText('OK to save the memory files listed here to the cloud.'));
  expect(save).toBeEnabled();
});
