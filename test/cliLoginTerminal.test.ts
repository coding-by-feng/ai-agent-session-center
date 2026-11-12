// test/cliLoginTerminal.test.ts — which login line a caller gets. No terminal is opened here.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../server/sshManager.js', () => ({ createTerminal: vi.fn(), getTerminals: vi.fn(() => []), writeWhenReady: vi.fn() }));
vi.mock('../server/sessionStore.js', () => ({ createTerminalSession: vi.fn() }));

const { loginLineFor } = await import('../server/cliLoginTerminal.js');

describe('loginLineFor', () => {
  it('always runs claude auth login for Claude', () => {
    for (const isLocal of [true, false]) {
      for (const headless of [true, false]) expect(loginLineFor('claude', { isLocal, headless })).toBe('claude auth login');
    }
  });

  it('opens the browser login for Codex only on this machine, with a screen', () => {
    expect(loginLineFor('codex', { isLocal: true, headless: false })).toBe('codex login');
  });

  it('uses the device code for Codex from another device or on a headless server', () => {
    expect(loginLineFor('codex', { isLocal: false, headless: false })).toBe('codex login --device-auth');
    expect(loginLineFor('codex', { isLocal: true, headless: true })).toBe('codex login --device-auth');
  });
});
