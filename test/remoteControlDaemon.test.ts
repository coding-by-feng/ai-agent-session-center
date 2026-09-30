/**
 * Remote Control relink daemon.
 *
 * The rules under test are the ones that keep an unattended loop from typing
 * slash commands into a live session forever, and the name derivation that
 * decides what gets typed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setArmed,
  getEntry,
  shouldRelink,
  noteRelinked,
  runRelink,
  relinkCommands,
  remoteControlNameFor,
  sanitizeName,
  migrateSession,
  forgetSession,
  _resetForTests,
  COOLDOWN_MS,
  NAME_SAFE_RE,
} from '../server/remoteControlDaemon.js';

const SID = 'abcdef12-3456-7890-abcd-ef1234567890';
const T0 = 1_700_000_000_000;

beforeEach(() => { _resetForTests(); });

describe('arming', () => {
  it('is disarmed until explicitly armed', () => {
    expect(getEntry(SID).armed).toBe(false);
    expect(shouldRelink(SID, T0)).toBe(false);
  });

  it('relinks once armed', () => {
    setArmed(SID, true);
    expect(shouldRelink(SID, T0)).toBe(true);
  });

  it('DISARMING IS STICKY — nothing re-arms it', () => {
    // A watchdog that re-enables what the user switched off makes the off
    // switch a lie. Nothing in this module writes `armed: true` except an
    // explicit setArmed call.
    setArmed(SID, true);
    noteRelinked(SID, T0);
    setArmed(SID, false);
    expect(shouldRelink(SID, T0 + COOLDOWN_MS * 10)).toBe(false);
  });

  it('keeps sessions independent', () => {
    setArmed(SID, true);
    expect(shouldRelink('other', T0)).toBe(false);
  });
});

describe('cooldown — the self-retrigger guard', () => {
  it('blocks a second relink inside the window', () => {
    // THE loop this prevents: the relink writes to the PTY, that input moves
    // the session out of idle, and it returns to idle a minute or two later —
    // a real idle edge. Without the cooldown that edge fires another relink,
    // forever.
    setArmed(SID, true);
    noteRelinked(SID, T0);
    expect(shouldRelink(SID, T0 + 60_000)).toBe(false);
    expect(shouldRelink(SID, T0 + COOLDOWN_MS - 1)).toBe(false);
  });

  it('allows a relink once the window elapses', () => {
    setArmed(SID, true);
    noteRelinked(SID, T0);
    expect(shouldRelink(SID, T0 + COOLDOWN_MS)).toBe(true);
  });

  it('counts relinks', () => {
    setArmed(SID, true);
    noteRelinked(SID, T0);
    noteRelinked(SID, T0 + COOLDOWN_MS);
    expect(getEntry(SID).relinkCount).toBe(2);
  });
});

describe('relinkCommands', () => {
  it('disconnects with a BARE command, then reconnects WITH the name', () => {
    // Confirmed against the Claude Code binary's own strings: "Disconnect
    // anytime with /remote-control". Attaching the name to the first command
    // would re-enable rather than disconnect, and the cycle would do nothing.
    expect(relinkCommands('my-session')).toEqual([
      '/remote-control',
      '/remote-control my-session',
    ]);
  });
});

describe('runRelink', () => {
  it('writes both commands, each terminated with a real Enter', async () => {
    setArmed(SID, true);
    const write = vi.fn();
    const ok = await runRelink({ sessionId: SID, name: 'vocab', write, now: T0, gapMs: 0 });
    expect(ok).toBe(true);
    expect(write.mock.calls.map((c) => c[0])).toEqual([
      '/remote-control\r',
      '/remote-control vocab\r',
    ]);
  });

  it('writes NOTHING when the session is not due', async () => {
    setArmed(SID, true);
    noteRelinked(SID, T0);
    const write = vi.fn();
    const ok = await runRelink({ sessionId: SID, name: 'x', write, now: T0 + 1000, gapMs: 0 });
    expect(ok).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing for a disarmed session', async () => {
    const write = vi.fn();
    expect(await runRelink({ sessionId: SID, name: 'x', write, now: T0, gapMs: 0 })).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('stamps the cooldown BEFORE writing, so a mid-cycle crash still blocks a retry', async () => {
    setArmed(SID, true);
    const write = vi.fn(() => { throw new Error('pty died'); });
    await expect(
      runRelink({ sessionId: SID, name: 'x', write, now: T0, gapMs: 0 }),
    ).rejects.toThrow();
    // The failed attempt still consumed the window — otherwise a broken PTY
    // would be retried on every idle edge.
    expect(shouldRelink(SID, T0 + 1000)).toBe(false);
  });
});

describe('remoteControlNameFor', () => {
  it('uses the session title', () => {
    expect(remoteControlNameFor({ sessionId: SID, title: 'Fix the queue bug' }))
      .toBe('Fix-the-queue-bug');
  });

  it('falls back to the project name when the title is empty', () => {
    // The normal pre-first-prompt state: session.title is '' until the first
    // UserPromptSubmit, which is exactly why names never matched before.
    expect(remoteControlNameFor({ sessionId: SID, title: '', projectName: 'agent-manager' }))
      .toBe('agent-manager');
  });

  it('falls back for a title that sanitizes to EMPTY (all-CJK)', () => {
    // Without this the enable half would be a bare `/remote-control` — i.e. a
    // DISCONNECT, the exact opposite of reconnecting.
    const name = remoteControlNameFor({ sessionId: SID, title: '简体中文词汇' });
    expect(name).not.toBe('');
    expect(name).toBe(`session-${SID.slice(0, 8)}`);
  });

  it('never returns an empty name for any input', () => {
    for (const title of ['', '   ', '???', '---', '中文', '\n\t']) {
      expect(remoteControlNameFor({ sessionId: SID, title }).length).toBeGreaterThan(0);
    }
  });

  it('produces only characters the server will accept', () => {
    const name = remoteControlNameFor({ sessionId: SID, title: 'a/b c:d!e (f) 中文' });
    expect(/^[a-zA-Z0-9_.-]+$/.test(name)).toBe(true);
  });
});

describe('sanitizeName', () => {
  it('caps length to the server maximum', () => {
    expect(sanitizeName('x'.repeat(500)).length).toBe(100);
  });

  it('trims leading and trailing separators', () => {
    expect(sanitizeName('  !!hello!!  ')).toBe('hello');
  });

  it('uses the SAME charset regex as the client helper', () => {
    // Duplicated because tsconfig.server.json cannot reach src/lib. Drift
    // would produce a name the API then rejects with a 400 and no clear cause.
    const clientSrc = require('fs').readFileSync('src/lib/remoteControlName.ts', 'utf8');
    const m = clientSrc.match(/const NAME_SAFE_RE = (\/.*\/[gimsuy]*);/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(NAME_SAFE_RE.toString());
  });
});

describe('session lifecycle', () => {
  it('carries state across a --resume re-key', () => {
    setArmed('old', true);
    noteRelinked('old', T0);
    migrateSession('old', 'new');
    expect(getEntry('old').armed).toBe(false);
    expect(getEntry('new').armed).toBe(true);
    expect(shouldRelink('new', T0 + 1000)).toBe(false); // cooldown carried too
  });

  it('does not clobber state the new id already has', () => {
    setArmed('old', true);
    setArmed('new', false);
    migrateSession('old', 'new');
    expect(getEntry('new').armed).toBe(false);
  });

  it('forgets a deleted session', () => {
    setArmed(SID, true);
    forgetSession(SID);
    expect(getEntry(SID).armed).toBe(false);
  });
});
