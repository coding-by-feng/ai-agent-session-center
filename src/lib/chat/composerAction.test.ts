// composerAction.test.ts — what the phone composer's main button does (AASC-42):
// Send when the agent can take a prompt, Queue while it works (hold: Send now),
// "Deny and tell Claude" while a card waits, nothing while another device drives.
import { describe, it, expect } from 'vitest';
import type { DevicePresence } from '@/types';
import { composerAction, macWindowOpen, pickerSheetFor, pickerSheetForText, runningTool, type ComposerInput } from './composerAction';

function input(extra: Partial<ComposerInput> = {}): ComposerInput {
  return { status: 'waiting', cli: 'claude', hasContent: true, spectator: false, card: null, macWindowOpen: true, ...extra };
}

describe('composerAction', () => {
  it.each(['waiting', 'idle'])('sends at once when the agent is %s', (status) => {
    const d = composerAction(input({ status }));
    expect(d).toMatchObject({ action: 'send', label: 'Send', canSend: true, showStop: false, holdAction: null });
    expect(d.placeholder).toBe('Reply to Claude…');
  });

  it.each(['working', 'prompting'])('queues while the agent is %s, offers Stop, and Send now on a hold', (status) => {
    const d = composerAction(input({ status }));
    expect(d).toMatchObject({ action: 'queue', label: 'Queue', canSend: true, showStop: true, holdAction: 'send-now' });
    expect(d.queueNote).toBeUndefined();
  });

  it.each(['waiting', 'idle'])('queues behind prompts still waiting in the queue when the agent is %s; a hold sends it ahead', (status) => {
    const d = composerAction(input({ status, queueWaiting: 2 }));
    expect(d).toMatchObject({ action: 'queue', label: 'Queue', canSend: true, showStop: false, holdAction: 'send-ahead' });
    expect(d.placeholder).toBe('Queue a message for Claude…');
    expect(composerAction(input({ status, queueWaiting: 2, macWindowOpen: false })).queueNote).toBe('Sent when AASC is open on your Mac');
  });

  it('a waiting queue changes nothing while a card waits, the session is starting, or it ended', () => {
    expect(composerAction(input({ status: 'approval', card: { kind: 'permission' }, queueWaiting: 2 })).action).toBe('deny-and-tell');
    expect(composerAction(input({ status: 'connecting', queueWaiting: 2 })).action).toBe('send');
    expect(composerAction(input({ status: 'ended', queueWaiting: 2 })).canSend).toBe(false);
    expect(composerAction(input({ status: 'working', queueWaiting: 2 })).holdAction).toBe('send-now');
  });

  it('says a queued prompt waits for the Mac when no AASC window is open there', () => {
    expect(composerAction(input({ status: 'working', macWindowOpen: false })).queueNote).toBe('Sent when AASC is open on your Mac');
    expect(composerAction(input({ status: 'waiting', macWindowOpen: false })).queueNote).toBeUndefined();
  });

  it('while a permission card waits, sending denies it and tells Claude instead', () => {
    const d = composerAction(input({ status: 'approval', card: { kind: 'permission' } }));
    expect(d).toMatchObject({ action: 'deny-and-tell', label: 'Deny and tell Claude', canSend: true, holdAction: 'queue' });
    expect(d.placeholder).toBe('Tell Claude what to do instead…');
    expect(d.fieldDisabledReason).toBeUndefined();
  });

  it('uses Codex’s name for a Codex session', () => {
    expect(composerAction(input({ cli: 'codex', status: 'approval', card: { kind: 'permission' } })).label).toBe('Deny and tell Codex');
    expect(composerAction(input({ cli: 'codex' })).placeholder).toBe('Reply to Codex…');
  });

  it('while a question waits, sending answers it in your own words', () => {
    const d = composerAction(input({ status: 'input', card: { kind: 'question' } }));
    expect(d).toMatchObject({ action: 'deny-and-tell', label: 'Send answer' });
    expect(d.placeholder).toBe('Answer in your own words…');
  });

  it('keeps the box open but empty sends nothing', () => {
    expect(composerAction(input({ hasContent: false })).canSend).toBe(false);
    expect(composerAction(input({ hasContent: false })).fieldDisabledReason).toBeUndefined();
  });

  it('disables the box while another device drives, saying who', () => {
    const d = composerAction(input({ spectator: true, driverLabel: 'MacBook' }));
    expect(d.canSend).toBe(false);
    expect(d.fieldDisabledReason).toBe('MacBook is driving');
    expect(d.showStop).toBe(false);
  });

  it('cannot send to a session that is still starting, and says why', () => {
    const d = composerAction(input({ status: 'connecting' }));
    expect(d).toMatchObject({ action: 'send', canSend: false, blockedReason: 'The agent is still starting' });
  });

  it('cannot type into an ended session', () => {
    const d = composerAction(input({ status: 'ended' }));
    expect(d.canSend).toBe(false);
    expect(d.fieldDisabledReason).toBe('This session has ended');
  });

  it('says "the agent" when the CLI is unknown', () => {
    expect(composerAction(input({ cli: null })).placeholder).toBe('Message the agent…');
  });
});

