// test/respawnConfig.test.ts — the config a server-start respawn rebuilds for a saved terminal.
import { describe, it, expect } from 'vitest';
import { respawnTerminalConfig } from '../server/respawnConfig.js';

const base = {
  projectPath: '/Users/me/proj',
  sshConfig: { host: 'localhost', port: 22, username: 'me', authMethod: 'key' as const, workingDir: '/Users/me/proj', command: 'claude' },
};

describe('respawnTerminalConfig', () => {
  it('rebuilds the connection fields and leaves the launch to the caller', () => {
    expect(respawnTerminalConfig(base)).toEqual({
      host: 'localhost', port: 22, username: 'me', authMethod: 'key', privateKeyPath: undefined,
      workingDir: '/Users/me/proj', command: '',
    });
  });

  // AASC-54: a phone's session in a folder no agent had used must never have Claude's
  // "Yes, I trust this folder" prompt answered for it — not even after the server restarts.
  it('keeps a session that must answer its own trust prompt from being auto-confirmed after a restart', () => {
    expect(respawnTerminalConfig({ ...base, sshConfig: { ...base.sshConfig, autoConfirmTrust: false } })).toMatchObject({ autoConfirmTrust: false });
  });

  it('adds nothing when the session never opted out', () => {
    expect(respawnTerminalConfig(base)).not.toHaveProperty('autoConfirmTrust');
  });

  it('falls back to the project folder, then home', () => {
    expect(respawnTerminalConfig({ ...base, sshConfig: { ...base.sshConfig, workingDir: '' } }).workingDir).toBe('/Users/me/proj');
    expect(respawnTerminalConfig({ sshConfig: { host: '' } }).workingDir).toBe('~');
    expect(respawnTerminalConfig({ sshConfig: { host: '' } }).host).toBe('localhost');
  });
});
