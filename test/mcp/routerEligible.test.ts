// test/mcp/routerEligible.test.ts — may the router give a session this task? (`eligible`, and `steerRefusal`, the one
// adapter through which the router asks the P2 steering policy): the cheap facts first (a central, a popup, an
// external card, another machine, no terminal, outside the project, the wrong CLI, a dialog, a busy turn, a full
// context window), the policy last, and the reason in AASC's words. Nothing here touches a process or the disk.
import { describe, expect, it, vi } from 'vitest';
import { eligible, steerRefusal } from '../../server/mcp/router.js';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import type { Ledger } from '../../server/mcp/ledger.js';
import { ToolError } from '../../server/mcp/types.js';
import type { PendingRequest, Session } from '../../src/types/session.js';
import { makeCentral, makeCtx, makeRoom, NOW } from './toolHarness.js';
import { AGENT, MIN, SITE, withContext, worker } from './routerFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const dialog: PendingRequest = { id: 'req-1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: NOW, source: 'permission_request' };
const want = { folder: AGENT };

describe('eligible', () => {
  it('is null for an idle or a waiting session in the project, in the folder or below it', () => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', AGENT), ctx, want)).toBeNull();
    expect(eligible(worker('s2', AGENT, { status: 'waiting' }), ctx, want)).toBeNull();
    expect(eligible(worker('s3', `${AGENT}/packages/web`), ctx, want)).toBeNull();
    expect(eligible(worker('s4', AGENT, withContext(79)), ctx, want)).toBeNull();
    expect(eligible(worker('s5', AGENT), ctx)).toBeNull();
    expect(eligible(worker('s6', AGENT, { startHeard: true }), ctx, want)).toBeNull();
  });

  it.each<[string, Partial<Session>, string]>([
    ['a working session', { status: 'working' }, 'working'],
    ['a session taking a prompt', { status: 'prompting' }, 'prompting'],
    ['a session still starting', { status: 'connecting' }, 'connecting'],
    ['a session that has ended', { status: 'ended' }, 'ended'],
    ['a session at an approval', { status: 'approval' }, 'has an open dialog'],
    ['a session asking a question', { status: 'input' }, 'has an open dialog'],
    ['a waiting session with a request open', { status: 'waiting', pendingRequest: dialog }, 'has an open dialog'],
    ['a central', { central: { centralId: 'c1', kind: 'project', scopeRef: AGENT } }, 'is a central'],
    ['a floating popup', { isFloating: true }, 'is a floating popup'],
    ['an external card', { isExternal: true }, 'is an external card'],
    ['a session on another machine', { sshHost: 'build-box' }, 'runs on another machine'],
    ['a session with no terminal', { terminalId: null }, 'has no terminal'],
    ['a subagent', { isSubagent: true }, 'is a subagent'],
    // The connecting timeout flipped it to idle with no hook from its terminal: its CLI may be at a folder-trust prompt.
    ['a session that went idle without ever reporting a start', { startHeard: false }, 'has not reported that it started'],
  ])('%s is not eligible: %s', (_name, over, reason) => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', AGENT, over), ctx, want)).toBe(reason);
  });

  it('a session outside the project is not eligible; a folder that merely starts alike is outside', () => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', SITE), ctx, want)).toBe('outside the project');
    expect(eligible(worker('s2', `${AGENT}-2`), ctx, want)).toBe('outside the project');
    expect(eligible(worker('s3', `${AGENT}/`), ctx, want)).toBeNull();
  });

  it('context at 80 % is not eligible; the ceiling is the one given', () => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', AGENT, withContext(80)), ctx, want)).toBe('context at 80 %');
    expect(eligible(worker('s2', AGENT, withContext(100)), ctx, want)).toBe('context at 100 %');
    // The number a card shows is the whole number nearest the reading, and the rule judges that number.
    expect(eligible(worker('s3', AGENT, withContext(79.4)), ctx, want)).toBeNull();
    expect(eligible(worker('s6', AGENT, withContext(79.5)), ctx, want)).toBe('context at 80 %');
    expect(eligible(worker('s4', AGENT, withContext(60)), ctx, { ...want, contextCeilingPct: 60 })).toBe('context at 60 %');
    expect(eligible(worker('s5', AGENT, withContext(59)), ctx, { ...want, contextCeilingPct: 60 })).toBeNull();
  });

  it('a context reading that is not there is not a full window', () => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', AGENT), ctx, want)).toBeNull();
    expect(eligible(worker('s2', AGENT, { runtime: {} }), ctx, want)).toBeNull();
  });

  it('only a session of the CLI asked for is eligible', () => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', AGENT), ctx, { ...want, cli: 'claude' })).toBeNull();
    expect(eligible(worker('s2', AGENT), ctx, { ...want, cli: 'codex' })).toBe('runs claude');
    expect(eligible(worker('s3', AGENT, { cliSource: 'codex' }), ctx, { ...want, cli: 'claude' })).toBe('runs codex');
    expect(eligible(worker('s4', AGENT, { cliSource: 'gemini' }), ctx, { ...want, cli: 'claude' })).toBe('runs an unknown CLI');
    expect(eligible(worker('s5', AGENT, { cliSource: 'gemini' }), ctx, want)).toBeNull();
  });

  it('a session the caller excluded is not eligible', () => {
    const { ctx } = makeCtx();

    expect(eligible(worker('s1', AGENT), ctx, { ...want, exclude: new Set(['s1']) })).toBe('excluded (re-route)');
    expect(eligible(worker('s2', AGENT), ctx, { ...want, exclude: new Set(['s1']) })).toBeNull();
  });

  it('a human-active session is not eligible', () => {
    const { ctx } = makeCtx({ controller: () => ({ clientId: 'window-1', lastActivityAt: NOW - 10 * 1000 }) });

    expect(eligible(worker('s1', AGENT), ctx, want)).toBe('HUMAN_ACTIVE');
  });

  it('a session a person drove a minute ago is free again; a central’s own driving is not a person', () => {
    const quiet = makeCtx({ controller: () => ({ clientId: 'window-1', lastActivityAt: NOW - 61 * 1000 }) });
    expect(eligible(worker('s1', AGENT), quiet.ctx, want)).toBeNull();

    const mcp = makeCtx({ controller: () => ({ clientId: 'mcp:c1', lastActivityAt: NOW - 1000 }) });
    expect(eligible(worker('s1', AGENT), mcp.ctx, want)).toBeNull();
  });

  it('answers with the policy’s code for a hands-off session, one holding a task, one out of scope and an ops shell', () => {
    const locked: Ledger = { ...unwiredLedger, isLocked: (id) => id === 'busy' };
    const { ctx } = makeCtx({ ledger: locked, isOpsTerminal: (t) => t === 't-ops' });

    expect(eligible(worker('s1', AGENT, { handsOff: true }), ctx, want)).toBe('HANDS_OFF');
    expect(eligible(worker('busy', AGENT), ctx, want)).toBe('BUSY');
    expect(eligible(worker('s2', AGENT, { terminalId: 't-ops' }), ctx, want)).toBe('INVALID');

    const room = makeCtx({ central: makeCentral('room', 'r1'), rooms: [makeRoom('r1', ['mine'])] });
    expect(eligible(worker('mine', AGENT), room.ctx, want)).toBeNull();
    expect(eligible(worker('theirs', AGENT), room.ctx, want)).toBe('NOT_IN_SCOPE');
  });

  it('settles the cheap facts before it asks the policy, so a skipped session is never audited', () => {
    const h = makeCtx();
    const asked = vi.fn();
    const ctx = { ...h.ctx, mayDrive: (s: Session) => { asked(s.sessionId); h.ctx.mayDrive(s); } };

    expect(eligible(worker('s1', AGENT, { status: 'working', handsOff: true }), ctx, want)).toBe('working');
    expect(eligible(worker('s2', SITE, { handsOff: true }), ctx, want)).toBe('outside the project');
    expect(asked).not.toHaveBeenCalled();

    expect(eligible(worker('s3', AGENT, { handsOff: true }), ctx, want)).toBe('HANDS_OFF');
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('is new in each call: it changes nothing it is given', () => {
    const { ctx } = makeCtx();
    const session = Object.freeze(worker('s1', AGENT, withContext(10)));

    expect(() => eligible(session, ctx, want)).not.toThrow();
  });
});

