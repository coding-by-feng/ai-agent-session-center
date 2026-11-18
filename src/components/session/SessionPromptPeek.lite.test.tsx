// The peek's Summary button is Full-only (Nov 18 2026): Lite shows the peek without it.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import SessionPromptPeek from './SessionPromptPeek';
import type { Session } from '@/types';

describe('SessionPromptPeek in the Lite build', () => {
  it('lists the prompts and offers no Summary', () => {
    const session = { sessionId: 's1', title: 'Boss', projectName: 'p', status: 'idle', promptHistory: [{ text: 'build it', timestamp: Date.now() - 60_000 }] } as unknown as Session;
    render(<SessionPromptPeek session={session} />);
    expect(screen.getByRole('list', { name: 'Recent prompts' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