describe('macWindowOpen', () => {
  const device = (clientId: string, isLocal: boolean): DevicePresence => ({
    clientId, label: clientId, address: '', isLocal, connections: 1, connectedAt: 1, lastSeenAt: 1,
  });

  it('is open while another device writes the workspace (the Mac’s window fires the queue)', () => {
    expect(macWindowOpen({ received: true, workspaceWriter: 'desk', devices: [device('desk', true)] }, 'phone')).toBe(true);
  });

  it('is closed when this phone is the only writer left, or nobody is', () => {
    expect(macWindowOpen({ received: true, workspaceWriter: 'phone', devices: [device('phone', false)] }, 'phone')).toBe(false);
    expect(macWindowOpen({ received: true, workspaceWriter: null, devices: [] }, 'phone')).toBe(false);
  });

  it('assumes open until presence has arrived (no false alarm on load)', () => {
    expect(macWindowOpen({ received: false, workspaceWriter: null, devices: [] }, 'phone')).toBe(true);
  });
});

describe('runningTool', () => {
  it('names the tool a working session is in the middle of', () => {
    expect(runningTool({ status: 'working', events: [{ type: 'PreToolUse', timestamp: 1, detail: 'Bash: npm test' }] })).toBe('Bash');
  });

  it('is null between tools, or when not working', () => {
    expect(runningTool({ status: 'working', events: [{ type: 'PostToolUse', timestamp: 1, detail: 'Bash' }] })).toBeNull();
    expect(runningTool({ status: 'waiting', events: [{ type: 'PreToolUse', timestamp: 1, detail: 'Bash' }] })).toBeNull();
    expect(runningTool({ status: 'working', events: [] })).toBeNull();
  });
});

describe('picker commands', () => {
  it('answers /model and Claude’s /effort with a sheet', () => {
    expect(pickerSheetFor({ name: 'model', kind: 'command', source: 'builtin', cli: 'claude' })).toBe('model');
    expect(pickerSheetFor({ name: 'effort', kind: 'command', source: 'builtin', cli: 'claude' })).toBe('effort');
    expect(pickerSheetFor({ name: 'model', kind: 'command', source: 'builtin', cli: 'codex' })).toBe('model');
  });

  it('leaves everything else to the box, Codex’s missing /effort and a user’s own /model skill included', () => {
    expect(pickerSheetFor({ name: 'effort', kind: 'command', source: 'builtin', cli: 'codex' })).toBeNull();
    expect(pickerSheetFor({ name: 'model', kind: 'skill', source: 'global', cli: 'claude' })).toBeNull();
    expect(pickerSheetFor({ name: 'clear', kind: 'command', source: 'builtin', cli: 'claude' })).toBeNull();
  });

  it('catches a bare /model or /effort typed into the box', () => {
    expect(pickerSheetForText('/model', 'claude')).toBe('model');
    expect(pickerSheetForText(' /effort ', 'claude')).toBe('effort');
    expect(pickerSheetForText('/effort', 'codex')).toBeNull();
    expect(pickerSheetForText('/model sonnet', 'claude')).toBeNull();
    expect(pickerSheetForText('use /model', 'claude')).toBeNull();
  });
});
