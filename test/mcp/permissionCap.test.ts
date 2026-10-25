// test/mcp/permissionCap.test.ts — the permission-mode cap (server/mcp/permissionCap.ts, Ruling P4-5): a central opens
// or relaunches nothing looser than its own card runs in. The card's mode is read, then what its stored command says.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { assertWithinCap, centralCap, effectiveModeOf, MODE_RANK } from '../../server/mcp/permissionCap.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { makeCentral, makeCtx, makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const cardOf = (central: CentralRecord, permissionMode: string | null): Session =>
  makeSession('card-1', {
    terminalId: central.terminalId,
    permissionMode,
    central: { centralId: central.centralId, kind: central.kind, scopeRef: central.scopeRef },
  });

const card = (over: Partial<Session>): Session => makeSession('w1', { terminalId: 'term-w1', ...over });

describe('effectiveModeOf', () => {
  it('effectiveModeOf reads the card first, then the stored command (each Claude and Codex flag above), else default', () => {
    expect(effectiveModeOf(card({ permissionMode: 'plan' }))).toBe('plan');
    expect(effectiveModeOf(card({ permissionMode: 'acceptEdits', startupCommand: 'claude' }))).toBe('acceptEdits');
    expect(effectiveModeOf(card({}))).toBe('default');
    expect(effectiveModeOf(card({ permissionMode: null, startupCommand: 'claude' }))).toBe('default');

    const fromCommand = (command: string): string => effectiveModeOf(card({ startupCommand: command }));
    expect(fromCommand('claude --permission-mode acceptEdits')).toBe('acceptEdits');
    expect(fromCommand('claude --permission-mode=plan')).toBe('plan');
    expect(fromCommand('claude --dangerously-skip-permissions')).toBe('bypassPermissions');
    expect(fromCommand('codex --dangerously-bypass-approvals-and-sandbox')).toBe('bypassPermissions');
    expect(fromCommand('codex --yolo')).toBe('bypassPermissions');
    expect(fromCommand('codex --sandbox danger-full-access')).toBe('bypassPermissions');
    expect(fromCommand('codex -a never')).toBe('bypassPermissions');
    expect(fromCommand('codex --ask-for-approval=never')).toBe('bypassPermissions');
    expect(fromCommand('codex -c approval_policy="never"')).toBe('bypassPermissions');
    expect(fromCommand('codex --full-auto')).toBe('acceptEdits');
    expect(fromCommand('codex')).toBe('default');
    // The SSH card's command is read the same way.
    expect(effectiveModeOf(card({ sshConfig: { host: 'h', port: 22, command: 'claude --dangerously-skip-permissions' } }))).toBe(
      'bypassPermissions',
    );
  });

  it('an unknown card mode or --permission-mode value is kept as it is and ranks loosest (A-M1)', () => {
    const central = makeCentral();
    const { ctx } = makeCtx({ central, sessions: [cardOf(central, 'acceptEdits')] });
    for (const s of [
      card({ permissionMode: 'yolo' }),
      card({ permissionMode: 'someNewMode', startupCommand: 'claude --permission-mode plan' }),
      card({ startupCommand: 'claude --permission-mode wild' }),
      card({ startupCommand: 'claude --permission-mode full-auto' }),
    ]) {
      const mode = effectiveModeOf(s);
      expect(MODE_RANK[mode], mode).toBeUndefined();
      expect(() => assertWithinCap(ctx, mode), mode).toThrow(ToolError);
    }
    expect(effectiveModeOf(card({ permissionMode: 'yolo' }))).toBe('yolo');
    expect(effectiveModeOf(card({ startupCommand: 'claude --permission-mode wild' }))).toBe('wild');
    // An empty mode is none.
    expect(effectiveModeOf(card({ permissionMode: '' }))).toBe('default');
  });

  it('a Codex profile counts as bypass: it can set any approval policy and sandbox (A-M1)', () => {
    const fromCommand = (command: string): string => effectiveModeOf(card({ startupCommand: command }));
    expect(fromCommand('codex --profile work')).toBe('bypassPermissions');
    expect(fromCommand('codex -p work')).toBe('bypassPermissions');
    expect(fromCommand('codex --profile=work --model gpt-5')).toBe('bypassPermissions');
  });

  it('the card’s sshCommand is read too, as the relaunch routes reuse it (C-M6)', () => {
    expect(effectiveModeOf(card({ permissionMode: 'plan', sshCommand: 'claude --dangerously-skip-permissions' }))).toBe('bypassPermissions');
    expect(effectiveModeOf(card({ sshCommand: 'codex --full-auto' }))).toBe('acceptEdits');
  });

  it('a stored command looser than the card wins: a relaunch runs the command', () => {
    expect(effectiveModeOf(card({ permissionMode: 'plan', startupCommand: 'claude --dangerously-skip-permissions' }))).toBe(
      'bypassPermissions',
    );
    expect(effectiveModeOf(card({ permissionMode: 'acceptEdits', startupCommand: 'claude --permission-mode plan' }))).toBe('acceptEdits');
  });
});

describe('centralCap', () => {
  it('centralCap reads the central’s card, not its record, and unknown is default', () => {
    const central = makeCentral('global', null, { permissionMode: 'bypassPermissions' });
    expect(centralCap(makeCtx({ central, sessions: [cardOf(central, 'plan')] }).ctx)).toBe('plan');
    // No card yet: the record's mode.
    expect(centralCap(makeCtx({ central }).ctx)).toBe('bypassPermissions');
    // A mode AASC does not know (a Codex central's card has none): default.
    const codex = makeCentral('global', null, { cli: 'codex', permissionMode: null });
    expect(centralCap(makeCtx({ central: codex, sessions: [cardOf(codex, null)] }).ctx)).toBe('default');
    const odd = makeCentral('global', null, { permissionMode: 'yolo' });
    expect(centralCap(makeCtx({ central: odd, sessions: [cardOf(odd, 'yolo')] }).ctx)).toBe('default');
  });
});

describe('assertWithinCap', () => {
  it('assertWithinCap refuses looser, takes equal or stricter', () => {
    const central = makeCentral();
    const { ctx } = makeCtx({ central, sessions: [cardOf(central, 'acceptEdits')] });

    expect(() => assertWithinCap(ctx, 'acceptEdits')).not.toThrow();
    expect(() => assertWithinCap(ctx, 'default')).not.toThrow();
    expect(() => assertWithinCap(ctx, 'plan')).not.toThrow();
    for (const looser of ['auto', 'dontAsk', 'bypassPermissions', 'not-a-mode']) {
      let err: unknown = null;
      try {
        assertWithinCap(ctx, looser);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ToolError);
      expect(err).toMatchObject({
        code: 'DENIED',
        message: 'A central opens or relaunches sessions no looser than its own permission mode.',
      });
      expect((err as ToolError).message).not.toContain(looser);
    }
    expect(Object.keys(MODE_RANK)).toEqual(['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
  });
});
