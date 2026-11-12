// PhoneFileView.errors.test.tsx — Nov 5 2026: a file too large to open (413) showed Try again, which
// could never succeed. A refusal that a retry can't change offers none; one that might still does.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PhoneFileView from './PhoneFileView';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function renderAt(path: string) {
  render(
    <PhoneFileView projectPath="/Users/me/proj" path={path} fullscreen={false} onToggleFullscreen={() => {}} onOpenFile={() => {}} />,
  );
}

beforeAll(() => {
  class NoopObserver { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??= NoopObserver;
});

let status = 413;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'File too large' }, status)));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PhoneFileView — a failed read', () => {
  it('offers no Try again for a file too large to open', async () => {
    status = 413;
    renderAt('/big.pdf');
    expect(await screen.findByText('This file is too large to open')).toBeInTheDocument();
    expect(screen.getByText('Open it on the Mac.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('still offers Try again when the Mac answered with an error a retry may clear', async () => {
    status = 500;
    renderAt('/a.ts');
    expect(await screen.findByText('This file could not be opened')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
