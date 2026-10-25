// test/mcp/respawn.test.ts — a central's card in the opt-in headless respawn (server/index.ts
// respawnSshTerminals, AASC_SERVER_AUTORESPAWN=1), through server/mcp/respawn.ts. Like every relaunch that
// spawns a new PTY, the card gets its central back under its own id with a new token, or, when that cannot
// be, comes back as a plain session with its marker cleared (Ruling 16). A card that is no central is
// spawned exactly as before.
//
// createTerminal is a stand-in that attaches the central the way sshManager does right after the spawn;
// no PTY or process is real. The registry is the server's own (`centrals`), emptied after each test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { TerminalConfig } from '../../src/types/terminal.js';
import { centrals } from '../../server/mcp/centrals.js';
import type { CentralCaller } from '../../server/mcp/centralLaunch.js';
import { spawnRespawnTerminal } from '../../server/mcp/respawn.js';
import type { SessionCentralMarker } from '../../server/mcp/types.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

const CENTRAL_ID = '6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CONFIG: TerminalConfig = {
  host: 'localhost',
  workingDir: '/tmp/respawn-project',
  command: '',
};

let seq = 0;
const createTerminal = vi.fn(async (config: TerminalConfig): Promise<string> => {
  const terminalId = `term-respawn-${++seq}`;
  // sshManager attaches a central's new PTY to its record as soon as it has spawned.
  if (config.central && centrals.byId(config.central.centralId)) {
    centrals.attachTerminal(config.central.centralId, terminalId);
  }
  return terminalId;
});
const clearSessionCentral = vi.fn();
const caller: CentralCaller = {
  isLocal: true,
  roomExists: (roomId) => roomId === 'room-1',
  isTerminalLive: () => false,
};
const deps = { createTerminal, clearSessionCentral, caller };

function card(
  central: SessionCentralMarker | undefined,
  sessionId = 'claude-respawn-1',
): Pick<Session, 'sessionId' | 'central' | 'permissionMode'> & { terminalId: string } {
  return { sessionId, central, permissionMode: null, terminalId: 'term-before-restart' };
}

const GLOBAL: SessionCentralMarker = { centralId: CENTRAL_ID, kind: 'global', scopeRef: null };

beforeEach(() => {
  createTerminal.mockClear();
  clearSessionCentral.mockClear();
  log.warn.mockClear();
});

afterEach(() => {
  for (const record of centrals.list()) centrals.revoke(record.centralId);
});

describe('spawnRespawnTerminal', () => {
  it("brings a central's card back as its central, under its own id, in the new PTY", async () => {
    const { terminalId, central } = await spawnRespawnTerminal(
      card(GLOBAL),
      CONFIG,
      { command: "claude --resume 'claude-respawn-1' || claude --continue", remoteHost: false },
      deps,
    );

    expect(central).toEqual(GLOBAL);
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith({ ...CONFIG, central: GLOBAL });
    expect(centrals.byId(CENTRAL_ID)).toMatchObject({ cli: 'claude', terminalId });
    expect(clearSessionCentral).not.toHaveBeenCalled();
  });

  it('mints it again with a new token when the registry still holds it', async () => {
    const before = centrals.mint({ ...GLOBAL, cli: 'claude', permissionMode: null });

    await spawnRespawnTerminal(
      card(GLOBAL),
      CONFIG,
      { command: 'claude', remoteHost: false },
      deps,
    );

    const after = centrals.byId(CENTRAL_ID);
    expect(after?.token).not.toBe(before.token);
    expect(after?.terminalId).toBe('term-respawn-' + String(seq));
  });

  it('brings a card whose central cannot be had again back as a plain session, its marker cleared', async () => {
    const goneRoom: SessionCentralMarker = {
      centralId: CENTRAL_ID,
      kind: 'room',
      scopeRef: 'room-gone',
    };

    const { central } = await spawnRespawnTerminal(
      card(goneRoom, 'claude-respawn-2'),
      CONFIG,
      { command: 'claude --continue', remoteHost: false },
      deps,
    );

    expect(central).toBeUndefined();
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(clearSessionCentral).toHaveBeenCalledExactlyOnceWith('claude-respawn-2');
    expect(centrals.byId(CENTRAL_ID)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('claude-respawn-2'));
  });

  it('drops the central of a card on another machine, or one whose line is no bare claude or codex', async () => {
    const remote = await spawnRespawnTerminal(
      card(GLOBAL, 'remote-card'),
      CONFIG,
      { command: 'claude --continue', remoteHost: true },
      deps,
    );
    const pathCodex = await spawnRespawnTerminal(
      card(GLOBAL, 'codex-card'),
      CONFIG,
      { command: '/usr/local/bin/codex resume --last', remoteHost: false },
      deps,
    );

    expect([remote.central, pathCodex.central]).toEqual([undefined, undefined]);
    expect(clearSessionCentral.mock.calls).toEqual([['remote-card'], ['codex-card']]);
    expect(createTerminal.mock.calls.every(([config]) => config.central === undefined)).toBe(true);
  });

  it('spawns a card that is no central exactly as before', async () => {
    const { central } = await spawnRespawnTerminal(
      card(undefined),
      CONFIG,
      { command: 'claude --continue', remoteHost: false },
      deps,
    );

    expect(central).toBeUndefined();
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(clearSessionCentral).not.toHaveBeenCalled();
    expect(centrals.list()).toEqual([]);
  });

  it('leaves no central behind when the spawn fails, and keeps the marker for the next attempt', async () => {
    createTerminal.mockRejectedValueOnce(new Error('posix_spawnp failed'));

    await expect(
      spawnRespawnTerminal(card(GLOBAL), CONFIG, { command: 'claude', remoteHost: false }, deps),
    ).rejects.toThrow('posix_spawnp failed');

    expect(centrals.byId(CENTRAL_ID)).toBeNull();
    expect(clearSessionCentral).not.toHaveBeenCalled();
  });
});
