// AgentCliSettings.test.tsx — Settings ▸ ADVANCED ▸ Agent CLIs on the desktop and Settings → Advanced
// on a phone (Oct 25 2026). fetch is stubbed: nothing reaches a server, and no CLI ever runs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { CliVersionInfo } from '@/types/cliVersions';
import { useCliVersionsStore } from '@/stores/cliVersionsStore';
import AgentCliSettings from './AgentCliSettings';
import AgentClisSection from '@/components/mobile/screens/AgentClisSection';

const info = (cli: 'claude' | 'codex', over: Partial<CliVersionInfo> = {}): CliVersionInfo => ({
  cli, installed: '1.0.0', latest: '1.0.0', updateAvailable: false, checkedAt: Date.now(), update: { state: 'idle' }, ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchMock = vi.fn();
beforeEach(() => {
  useCliVersionsStore.setState({ items: null, loading: false, error: null });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json(202, { success: true, data: { cli: 'codex', state: 'updating' } });
    return json(200, { success: true, data: [info('claude'), info('codex', { installed: '0.163.0', latest: '0.164.0', updateAvailable: true })] });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('AgentCliSettings (desktop)', () => {
  it('lists both CLIs and enables Update only where npm has a newer one', async () => {
    render(<AgentCliSettings />);
    expect(await screen.findByText('0.163.0 · 0.164.0 available')).toBeTruthy();
    expect(screen.getByText('1.0.0 · up to date')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Update Claude Code' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Update Codex' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts the update with one click and shows it running', async () => {
    render(<AgentCliSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update Codex' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/cli-versions/codex/update', { method: 'POST' }));
    expect(await screen.findByText('Updating from 0.163.0…')).toBeTruthy();
    // One at a time: the other CLI's button says why it waits.
    expect(screen.getByRole('button', { name: 'Update Claude Code' }).getAttribute('title')).toMatch(/Codex is updating/);
  });

  it('asks npm again on Check again', async () => {
    render(<AgentCliSettings />);
    await screen.findByText('1.0.0 · up to date');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/cli-versions?refresh=1', expect.anything()));
  });
});

describe('AgentClisSection (phone)', () => {
  it('confirms before updating, and only offers a CLI that has an update', async () => {
    render(<AgentClisSection />);
    const codex = await screen.findByRole('button', { name: /Update Codex/ });
    expect(screen.queryByRole('button', { name: /Update Claude Code/ })).toBeNull();
    fireEvent.click(codex);
    expect(await screen.findByText('Update Codex on your Mac?')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/cli-versions/codex/update', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/cli-versions/codex/update', { method: 'POST' }));
  });
});
