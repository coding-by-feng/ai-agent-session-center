// sessionsModel.test.ts — the phone Sessions tab's model (AASC-40): sections, the
// one line that matters now, filters, search, group by status / room / project in
// the desktop's order, the host card's numbers and the connection path.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import type { Room } from '@/stores/roomStore';
import {
  connectionPath,
  filterCount,
  formatAge,
  groupSessions,
  isUnreadFinish,
  matchesFilter,
  matchesSearch,
  nowLine,
  statusSection,
  type GroupInput,
} from './sessionsModel';

const T = 1_000_000;

function mk(id: string, over: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    status: 'idle',
    title: id,
    projectName: 'proj',
    projectPath: '/w/proj',
    lastActivityAt: T,
    toolLog: [],
    responseLog: [],
    promptHistory: [],
    currentPrompt: '',
    ...over,
  } as unknown as Session;
}

const room = (id: string, name: string, sessionIds: string[], listOrder?: number): Room =>
  ({ id, name, sessionIds, collapsed: false, createdAt: 0, roomIndex: 0, listOrder }) as unknown as Room;

const input = (sessions: Session[], over: Partial<GroupInput> = {}): GroupInput => ({
  sessions,
  groupBy: 'status',
  filter: 'all',
  query: '',
  rooms: [],
  reads: {},
  now: T,
  ...over,
});

describe('statusSection', () => {
  it('puts approvals, questions and interrupted turns under Needs you', () => {
    expect(statusSection(mk('a', { status: 'approval' }))).toBe('needs-you');
    expect(statusSection(mk('a', { status: 'input' }))).toBe('needs-you');
    expect(statusSection(mk('a', { status: 'waiting', interruption: { kind: 'api', line: '529', at: 1 } as never }))).toBe('needs-you');
  });

  // Oct 23 2026: a session whose last answer asks you to reply "proceed" owes you a review; under
  // Idle it would fold away with the rest (IDLE_FOLD_AT), so it goes under Needs you.
  it('puts a session that asks you to proceed under Needs you, and counts it there', () => {
    const owes = mk('a', { status: 'idle', pendingProceedAt: T });
    expect(statusSection(owes)).toBe('needs-you');
    expect(statusSection(mk('b', { status: 'waiting', pendingProceedAt: T }), { b: T + 1 })).toBe('needs-you');
    expect(matchesFilter(owes, 'needs-you')).toBe(true);
    expect(matchesFilter(owes, 'working')).toBe(false);
    expect(filterCount([owes, mk('c', { status: 'idle' })], 'needs-you')).toBe(1);
  });

  it('puts working and starting sessions under Working', () => {
    expect(statusSection(mk('a', { status: 'working' }))).toBe('working');
    expect(statusSection(mk('a', { status: 'prompting' }))).toBe('working');
  });

  it('keeps a finished turn under Finished until it is read here, then Idle', () => {
    const s = mk('a', { status: 'waiting', lastActivityAt: T });
    expect(isUnreadFinish(s, {})).toBe(true);
    expect(statusSection(s, {})).toBe('finished');
    expect(statusSection(s, { a: T + 1 })).toBe('idle');
    // A turn that finished after the last read is unread again.
    expect(statusSection(mk('a', { status: 'waiting', lastActivityAt: T + 5 }), { a: T + 1 })).toBe('finished');
  });

  it('puts idle and connecting sessions under Idle', () => {
    expect(statusSection(mk('a', { status: 'idle' }))).toBe('idle');
    expect(statusSection(mk('a', { status: 'connecting' }))).toBe('idle');
  });
});

