import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  centralBadgeText,
  centralChoiceHint,
  centralLabel,
  centralRequestFor,
  centralTooltip,
  choiceAvailability,
  effectiveChoice,
  folderKey,
  folderName,
  workersText,
  type CentralChoice,
  type CentralContext,
} from './centralChoice';
import { launchSession } from './launchSession';
import { useSessionStore } from '@/stores/sessionStore';
import type { CentralSummary } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const central = (over: Partial<CentralSummary> = {}): CentralSummary => ({
  centralId: 'c1',
  kind: 'global',
  scopeRef: null,
  cli: 'claude',
  sessionId: null,
  toolsets: [],
  createdAt: 1,
  workerCount: 0,
  ...over,
});

const running = (...rows: CentralSummary[]): ReadonlyMap<string, CentralSummary> =>
  new Map(rows.map((row) => [row.centralId, row]));

const ctx = (over: Partial<CentralContext> = {}): CentralContext => ({
  roomId: 'room-1',
  folder: '/work/app',
  centrals: running(),
  ...over,
});

describe('choiceAvailability', () => {
  it('offers Global whenever no global central runs', () => {
    expect(choiceAvailability('global', ctx({ roomId: null, folder: null }))).toBe('open');
  });

  it('marks Global taken once a global central runs, whatever else does', () => {
    const centrals = running(central({ centralId: 'g' }), central({ centralId: 'r', kind: 'room', scopeRef: 'room-9' }));
    expect(choiceAvailability('global', ctx({ centrals }))).toBe('taken');
  });

  describe('This room', () => {
    it('is absent without a room, blank ones included', () => {
      expect(choiceAvailability('room', ctx({ roomId: null }))).toBe('absent');
      expect(choiceAvailability('room', ctx({ roomId: undefined }))).toBe('absent');
      expect(choiceAvailability('room', ctx({ roomId: '' }))).toBe('absent');
      expect(choiceAvailability('room', ctx({ roomId: '   ' }))).toBe('absent');
    });

    it('is open for a room no central holds, even when another room has one', () => {
      const centrals = running(central({ kind: 'room', scopeRef: 'room-9' }));
      expect(choiceAvailability('room', ctx({ centrals }))).toBe('open');
    });

    it('is taken once a room central holds this room', () => {
      const centrals = running(central({ kind: 'room', scopeRef: 'room-1' }));
      expect(choiceAvailability('room', ctx({ centrals }))).toBe('taken');
    });

    it('reads a padded room id as the room it names', () => {
      const centrals = running(central({ kind: 'room', scopeRef: 'room-1' }));
      expect(choiceAvailability('room', ctx({ centrals, roomId: ' room-1 ' }))).toBe('taken');
      expect(centralRequestFor('room', ctx({ roomId: ' room-2 ' }))).toEqual({ kind: 'room', scopeRef: 'room-2' });
    });

    it('is not taken by a project or global central that happens to name the same text', () => {
      const centrals = running(central({ kind: 'project', scopeRef: 'room-1' }));
      expect(choiceAvailability('room', ctx({ centrals }))).toBe('open');
    });
  });

  describe('This project', () => {
    it('is absent without a folder, blank ones included', () => {
      expect(choiceAvailability('project', ctx({ folder: null }))).toBe('absent');
      expect(choiceAvailability('project', ctx({ folder: '' }))).toBe('absent');
      expect(choiceAvailability('project', ctx({ folder: '  ' }))).toBe('absent');
    });

    it('is open for a folder no central holds', () => {
      const centrals = running(central({ kind: 'project', scopeRef: '/work/other' }));
      expect(choiceAvailability('project', ctx({ centrals }))).toBe('open');
    });

    it('is taken once a project central holds the folder, trailing slashes and padding aside', () => {
      const centrals = running(central({ kind: 'project', scopeRef: '/work/app' }));
      expect(choiceAvailability('project', ctx({ centrals, folder: '/work/app' }))).toBe('taken');
      expect(choiceAvailability('project', ctx({ centrals, folder: '/work/app/' }))).toBe('taken');
      expect(choiceAvailability('project', ctx({ centrals, folder: '  /work/app//  ' }))).toBe('taken');
    });

    it('does not take /work/app2 or /work for /work/app (a folder is not its prefix)', () => {
      const centrals = running(central({ kind: 'project', scopeRef: '/work/app2' }), central({ centralId: 'c2', kind: 'project', scopeRef: '/work' }));
      expect(choiceAvailability('project', ctx({ centrals, folder: '/work/app' }))).toBe('open');
    });

    it('cannot tell `~/app` from the folder the server wrote down, and leaves that to the server', () => {
      const centrals = running(central({ kind: 'project', scopeRef: '/Users/me/app' }));
      expect(choiceAvailability('project', ctx({ centrals, folder: '~/app' }))).toBe('open');
    });
  });
});

