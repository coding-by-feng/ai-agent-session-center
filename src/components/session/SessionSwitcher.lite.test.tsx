// SessionSwitcher.lite.test.tsx — the session header in the Lite build: no model, context or plan-usage chips, and
// no detach button (a pop-out window is not on Lite's list).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => [] }));
vi.mock('./PlanUsageChip', () => ({ default: () => <div data-testid="plan-usage" /> }));

import SessionSwitcher from './SessionSwitcher';
import { useCentralFeatureStore } from '@/stores/centralFeatureStore';
import type { Session } from '@/types';

const session = {
  sessionId: 's1', title: 'Work', projectName: 'agent-manager', projectPath: '/Users/me/agent-manager',
  status: 'idle', startedAt: 1, lastActivityAt: 1, model: 'claude-opus-5-5', cliSource: 'claude',
  runtime: { model: 'Opus 5.5', modelAt: 1, effort: 'high', effortAt: 1 },
} as unknown as Session;

describe('SessionSwitcher in the Lite build', () => {
  beforeEach(() => {
    useCentralFeatureStore.setState({ on: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('electronAPI', { openSessionWindow: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = () => render(<SessionSwitcher currentSession={session} sessions={new Map([['s1', session]])} onSwitch={vi.fn()} model={session.model} />);

  it('hides the plan-usage and model chips', () => {
    const { container } = open();
    expect(screen.queryByTestId('plan-usage')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /^Model / })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/opus/i);
  });

  it('hides the detach button, even in the desktop app', () => {
    open();
    expect(screen.queryByRole('button', { name: /Detach session/ })).not.toBeInTheDocument();
  });

  it('keeps Kill, with its own button', () => {
    open();
    expect(screen.getByRole('button', { name: /Kill session/ })).toBeInTheDocument();
  });
});
