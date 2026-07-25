import { describe, expect, it } from 'vitest';
import { coalesceSessionUpdate } from '../server/sessionUpdateCoalescer.js';
import type { HandleEventResult, Session } from '../src/types/session.js';

function update(sessionId: string, status: Session['status'], replacesId?: string): HandleEventResult {
  return {
    session: {
      sessionId,
      status,
      replacesId,
    } as Session,
  };
}

describe('coalesceSessionUpdate', () => {
  it('keeps the first replacesId while taking the latest session state', () => {
    const first = update('codex-uuid', 'idle', 'term-old');
    const second = update('codex-uuid', 'prompting');

    const merged = coalesceSessionUpdate(first, second);

    expect(merged.session.sessionId).toBe('codex-uuid');
    expect(merged.session.status).toBe('prompting');
    expect(merged.session.replacesId).toBe('term-old');
  });

  it('retains the latest team payload when present', () => {
    const first = update('codex-uuid', 'idle');
    const second = update('codex-uuid', 'working');
    second.team = { id: 'team-latest' } as HandleEventResult['team'];

    expect(coalesceSessionUpdate(first, second).team).toBe(second.team);
  });
});