describe('effectiveChoice', () => {
  it('keeps a choice that is open', () => {
    expect(effectiveChoice('global', ctx())).toBe('global');
    expect(effectiveChoice('room', ctx())).toBe('room');
    expect(effectiveChoice('project', ctx())).toBe('project');
  });

  it('falls back to Off for a choice its context no longer supports', () => {
    expect(effectiveChoice('room', ctx({ roomId: null }))).toBe('off');
    expect(effectiveChoice('project', ctx({ folder: '' }))).toBe('off');
  });

  it('falls back to Off for a scope that is now taken', () => {
    expect(effectiveChoice('global', ctx({ centrals: running(central()) }))).toBe('off');
  });

  it('keeps Off', () => {
    expect(effectiveChoice('off', ctx())).toBe('off');
  });
});

describe('centralRequestFor', () => {
  it('is nothing for Off', () => {
    expect(centralRequestFor('off', ctx())).toBeUndefined();
  });

  it('is { kind: "global" } for Global, with no scope', () => {
    expect(centralRequestFor('global', ctx())).toEqual({ kind: 'global' });
  });

  it('names the room for This room', () => {
    expect(centralRequestFor('room', ctx({ roomId: 'room-7' }))).toEqual({ kind: 'room', scopeRef: 'room-7' });
  });

  it('names the folder for This project, as typed but trimmed', () => {
    expect(centralRequestFor('project', ctx({ folder: '  ~/proj  ' }))).toEqual({ kind: 'project', scopeRef: '~/proj' });
  });

  it('is nothing for a choice that is absent or taken, so the request can never ask for it', () => {
    expect(centralRequestFor('room', ctx({ roomId: '' }))).toBeUndefined();
    expect(centralRequestFor('project', ctx({ folder: null }))).toBeUndefined();
    expect(centralRequestFor('global', ctx({ centrals: running(central()) }))).toBeUndefined();
  });

  it('never carries a centralId: a new central, not a relaunch', () => {
    for (const choice of ['global', 'room', 'project'] as const) {
      expect(centralRequestFor(choice, ctx())).not.toHaveProperty('centralId');
    }
  });
});

describe('launchSession with the request each choice makes', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ ok: true, terminalId: 't1' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    useSessionStore.setState({ selectSession: vi.fn(), selectedSessionId: null } as never);
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession, selectedSessionId: null } as never);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;

  const CASES: Array<[CentralChoice, unknown]> = [
    ['global', { kind: 'global' }],
    ['room', { kind: 'room', scopeRef: 'room-1' }],
    ['project', { kind: 'project', scopeRef: '/work/app' }],
  ];

  it.each(CASES)('carries `central` for %s', async (choice, expected) => {
    await launchSession({ workingDir: '/work/app', command: 'claude', forceNew: true, central: centralRequestFor(choice, ctx()) });

    expect(sentBody().central).toEqual(expected);
  });

  it('leaves `central` out for Off', async () => {
    await launchSession({ workingDir: '/work/app', command: 'claude', forceNew: true, central: centralRequestFor('off', ctx()) });

    expect(sentBody()).toEqual({ workingDir: '/work/app', command: 'claude', forceNew: true });
    expect(sentBody()).not.toHaveProperty('central');
  });
});

