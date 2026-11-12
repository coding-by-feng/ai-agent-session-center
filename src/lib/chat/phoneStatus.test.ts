// phoneStatus.test.ts — a session status in the phone's plain words and tones (AASC-38).
import { describe, it, expect } from 'vitest';
import { COMPACTING_STALE_MS, STOP_HOOKS_STALE_MS, isCompacting, isFinishingUp, phoneStatus, sessionSubtitle } from './phoneStatus';

describe('phoneStatus', () => {
  it('names every status in plain words with its tone', () => {
    expect(phoneStatus('approval')).toEqual({ tone: 'approval', label: 'Waiting for approval', glyph: 'approval' });
    expect(phoneStatus('input')).toMatchObject({ tone: 'question', label: 'Has a question' });
    expect(phoneStatus('working')).toMatchObject({ tone: 'working', label: 'Working' });
    expect(phoneStatus('prompting')).toMatchObject({ tone: 'working' });
    expect(phoneStatus('waiting')).toMatchObject({ tone: 'finished', label: 'Finished' });
    expect(phoneStatus('idle')).toMatchObject({ tone: 'idle', label: 'Idle' });
    expect(phoneStatus('ended')).toMatchObject({ tone: 'idle', label: 'Ended' });
  });

  it('lets an interruption outrank the status, except on an ended session', () => {
    expect(phoneStatus('waiting', true)).toEqual({ tone: 'error', label: 'Interrupted', glyph: 'interrupted' });
    expect(phoneStatus('ended', true)).toMatchObject({ label: 'Ended' });
  });

  it('names the proceed reminder in amber with its own P (sessionStatusStyle.displayStatus)', () => {
    expect(phoneStatus('proceed')).toEqual({ tone: 'approval', label: 'Asks you to proceed', glyph: 'proceed' });
  });

  it('shows an unknown status as it is, in grey', () => {
    expect(phoneStatus('mystery')).toEqual({ tone: 'idle', label: 'mystery', glyph: 'idle' });
  });
});

describe('sessionSubtitle', () => {
  const base = { status: 'working', interruption: null, projectName: 'agent-manager', model: 'claude-opus-5-5' } as const;

  it('prefers the live model and effort for the session subtitle', () => {
    expect(sessionSubtitle({ ...base, runtime: { model: 'Opus 5.5', effort: 'high' } })).toBe('Working · Opus 5.5 · high');
    expect(sessionSubtitle({ ...base, effortLevel: 'max' })).toBe('Working · Opus 5.5 · max');
    expect(sessionSubtitle({ ...base, model: 'gpt-5.5-codex' })).toBe('Working · gpt-5.5-codex');
  });
});

describe('compacting', () => {
  const now = 1_000_000;
  const compacting = { since: now - 5_000, trigger: 'auto' as const };

  it('is compacting from PreCompact until the server clears it, for at most COMPACTING_STALE_MS', () => {
    expect(isCompacting({ compacting }, now)).toBe(true);
    expect(isCompacting({ compacting: null }, now)).toBe(false);
    expect(isCompacting({}, now)).toBe(false);
    // A lost end hook must not leave "Compacting" up for good.
    expect(isCompacting({ compacting: { since: now - COMPACTING_STALE_MS, trigger: null } }, now)).toBe(false);
  });

  it('says "Compacting" in the working tone over an idle, finished or working status', () => {
    for (const status of ['idle', 'waiting', 'working', 'prompting']) {
      expect(phoneStatus(status, false, true)).toEqual({ tone: 'working', label: 'Compacting', glyph: 'working' });
    }
  });

  it('reads the display status too, so a ring handed it spins like work', () => {
    expect(phoneStatus('compacting')).toEqual({ tone: 'working', label: 'Compacting', glyph: 'working' });
    expect(phoneStatus('compacting', true)).toMatchObject({ label: 'Interrupted' });
  });

  it('never hides a question, an approval, an interruption or the end', () => {
    expect(phoneStatus('approval', false, true)).toMatchObject({ label: 'Waiting for approval' });
    expect(phoneStatus('input', false, true)).toMatchObject({ label: 'Has a question' });
    expect(phoneStatus('waiting', true, true)).toMatchObject({ label: 'Interrupted' });
    expect(phoneStatus('ended', false, true)).toMatchObject({ label: 'Ended' });
  });

  it('shows in the session subtitle', () => {
    const live = { compacting: { since: Date.now(), trigger: 'manual' as const } };
    expect(sessionSubtitle({ status: 'idle', interruption: null, model: 'claude-opus-5-5', effortLevel: 'high', ...live }))
      .toBe('Compacting · Opus 5.5 · high');
  });
});

describe('Finishing up (Claude still running its Stop hooks)', () => {
  const now = 1_800_000_000_000;

  it('holds only for a finished turn whose Stop hooks are fresh', () => {
    expect(isFinishingUp({ status: 'waiting', stopHooksSince: now - 5_000 }, now)).toBe(true);
    expect(isFinishingUp({ status: 'waiting', stopHooksSince: null }, now)).toBe(false);
    expect(isFinishingUp({ status: 'waiting' }, now)).toBe(false);
    // A turn that went back to work, or a dialog, is not "finishing".
    expect(isFinishingUp({ status: 'working', stopHooksSince: now - 5_000 }, now)).toBe(false);
    expect(isFinishingUp({ status: 'approval', stopHooksSince: now - 5_000 }, now)).toBe(false);
    // A summary the server never saw must not leave it up for good.
    expect(isFinishingUp({ status: 'waiting', stopHooksSince: now - STOP_HOOKS_STALE_MS }, now)).toBe(false);
  });

  it('says "Finishing up" in the working tone instead of "Finished"', () => {
    expect(phoneStatus('waiting', false, false, true)).toEqual({ tone: 'working', label: 'Finishing up', glyph: 'working' });
  });

  it('never hides an interruption or a compaction', () => {
    expect(phoneStatus('waiting', true, false, true)).toMatchObject({ label: 'Interrupted' });
    expect(phoneStatus('waiting', false, true, true)).toMatchObject({ label: 'Compacting' });
  });

  it('shows in the session subtitle', () => {
    expect(sessionSubtitle({ status: 'waiting', interruption: null, model: 'claude-opus-5-5', effortLevel: 'high', stopHooksSince: Date.now() }))
      .toBe('Finishing up · Opus 5.5 · high');
  });
});
