// phoneStatus.test.ts — a session status in the phone's plain words and tones (AASC-38).
import { describe, it, expect } from 'vitest';
import { phoneStatus, sessionStatusLine, sessionSubtitle } from './phoneStatus';

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

  it('shows an unknown status as it is, in grey', () => {
    expect(phoneStatus('mystery')).toEqual({ tone: 'idle', label: 'mystery', glyph: 'idle' });
  });
});

describe('sessionStatusLine / sessionSubtitle', () => {
  const base = { status: 'working', interruption: null, projectName: 'agent-manager', model: 'claude-opus-5-5' } as const;

  it('joins the status with the project for a list row', () => {
    expect(sessionStatusLine(base)).toBe('Working · agent-manager');
    expect(sessionStatusLine({ ...base, projectName: '' })).toBe('Working');
  });

  it('prefers the live model and effort for the session subtitle', () => {
    expect(sessionSubtitle({ ...base, runtime: { model: 'Opus 5.5', effort: 'high' } })).toBe('Working · Opus 5.5 · high');
    expect(sessionSubtitle({ ...base, effortLevel: 'max' })).toBe('Working · Opus 5.5 · max');
    expect(sessionSubtitle({ ...base, model: 'gpt-5.5-codex' })).toBe('Working · gpt-5.5-codex');
  });
});