describe('nowLine', () => {
  it('says the pending ask for a waiting session', () => {
    expect(nowLine(mk('a', { status: 'approval', pendingToolDetail: 'npm run build' }))).toBe('Wants to run: npm run build');
    expect(nowLine(mk('a', { status: 'input', waitingDetail: 'Which phase?' }))).toBe('Asks: Which phase?');
  });

  it('says the running tool for a working session, else what it works on', () => {
    const working = mk('a', {
      status: 'working',
      promptHistory: [{ text: 'run the tests', timestamp: T - 10 }] as never,
      toolLog: [{ tool: 'Bash', input: 'npm test\nmore', timestamp: T }] as never,
    });
    expect(nowLine(working)).toBe('Bash: npm test');
    expect(nowLine(mk('a', { status: 'working', currentPrompt: 'fix the bug\nplease' }))).toBe('Working on: fix the bug');
    // A tool from before the current prompt is stale.
    const stale = mk('a', {
      status: 'working',
      currentPrompt: 'next thing',
      promptHistory: [{ text: 'next thing', timestamp: T + 10 }] as never,
      toolLog: [{ tool: 'Bash', input: 'old', timestamp: T }] as never,
    });
    expect(nowLine(stale)).toBe('Working on: next thing');
  });

  it('says the start of the last answer, else the last prompt', () => {
    expect(nowLine(mk('a', { status: 'waiting', responseLog: [{ text: '\nDone. Tests pass.\nMore', timestamp: T }] as never }))).toBe('Done. Tests pass.');
    expect(nowLine(mk('a', { status: 'idle', promptHistory: [{ text: 'hello', timestamp: T }] as never }))).toBe('You: hello');
    expect(nowLine(mk('a', { status: 'idle' }))).toBe('Ready for a prompt');
  });
});

describe('filters and search', () => {
  it('filters to the sessions that need you, or the working ones', () => {
    expect(matchesFilter(mk('a', { status: 'approval' }), 'needs-you')).toBe(true);
    expect(matchesFilter(mk('a', { status: 'working' }), 'needs-you')).toBe(false);
    expect(matchesFilter(mk('a', { status: 'working' }), 'working')).toBe(true);
    expect(matchesFilter(mk('a', { status: 'idle' }), 'working')).toBe(false);
    expect(matchesFilter(mk('a', { status: 'idle' }), 'all')).toBe(true);
  });

  it('counts each chip over live sessions only', () => {
    const list = [mk('a', { status: 'approval' }), mk('b', { status: 'working' }), mk('c', { status: 'ended' }), mk('d', { status: 'idle' })];
    expect(filterCount(list, 'all')).toBe(3);
    expect(filterCount(list, 'needs-you')).toBe(1);
    expect(filterCount(list, 'working')).toBe(1);
  });

  it('searches name, project and remark, every word', () => {
    const s = mk('a', { title: 'Payment fix', projectName: 'exmouth', remark: 'waiting on Kim' });
    expect(matchesSearch(s, '')).toBe(true);
    expect(matchesSearch(s, 'payment')).toBe(true);
    expect(matchesSearch(s, 'EXMOUTH')).toBe(true);
    expect(matchesSearch(s, 'kim')).toBe(true);
    expect(matchesSearch(s, 'payment kim')).toBe(true);
    expect(matchesSearch(s, 'payment bob')).toBe(false);
  });
});