describe('steerRefusal', () => {
  const s = worker('s1', AGENT);

  it('is null when the policy lets the central steer, and asks it once', () => {
    const mayDrive = vi.fn();

    expect(steerRefusal(s, { mayDrive })).toBeNull();
    expect(mayDrive).toHaveBeenCalledTimes(1);
    expect(mayDrive).toHaveBeenCalledWith(s);
  });

  it('is the code of the policy’s refusal', () => {
    for (const code of ['NOT_IN_SCOPE', 'INVALID', 'HANDS_OFF', 'HUMAN_ACTIVE', 'BUSY', 'UNAVAILABLE'] as const) {
      const mayDrive = () => {
        throw new ToolError(code, 'No.', 'Pick another.');
      };
      expect(steerRefusal(s, { mayDrive })).toBe(code);
    }
  });

  it('lets anything that is not a refusal through', () => {
    const mayDrive = () => {
      throw new TypeError('the store is gone');
    };

    expect(() => steerRefusal(s, { mayDrive })).toThrow(TypeError);
  });
});

describe('the minute rule is the policy’s', () => {
  it('a person who drove a session 59 seconds ago holds it', () => {
    const { ctx } = makeCtx({ controller: () => ({ clientId: 'phone:1', lastActivityAt: NOW - 59_000 }) });

    expect(eligible(worker('s1', AGENT, { lastActivityAt: NOW - MIN }), ctx, want)).toBe('HUMAN_ACTIVE');
  });
});