describe('folderKey and folderName', () => {
  it('make one name of one folder', () => {
    expect(folderKey('/a/b/')).toBe('/a/b');
    expect(folderKey('/a//b///')).toBe('/a/b');
    expect(folderKey('  /a/b  ')).toBe('/a/b');
    expect(folderKey('/')).toBe('/');
    expect(folderKey('///')).toBe('/');
    expect(folderKey('~/a')).toBe('~/a');
  });

  it('take the last folder', () => {
    expect(folderName('/Users/me/agent-manager')).toBe('agent-manager');
    expect(folderName('/Users/me/agent-manager/')).toBe('agent-manager');
    expect(folderName('C:\\work\\site')).toBe('site');
    expect(folderName('~/proj')).toBe('proj');
    expect(folderName('/')).toBe('/');
    expect(folderName('')).toBe('');
  });
});

describe('centralBadgeText', () => {
  it('reads ★ global for a global central', () => {
    expect(centralBadgeText({ kind: 'global', scopeRef: null })).toBe('★ global');
  });

  it('reads ★ room <name>, and ★ room when the room is not known', () => {
    expect(centralBadgeText({ kind: 'room', scopeRef: 'room-1' }, 'Backend')).toBe('★ room Backend');
    expect(centralBadgeText({ kind: 'room', scopeRef: 'room-1' }, undefined)).toBe('★ room');
    expect(centralBadgeText({ kind: 'room', scopeRef: 'room-1' }, '')).toBe('★ room');
  });

  it('reads ★ project <folder name>', () => {
    expect(centralBadgeText({ kind: 'project', scopeRef: '/Users/me/agent-manager' })).toBe('★ project agent-manager');
    expect(centralBadgeText({ kind: 'project', scopeRef: '/Users/me/agent-manager/' })).toBe('★ project agent-manager');
    expect(centralBadgeText({ kind: 'project', scopeRef: null })).toBe('★ project');
  });
});

describe('workersText (P4)', () => {
  it('counts a central’s own workers, singular for one and nothing for none', () => {
    expect(workersText(1)).toBe('1 worker');
    expect(workersText(3)).toBe('3 workers');
    expect(workersText(0)).toBe('');
    expect(workersText(-1)).toBe('');
    expect(workersText(2.5)).toBe('');
  });
});

describe('centralLabel', () => {
  it('names the scope for a screen reader, without the star', () => {
    expect(centralLabel({ kind: 'global', scopeRef: null })).toBe('Central session: global');
    expect(centralLabel({ kind: 'room', scopeRef: 'room-1' }, 'Backend')).toBe('Central session: room Backend');
    expect(centralLabel({ kind: 'room', scopeRef: 'room-1' })).toBe('Central session: room');
    expect(centralLabel({ kind: 'project', scopeRef: '/Users/me/app/' })).toBe('Central session: project app');
    expect(centralLabel({ kind: 'project', scopeRef: null })).toBe('Central session: project');
  });
});

describe('centralTooltip', () => {
  it('says the full scope', () => {
    expect(centralTooltip({ kind: 'global', scopeRef: null })).toContain('every session');
    expect(centralTooltip({ kind: 'room', scopeRef: 'room-1' }, 'Backend')).toContain('"Backend"');
    expect(centralTooltip({ kind: 'room', scopeRef: 'room-1' })).toContain('room');
    expect(centralTooltip({ kind: 'project', scopeRef: '/Users/me/agent-manager/' })).toContain('/Users/me/agent-manager/');
  });
});

describe('centralChoiceHint', () => {
  it('says what each choice reaches', () => {
    expect(centralChoiceHint('global', {})).toBe('Can reach every session on this Mac.');
    expect(centralChoiceHint('room', { roomName: 'Backend' })).toBe('Can reach the sessions in room "Backend".');
    expect(centralChoiceHint('project', { folder: '/work/app' })).toBe('Can reach the sessions in /work/app and below.');
  });

  it('says nothing for Off, or for a choice with no subject to name', () => {
    expect(centralChoiceHint('off', {})).toBeNull();
    expect(centralChoiceHint('room', {})).toBeNull();
    expect(centralChoiceHint('project', { folder: '' })).toBeNull();
  });
});
