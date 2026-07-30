import { describe, it, expect } from 'vitest';
import { sessionDisplayTitle, UNTITLED_SESSION_LABEL } from './sessionDisplayTitle';

describe('sessionDisplayTitle', () => {
  it('prefers an explicit title', () => {
    expect(sessionDisplayTitle({ title: 'SMS OPS', projectName: 'sms-ops' })).toBe('SMS OPS');
  });

  it('falls back to the project when the title is empty', () => {
    // The live-snapshot shape that rendered as a bare "Unnamed" card: a session
    // that reached `working` without ever recording a UserPromptSubmit, so
    // buildAutoTitle never fired.
    expect(sessionDisplayTitle({ title: '', projectName: 'sms-ops' })).toBe('sms-ops');
  });

  it('treats a whitespace-only title as absent', () => {
    expect(sessionDisplayTitle({ title: '   ', projectName: 'sms-ops' })).toBe('sms-ops');
  });

  it('falls back to the placeholder when there is no project either', () => {
    expect(sessionDisplayTitle({ title: '', projectName: '' })).toBe(UNTITLED_SESSION_LABEL);
  });

  it('tolerates null/undefined fields and a missing session', () => {
    expect(sessionDisplayTitle({ title: null, projectName: null })).toBe(UNTITLED_SESSION_LABEL);
    expect(sessionDisplayTitle({})).toBe(UNTITLED_SESSION_LABEL);
    expect(sessionDisplayTitle(undefined)).toBe(UNTITLED_SESSION_LABEL);
    expect(sessionDisplayTitle(null)).toBe(UNTITLED_SESSION_LABEL);
  });

  it('never returns an empty string', () => {
    for (const s of [{}, { title: '' }, { projectName: '' }, { title: ' ', projectName: ' ' }]) {
      expect(sessionDisplayTitle(s).length).toBeGreaterThan(0);
    }
  });
});
