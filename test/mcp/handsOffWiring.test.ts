// test/mcp/handsOffWiring.test.ts — the setter the dashboard's hands-off route is handed (server/mcp/handsOffSetter.ts,
// Ruling 55) and where server/index.ts hands it over. The setter's effect on what the windows are sent is in
// handsOffBroadcastRace.test.ts, through the real hook pipeline and store; this file pins what it calls and in which
// order, and that the server wires it in place of the store's bare function. The server is never started; its source
// is read, as test/mcp/indexWiring.test.ts does.
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { createHandsOffSetter } from '../../server/mcp/handsOffSetter.js';
import { makeSession } from './toolHarness.js';

describe('createHandsOffSetter', () => {
  const rig = (answer: (sessionId: string) => Session | null) => {
    const log: string[] = [];
    const set = vi.fn((sessionId: string, on: boolean) => {
      log.push(`set ${sessionId} ${on}`);
      return answer(sessionId);
    });
    const refresh = vi.fn((sessionId: string, card: Session) => {
      log.push(`refresh ${sessionId} ${card.handsOff === true}`);
    });
    return { log, set, refresh, setter: createHandsOffSetter(set, refresh) };
  };

  it('sets the flag first, then refreshes the held update with the card the setter answered', () => {
    const flipped = makeSession('card-1', { handsOff: true });
    const { log, setter, refresh } = rig(() => flipped);

    setter('card-1', true);

    expect(log).toEqual(['set card-1 true', 'refresh card-1 true']);
    expect(refresh).toHaveBeenCalledWith('card-1', flipped);
  });

  it('refreshes under the card’s own id, not the id the caller used (a re-keyed id reaches the card it became)', () => {
    const { setter, refresh } = rig(() => makeSession('card-now', { handsOff: true }));

    setter('term-before-the-rekey', true);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toBe('card-now');
  });

  it('refreshes after a clear too, with the card that no longer has the flag', () => {
    const { log, setter } = rig(() => makeSession('card-1'));

    setter('card-1', false);

    expect(log).toEqual(['set card-1 false', 'refresh card-1 false']);
  });

  it('answers exactly what the setter answered', () => {
    const flipped = makeSession('card-1', { handsOff: true });
    const { setter } = rig(() => flipped);

    expect(setter('card-1', true)).toBe(flipped);
  });

  it('refreshes nothing and answers null when there is no such session', () => {
    const { setter, refresh } = rig(() => null);

    expect(setter('gone', true)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('passes what the setter throws on, and refreshes nothing', () => {
    const refresh = vi.fn();
    const setter = createHandsOffSetter(() => {
      throw new Error('the store failed');
    }, refresh);

    expect(() => setter('card-1', true)).toThrow('the store failed');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('server/index.ts wiring of the hands-off setter', () => {
  async function indexSource() {
    const source = await readFile(new URL('../../server/index.ts', import.meta.url), 'utf8');
    const at = (needle: string, from = 0): number => {
      const i = source.indexOf(needle, from);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    return { source, at };
  }

  it('imports the setter factory and the hook pipeline’s refresh', async () => {
    const { source } = await indexSource();

    expect(source).toContain("import { createHandsOffSetter } from './mcp/handsOffSetter.js';");
    expect(source).toMatch(/import \{[^}]*\brefreshPendingSessionUpdate\b[^}]*\} from '\.\/hookProcessor\.js';/);
    expect(source).toMatch(/import \{[^}]*\bsetSessionHandsOff\b[^}]*\} from '\.\/sessionStore\.js';/);
  });

  it('hands the dashboard’s router the wrapped setter, built from the store’s function and the pipeline’s own refresh', async () => {
    const { source, at } = await indexSource();
    const router = at('const centralsRouter = createCentralsRouter({');
    const deps = source.slice(router, source.indexOf('});', router));

    expect(deps).toContain('setHandsOff: createHandsOffSetter(setSessionHandsOff, refreshPendingSessionUpdate),');
  });

  it('never hands the store’s bare setter to anything: it appears only as the import and inside the wrapper', async () => {
    const { source } = await indexSource();
    const lines = source.split('\n').filter((line) => line.includes('setSessionHandsOff'));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^import \{/);
    expect(lines[1]).toContain('createHandsOffSetter(setSessionHandsOff, refreshPendingSessionUpdate)');
  });
});
