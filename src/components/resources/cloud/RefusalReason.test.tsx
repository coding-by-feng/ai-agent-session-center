// RefusalReason.test.tsx — a refusal's reason, then its detail lines (Oct 26 2026).
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RefusalReason from './RefusalReason';
import CloudReview from './CloudReview';
import type { PublicationPlan } from '@/types/cloudResources';

describe('RefusalReason', () => {
  it('shows a one-line reason as it is', () => {
    const { container } = render(<p><RefusalReason reason="Package contains a symbolic link." /></p>);
    expect(container.textContent).toBe('Package contains a symbolic link.');
  });

  it('puts each detail line of a secret refusal on its own line', () => {
    const reason = 'Possible secret detected in the resource. Remove it before copying.\nSKILL.md · line 61: done | sort -u ****** /tmp/drift.tsv\n+2 more';
    const publication: PublicationPlan = { id: '00000000-0000-4000-8000-000000000000', items: [], blocked: [{ catalogId: 'c1', reason }] };
    render(<CloudReview publication={publication} onConfirm={() => {}} onClose={() => {}} resourceName={() => 'align-existing-feature-docs'} />);
    expect(screen.getByText('SKILL.md · line 61: done | sort -u ****** /tmp/drift.tsv')).toBeInTheDocument();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    expect(screen.getByText(/align-existing-feature-docs: Possible secret detected/)).toBeInTheDocument();
  });
});
