import { describe, it, expect } from 'vitest';
import { agentVoiceKind, isLoopbackHost } from './agentVoice';

const base = { cli: 'claude' as const, pageHost: 'localhost', sshHost: null, isPhone: false };

describe('agentVoiceKind', () => {
  it('Claude holds to talk, Codex toggles /voice', () => {
    expect(agentVoiceKind(base)).toBe('hold');
    expect(agentVoiceKind({ ...base, cli: 'codex' })).toBe('toggle');
  });

  it('no button for a shell or an unknown CLI', () => {
    expect(agentVoiceKind({ ...base, cli: null })).toBeNull();
  });

  it('only where the CLI records from this machine', () => {
    expect(agentVoiceKind({ ...base, isPhone: true })).toBeNull();
    expect(agentVoiceKind({ ...base, pageHost: '192.168.4.20' })).toBeNull();
    expect(agentVoiceKind({ ...base, pageHost: '100.64.1.2' })).toBeNull();
    expect(agentVoiceKind({ ...base, sshHost: 'build-box' })).toBeNull();
    expect(agentVoiceKind({ ...base, sshHost: 'localhost' })).toBe('hold');
    expect(agentVoiceKind({ ...base, pageHost: '127.0.0.1' })).toBe('hold');
  });
});

describe('isLoopbackHost', () => {
  it('accepts loopback names only', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', 'LOCALHOST']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['', null, undefined, '10.0.0.1', 'localhost.evil.com']) expect(isLoopbackHost(h)).toBe(false);
  });
});