describe('groupSessions', () => {
  it('lists Needs you, Working, Finished, Idle in that order and leaves ended sessions out', () => {
    const groups = groupSessions(input([
      mk('idle1', { status: 'idle' }),
      mk('done', { status: 'waiting' }),
      mk('busy', { status: 'working' }),
      mk('ask', { status: 'approval' }),
      mk('gone', { status: 'ended' }),
      mk('float', { status: 'working', isFloating: true }),
    ]));
    expect(groups.map((g) => g.title)).toEqual(['Needs you', 'Working', 'Finished', 'Idle']);
    expect(groups.map((g) => g.sessions.map((s) => s.sessionId))).toEqual([['ask'], ['busy'], ['done'], ['idle1']]);
  });

  it('orders Needs you longest-waiting first and the rest most recent first', () => {
    const groups = groupSessions(input([
      mk('a1', { status: 'approval', lastActivityAt: T + 5 }),
      mk('a2', { status: 'input', lastActivityAt: T + 1 }),
      mk('i1', { status: 'idle', lastActivityAt: T + 1 }),
      mk('i2', { status: 'idle', lastActivityAt: T + 9 }),
    ]));
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual(['a2', 'a1']);
    expect(groups[1].sessions.map((s) => s.sessionId)).toEqual(['i2', 'i1']);
  });

  it('applies the filter and the search before grouping', () => {
    const list = [mk('a', { status: 'approval', title: 'alpha' }), mk('b', { status: 'working', title: 'beta' }), mk('c', { status: 'idle', title: 'alpine' })];
    expect(groupSessions(input(list, { filter: 'working' })).flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual(['b']);
    expect(groupSessions(input(list, { query: 'alp' })).flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual(['a', 'c']);
  });

  it('groups by room in the rooms\' list order, room-less sessions last', () => {
    const list = [mk('a'), mk('b'), mk('c'), mk('d')];
    const rooms = [room('r2', 'Second', ['b'], 2), room('r1', 'First', ['a', 'c'], 1)];
    const groups = groupSessions(input(list, { groupBy: 'room', rooms }));
    expect(groups.map((g) => [g.kind, g.title, g.sessions.map((s) => s.sessionId)])).toEqual([
      ['room', 'First', ['a', 'c']],
      ['room', 'Second', ['b']],
      ['none', 'No room', ['d']],
    ]);
    expect(groups[0].room?.id).toBe('r1');
  });

  it('shows a room with no listed sessions in its slot (AASC-55: something to drop into), not while filtered or searched', () => {
    const list = [mk('a'), mk('b', { status: 'working' })];
    const rooms = [room('r1', 'First', ['a'], 0), room('empty', 'Empty', [], 1), room('r3', 'Third', ['b', 'gone'], 2)];
    const titles = (over: Partial<GroupInput>) => groupSessions(input(list, { groupBy: 'room', rooms, ...over }))
      .map((g) => `${g.title}:${g.sessions.length}`);
    // b is working, so it is also in Recent, first.
    expect(titles({})).toEqual(['Recent:1', 'First:1', 'Empty:0', 'Third:1']);
    const empty = groupSessions(input(list, { groupBy: 'room', rooms }))[2];
    expect(empty).toMatchObject({ key: 'room:empty', kind: 'room', room: { id: 'empty' } });
    expect(empty.color).toBeTruthy();
    expect(titles({ filter: 'working' })).toEqual(['Recent:1', 'Third:1']);
    expect(titles({ query: 'zzz' })).toEqual([]);
  });

  // The desktop rail's built-in RECENT frame, by its own rules (recentSessions.ts).
  describe('Recent, first when grouped by room', () => {
    const MIN = 60_000;
    const N = T + 120 * MIN; // the clock: T itself is too early to count back 30 min from
    const prompted = (at: number) => ({ promptHistory: [{ text: 'go', timestamp: at }] }) as Partial<Session>;
    const rooms = [room('r1', 'First', ['run', 'fresh', 'quiet', 'pin'], 0)];
    const list = [
      mk('quiet', { status: 'waiting', ...prompted(N - 31 * MIN) }),
      mk('fresh', { status: 'waiting', ...prompted(N - 5 * MIN) }),
      mk('run', { status: 'working', ...prompted(N - 20 * MIN) }),
      mk('pin', { status: 'idle', pinned: true, ...prompted(N - 25 * MIN) }),
      mk('loose', { status: 'approval' }),
      mk('gone', { status: 'ended', ...prompted(N - MIN) }),
    ];
    const byRoom = (over: Partial<GroupInput> = {}) => groupSessions(input(list, { groupBy: 'room', rooms, now: N, ...over }));

    it('lists the sessions with a running turn or work in the last 30 min: pinned first, then newest prompt', () => {
      const recent = byRoom().find((g) => g.kind === 'recent')!;
      expect(recent).toMatchObject({ key: 'recent', kind: 'recent', title: 'Recent' });
      expect(recent.sessions.map((s) => s.sessionId)).toEqual(['pin', 'fresh', 'run', 'loose']);
    });

    it('keeps each of them in its own room as well', () => {
      const groups = byRoom();
      expect(groups.map((g) => [g.title, g.sessions.map((s) => s.sessionId)])).toEqual([
        ['Pinned', ['pin']],
        ['Recent', ['pin', 'fresh', 'run', 'loose']],
        ['First', ['pin', 'run', 'fresh', 'quiet']], // the room's own order: pinned first
        ['No room', ['loose']],
      ]);
    });

    it('lets a session go when it has been quiet for the whole window, pinned or not', () => {
      // 6 min on, pin's last prompt is 31 min old; a running turn stays however old.
      expect(byRoom({ now: N + 6 * MIN }).find((g) => g.kind === 'recent')!.sessions.map((s) => s.sessionId)).toEqual(['fresh', 'run', 'loose']);
    });

    it('narrows with the filter and the search, and is left out when none is recent', () => {
      expect(byRoom({ filter: 'needs-you' })[0].sessions.map((s) => s.sessionId)).toEqual(['loose']);
      expect(byRoom({ query: 'fresh' }).map((g) => g.title)).toEqual(['Recent', 'First']);
      expect(byRoom({ query: 'quiet' }).map((g) => g.title)).toEqual(['First']);
    });

    it('is only in the By room view, as on the desktop', () => {
      for (const groupBy of ['status', 'project', 'activity'] as const) {
        expect(byRoom({ groupBy }).some((g) => g.kind === 'recent'), groupBy).toBe(false);
      }
    });

    // The desktop rail's built-in PINNED frame (Oct 22 2026): first, by the strip's own rule.
    describe('Pinned, before Recent', () => {
      const pinRooms = [room('r1', 'First', ['b', 'a'], 0)];
      const pins = [
        mk('a', { status: 'idle', pinned: true }),
        mk('b', { status: 'waiting', pinned: true }),
        mk('c', { status: 'idle' }),
        mk('d', { status: 'idle', pinned: true }),
        mk('e', { status: 'ended', pinned: true }),
      ];
      const pinned = (over: Partial<GroupInput> = {}) => groupSessions(input(pins, { groupBy: 'room', rooms: pinRooms, now: N, ...over }));

      it('lists the live pinned sessions first, each also in its room or under No room', () => {
        const groups = pinned();
        expect(groups[0]).toMatchObject({ key: 'pinned', kind: 'pinned', title: 'Pinned' });
        expect(groups[0].sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b', 'd']);
        expect(groups.find((g) => g.kind === 'room')!.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
        expect(groups.find((g) => g.kind === 'none')!.sessions.map((s) => s.sessionId)).toEqual(['d', 'c']); // pinned first, as in a room
      });

      it('narrows with the filter and the search, and is left out with none pinned', () => {
        expect(pinned({ query: 'c' }).some((g) => g.kind === 'pinned')).toBe(false);
        expect(pinned({ query: 'd' })[0].sessions.map((s) => s.sessionId)).toEqual(['d']);
        const unpinned = pins.map((s) => ({ ...s, pinned: false }));
        expect(groupSessions(input(unpinned, { groupBy: 'room', rooms: pinRooms, now: N })).some((g) => g.kind === 'pinned')).toBe(false);
      });

      it('is only in the By room view', () => {
        for (const groupBy of ['status', 'project', 'activity'] as const) {
          expect(pinned({ groupBy }).some((g) => g.kind === 'pinned'), groupBy).toBe(false);
        }
      });
    });

    // The desktop rail's built-in CENTRAL frame (Oct 27 2026): before Pinned, by the strip's own rule.
    describe('Central, before Pinned', () => {
      const centralRooms = [room('r1', 'First', ['a', 'b'], 0)];
      const marker = (centralId: string) => ({ centralId, kind: 'global' as const, scopeRef: null });
      const list = [
        mk('a', { status: 'idle', central: marker('c1'), pinned: true }),
        mk('b', { status: 'idle' }),
        mk('c', { status: 'waiting', central: marker('c2') }),
        mk('d', { status: 'ended', central: marker('c3') }),
      ];
      const central = (over: Partial<GroupInput> = {}) => groupSessions(input(list, { groupBy: 'room', rooms: centralRooms, now: N, ...over }));

      it('lists the live central sessions first, then Pinned; each also stays in its room', () => {
        const groups = central();
        expect(groups[0]).toMatchObject({ key: 'central', kind: 'central', title: 'Central' });
        expect(groups[0].sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'c']);
        expect(groups[1].kind).toBe('pinned');
        expect(groups.find((g) => g.kind === 'room')!.sessions.map((s) => s.sessionId)).toContain('a');
        expect(groups.find((g) => g.kind === 'none')!.sessions.map((s) => s.sessionId)).toEqual(['c']);
      });

      it('narrows with the search, and is left out with no central', () => {
        expect(central({ query: 'b' }).some((g) => g.kind === 'central')).toBe(false);
        expect(central({ query: 'c' })[0].sessions.map((s) => s.sessionId)).toEqual(['c']);
        const plain = list.map((s) => ({ ...s, central: undefined }));
        expect(groupSessions(input(plain, { groupBy: 'room', rooms: centralRooms, now: N })).some((g) => g.kind === 'central')).toBe(false);
      });

      it('is only in the By room view', () => {
        for (const groupBy of ['status', 'project', 'activity'] as const) {
          expect(central({ groupBy }).some((g) => g.kind === 'central'), groupBy).toBe(false);
        }
      });

      it('is left out while central sessions are off; each session stays in its room', () => {
        const groups = central({ showCentral: false });
        expect(groups.some((g) => g.kind === 'central')).toBe(false);
        expect(groups[0].kind).toBe('pinned');
        expect(groups.find((g) => g.kind === 'room')!.sessions.map((s) => s.sessionId)).toContain('a');
      });
    });
  });

  it('groups by project with where to start a session', () => {
    const list = [mk('a', { projectPath: '/w/app', projectName: 'app' }), mk('b', { projectPath: '/w/site', projectName: 'site' }), mk('c', { projectPath: '/w/app', projectName: 'app' })];
    const groups = groupSessions(input(list, { groupBy: 'project' }));
    expect(groups.map((g) => [g.kind, g.sessions.map((s) => s.sessionId)])).toEqual([['project', ['a', 'c']], ['project', ['b']]]);
    expect(groups[0].launchPath).toBe('/w/app');
    expect(groups[0].local).toBe(true);
  });
});

describe('connection', () => {
  it('names the path to the Mac from the page address', () => {
    expect(connectionPath('localhost')).toBe('this-mac');
    expect(connectionPath('127.0.0.1')).toBe('this-mac');
    expect(connectionPath('kason-mbp.tail1234.ts.net')).toBe('tailscale');
    expect(connectionPath('100.101.1.2')).toBe('tailscale');
    expect(connectionPath('192.168.4.21')).toBe('home');
    expect(connectionPath('10.0.0.5')).toBe('home');
    expect(connectionPath('kason-mbp.local')).toBe('home');
    expect(connectionPath('mac.aasc.work')).toBe('internet');
    expect(connectionPath('8.8.8.8')).toBe('internet');
  });
});

describe('formatAge', () => {
  it('says now, minutes, hours, days', () => {
    expect(formatAge(5_000)).toBe('now');
    expect(formatAge(4 * 60_000)).toBe('4m');
    expect(formatAge(2 * 3_600_000)).toBe('2h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
  });
});
