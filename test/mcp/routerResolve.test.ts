// test/mcp/routerResolve.test.ts — which project a task is about (resolveProject, exported by router.ts): the order the
// spec gives (a hinted or written path, a project named in the task, the room's projects, the most recently active
// folder), what each earns in confidence, and what never counts as evidence (a folder a central could not open, a
// path in a URL, words that only make up a longer project's name). Pure: the disk is a stub the test hands in.
import { describe, expect, it } from 'vitest';
import { resolveProject } from '../../server/mcp/router.js';
import { deepFreeze } from './readFixtures.js';
import { NOW } from './toolHarness.js';
import { AGENT, HOME, MIN, RANGI, SITE, project, resolveEnv } from './routerFixtures.js';

const projects = [project(AGENT), project(SITE, { lastActiveAt: NOW - 30 * MIN })];
const foldersOf = (r: { ranked: Array<{ folder: string }> }): string[] => r.ranked.map((p) => p.folder);

describe('resolveProject: a path', () => {
  it('a path in the task wins', () => {
    const r = resolveProject(`the site looks off, but the bug is in ${AGENT}/src/ledger.ts`, {}, projects, resolveEnv());

    expect(foldersOf(r).slice(0, 2)).toEqual([AGENT, SITE]);
    expect(r.ranked[0]).toMatchObject({ folder: AGENT, by: 'path' });
    expect(r.ranked[1]).toMatchObject({ folder: SITE, by: 'name' });
    expect(r.confidence).toBe('high');
  });

  it('reads ~/ with the home it is given, through punctuation and quotes', () => {
    for (const text of [
      'fix ~/code/agent-manager.',
      'look at "~/code/agent-manager", then stop',
      'in `~/code/agent-manager/src` there is a bug',
      '(see ~/code/agent-manager/README.md)',
    ]) {
      const r = resolveProject(text, {}, [project(SITE), project(AGENT)], resolveEnv());
      expect(r.ranked[0], text).toMatchObject({ folder: AGENT, by: 'path' });
      expect(r.confidence, text).toBe('high');
    }
  });

  it('a file below a known project is that project, the deepest known one when they nest', () => {
    const mono = `${HOME}/code/mono`;
    const web = `${mono}/packages/web`;
    const r = resolveProject(`rename the prop in ${web}/src/App.tsx`, {}, [project(mono), project(web)], resolveEnv());
    expect(r.ranked[0]).toMatchObject({ folder: web, by: 'path' });

    const above = resolveProject(`rename the prop in ${mono}/packages/api/src/a.ts`, {}, [project(mono), project(web)], resolveEnv());
    expect(above.ranked[0]).toMatchObject({ folder: mono, by: 'path' });
  });

  it('a file that does not exist yet still belongs to the known project it would sit in', () => {
    const r = resolveProject(`create ${AGENT}/src/brand-new.ts with a helper`, {}, projects, resolveEnv({ exists: () => false }));

    expect(r.ranked[0]).toMatchObject({ folder: AGENT, by: 'path' });
  });

  it('an existing folder that is not a known project counts when a central could open it', () => {
    const fresh = `${HOME}/scratch/new-idea`;
    const r = resolveProject(`start something in ${fresh}`, {}, projects, resolveEnv({ exists: (p) => p === fresh }));

    expect(r.ranked[0]).toMatchObject({ folder: fresh, by: 'path' });
    expect(r.confidence).toBe('high');
  });

  it('a path that is not there, or that a central could not open, is not evidence', () => {
    const tasks = [
      `read /etc/hosts and ${HOME}/.ssh/config`,
      'look at /tmp/out.log',
      `clean up ${HOME}/missing/folder`,
      `cd ${HOME} and list it`,
      'cd ~ and list it',
      'the route /api/sessions is slow',
    ];
    for (const text of tasks) {
      const r = resolveProject(text, {}, [], resolveEnv({ exists: (p) => !p.includes('missing') }));
      expect(r, text).toEqual({ ranked: [], confidence: 'none' });
    }
  });

  it('a URL is not a path', () => {
    const r = resolveProject('see https://example.com/code/agent-manager/issues', {}, [], resolveEnv());

    expect(r.confidence).toBe('none');
  });

  it('a file below a project that a central could not open, or that is gone, is not evidence either', () => {
    const junk = '/tmp/widget';
    const gone = `${HOME}/code/gone`;
    const list = [project(junk, { sources: ['history'], lastActiveAt: null }), project(gone, { sources: ['history'], lastActiveAt: null })];
    const env = resolveEnv({ exists: (p) => p !== gone && !p.startsWith(`${gone}/`) });

    expect(resolveProject(`fix ${junk}/src/a.ts and ${gone}/src/b.ts`, {}, list, env)).toEqual({ ranked: [], confidence: 'none' });
  });

  it('two different paths give two projects and medium confidence, in the order written', () => {
    const r = resolveProject(`copy ${SITE}/a.css into ${AGENT}/b.css`, {}, projects, resolveEnv());

    expect(foldersOf(r).slice(0, 2)).toEqual([SITE, AGENT]);
    expect(r.confidence).toBe('medium');
  });

  it('a path does not feed the project names: the folders along it are not mentions', () => {
    const code = `${HOME}/code`;
    const r = resolveProject(`fix ${AGENT}/src/x.ts`, {}, [project(code), project(AGENT)], resolveEnv());

    expect(foldersOf(r)).toContain(AGENT);
    expect(r.ranked.find((p) => p.folder === code)?.by).not.toBe('name');
    expect(r.ranked[0].folder).toBe(AGENT);
  });
});

describe('resolveProject: a name', () => {
  it('one name match gives high confidence', () => {
    const r = resolveProject('fix the flaky queue test in agent manager', {}, projects, resolveEnv());

    expect(r.ranked[0]).toMatchObject({ folder: AGENT, by: 'name' });
    expect(r.confidence).toBe('high');
  });

  it('two name matches give medium confidence', () => {
    const r = resolveProject('make the footer in the site match agent manager’s new theme', {}, projects, resolveEnv());

    expect(new Set(foldersOf(r).slice(0, 2))).toEqual(new Set([AGENT, SITE]));
    expect(r.ranked[0].by).toBe('name');
    expect(r.confidence).toBe('medium');
  });

  it('matches whole words, any case, whatever separates the words of the name', () => {
    for (const text of ['AGENT MANAGER is crashing', 'agent-manager is crashing', 'agent_manager is crashing', 'agent.manager is crashing', 'AgentManager is crashing', 'the agent   manager is crashing']) {
      const r = resolveProject(text, {}, projects, resolveEnv());
      expect(r.ranked[0], text).toMatchObject({ folder: AGENT, by: 'name' });
    }
  });

  it('does not match part of a word, or only some words of a longer name', () => {
    for (const text of ['the website is slow', 'the sitemap is wrong', 'the manager component is slow', 'an agent should do it']) {
      const r = resolveProject(text, {}, [project(AGENT, { lastActiveAt: null }), project(SITE, { lastActiveAt: null })], resolveEnv());
      expect(r.ranked, text).toEqual([]);
    }
  });

  it('words that only make up a longer project’s name do not match the shorter project', () => {
    const both = [project(SITE), project(RANGI)];

    const longer = resolveProject('update the rangi site footer', {}, both, resolveEnv());
    expect(foldersOf(longer).slice(0, 1)).toEqual([RANGI]);
    expect(longer.ranked.filter((p) => p.by === 'name').map((p) => p.folder)).toEqual([RANGI]);
    expect(longer.confidence).toBe('high');

    const shorter = resolveProject('update the site footer', {}, both, resolveEnv());
    expect(shorter.ranked.filter((p) => p.by === 'name').map((p) => p.folder)).toEqual([SITE]);
  });

  it('a mention that stands alone names the shorter project too, whichever comes first, and the longer name ranks higher', () => {
    // The shorter name's project is the more recent one: ranking by name length, not by recency, puts RANGI first.
    const both = [project(SITE, { lastActiveAt: NOW - MIN }), project(RANGI, { lastActiveAt: NOW - 60 * MIN })];

    for (const text of ['the site footer, then the rangi site footer', 'the rangi site footer, then the site footer']) {
      const r = resolveProject(text, {}, both, resolveEnv());
      expect(r.ranked.filter((p) => p.by === 'name').map((p) => p.folder), text).toEqual([RANGI, SITE]);
    }
  });

  it('a name written together does not hold the word after it', () => {
    const tools = `${HOME}/code/tools`;

    const r = resolveProject('AgentManager tools are slow', {}, [project(AGENT), project(tools)], resolveEnv());

    expect(r.ranked.filter((p) => p.by === 'name').map((p) => p.folder)).toEqual([AGENT, tools]);
  });

  it('a longer name that nobody could open does not hold the shorter name’s mention', () => {
    const list = [project(RANGI, { sources: ['history'] }), project(SITE)];

    const r = resolveProject('update the rangi site footer', {}, list, resolveEnv({ exists: (p) => p !== RANGI }));

    expect(r.ranked.filter((p) => p.by === 'name').map((p) => p.folder)).toEqual([SITE]);
  });

  it('names that spell the same letters with different words are different names', () => {
    const spaced = `${HOME}/code/web-app`;
    const joined = `${HOME}/code/webapp`;

    for (const list of [[project(joined), project(spaced)], [project(spaced), project(joined)]]) {
      const apart = resolveProject('fix the web app', {}, list, resolveEnv());
      expect(apart.ranked.filter((p) => p.by === 'name').map((p) => p.folder)).toEqual([spaced]);
    }
  });

  it('two projects with one name are two matches, the more recent first', () => {
    const other = `${HOME}/work/site`;
    const r = resolveProject('the site needs a new logo', {}, [project(other, { lastActiveAt: NOW - 90 * MIN }), project(SITE, { lastActiveAt: NOW - MIN })], resolveEnv());

    expect(foldersOf(r).slice(0, 2)).toEqual([SITE, other]);
    expect(r.confidence).toBe('medium');
  });

  it('a name of fewer than three letters is not matched', () => {
    const ee = `${HOME}/code/ee`;
    const r = resolveProject('ee is where it breaks', {}, [project(ee, { lastActiveAt: null })], resolveEnv());

    expect(r.ranked).toEqual([]);
  });

  it('a project a central could not open, or that is gone, is not matched by name; a live one still is', () => {
    const hidden = `${HOME}/.hidden/gizmo`;
    const gone = `${HOME}/code/gadget`;
    const junk = '/tmp/widget';
    const live = '/tmp/gizmo-live';
    const text = 'gizmo gadget widget and gizmo live all need work';
    const list = [
      project(hidden, { sources: ['history'], lastActiveAt: null }),
      project(gone, { sources: ['history'], lastActiveAt: null }),
      project(junk, { sources: ['history'], lastActiveAt: null }),
      project(live, { sources: ['live'] }),
    ];

    const r = resolveProject(text, {}, list, resolveEnv({ exists: (p) => p !== gone }));

    expect(r.ranked.filter((p) => p.by === 'name').map((p) => p.folder)).toEqual([live]);
  });

  it('a known hidden project is matched when the launch rule knows it', () => {
    const hidden = `${HOME}/.openclaw/claw`;
    const r = resolveProject('work on claw today', {}, [project(hidden, { sources: ['discovered'], lastActiveAt: null })], resolveEnv({ known: [hidden] }));

    expect(r.ranked[0]).toMatchObject({ folder: hidden, by: 'name' });
  });
});

describe('resolveProject: hints', () => {
  it('a hinted folder that exists and can be opened is first and high, whatever the task says', () => {
    const r = resolveProject('fix the site footer', { folder: AGENT }, projects, resolveEnv());

    expect(r.ranked[0]).toMatchObject({ folder: AGENT, by: 'hint' });
    expect(r.confidence).toBe('high');
    expect(foldersOf(r)).toContain(SITE);
  });

  it('a hinted folder is exact: a folder inside a known project is not rounded up to it', () => {
    const sub = `${AGENT}/packages/web`;
    const r = resolveProject('do it', { folder: sub }, projects, resolveEnv());

    expect(r.ranked[0]).toMatchObject({ folder: sub, by: 'hint' });
  });

  it('~/ in a hint means the home it is given', () => {
    expect(resolveProject('x', { folder: '~/code/site' }, projects, resolveEnv()).ranked[0]).toMatchObject({ folder: SITE, by: 'hint' });
  });

  it('a hinted folder that is missing, or that a central could not open, is no evidence at all', () => {
    for (const folder of [`${HOME}/code/missing`, HOME, '/tmp/x', `${HOME}/.ssh`, 'relative/dir']) {
      const r = resolveProject('nothing to go on', { folder }, [], resolveEnv({ exists: (p) => !p.includes('missing') }));
      expect(r, folder).toEqual({ ranked: [], confidence: 'none' });
    }
  });

  it('a hinted folder that is a live project counts even where a central could not open one', () => {
    const r = resolveProject('x', { folder: '/tmp/scratch' }, [project('/tmp/scratch')], resolveEnv());

    expect(r.ranked[0]).toMatchObject({ folder: '/tmp/scratch', by: 'hint' });
  });

  it('a hinted name matches like a name in the task, and says so', () => {
    const r = resolveProject('unrelated words', { name: 'Agent-Manager' }, projects, resolveEnv());

    expect(r.ranked[0]).toMatchObject({ folder: AGENT, by: 'hint' });
    expect(r.confidence).toBe('high');
  });

  it('a hinted name that matches several projects is medium; one that matches none is no hint', () => {
    const several = resolveProject('x', { name: 'site' }, [project(SITE), project(`${HOME}/work/site`)], resolveEnv());
    expect(several.ranked.filter((p) => p.by === 'hint')).toHaveLength(2);
    expect(several.confidence).toBe('medium');

    const none = resolveProject('x', { name: 'nothing like it' }, projects, resolveEnv());
    expect(none.ranked.some((p) => p.by === 'hint')).toBe(false);
  });

  it('a hinted folder comes before a hinted name', () => {
    const r = resolveProject('x', { folder: SITE, name: 'agent manager' }, projects, resolveEnv());

    expect(foldersOf(r).slice(0, 2)).toEqual([SITE, AGENT]);
  });
});

describe('resolveProject: the room, the most recent folder, nothing', () => {
  const inRoom = project(SITE, { roomIds: ['r1'], lastActiveAt: NOW - 60 * MIN });
  const newerOutside = project(AGENT, { lastActiveAt: NOW - MIN });

  it('a room central tries its room’s projects first, with medium confidence', () => {
    const r = resolveProject('tidy up the backlog', {}, [newerOutside, inRoom], resolveEnv({ central: { kind: 'room', scopeRef: 'r1' } }));

    expect(r.ranked[0]).toMatchObject({ folder: SITE, by: 'room' });
    expect(r.confidence).toBe('medium');
    expect(foldersOf(r)).toEqual([SITE, AGENT]);
  });

  it('a room’s project that is gone, or that a central could not open, is not offered', () => {
    const gone = project(SITE, { sources: ['history'], roomIds: ['r1'], lastActiveAt: null });
    const here = project(AGENT, { sources: ['history'], roomIds: ['r1'], lastActiveAt: null });

    const r = resolveProject('tidy up the backlog', {}, [gone, here], resolveEnv({ central: { kind: 'room', scopeRef: 'r1' }, exists: (p) => p !== SITE }));

    expect(foldersOf(r)).toEqual([AGENT]);
    expect(r.ranked[0].by).toBe('room');
  });

  it('a name in the task still comes before the room’s projects', () => {
    const r = resolveProject('tidy up agent manager', {}, [newerOutside, inRoom], resolveEnv({ central: { kind: 'room', scopeRef: 'r1' } }));

    expect(r.ranked[0]).toMatchObject({ folder: AGENT, by: 'name' });
    expect(r.confidence).toBe('high');
  });

  it('a global central does not look at rooms: it falls to the most recently active folder, low', () => {
    const r = resolveProject('tidy up the backlog', {}, [inRoom, newerOutside], resolveEnv());

    expect(foldersOf(r)).toEqual([AGENT, SITE]);
    expect(r.ranked[0].by).toBe('recent');
    expect(r.confidence).toBe('low');
  });

  it('projects with no recorded activity are never guessed at', () => {
    const quiet = [project(AGENT, { lastActiveAt: null, sources: ['history'] }), project(SITE, { lastActiveAt: null, sources: ['discovered'] })];

    expect(resolveProject('tidy up the backlog', {}, quiet, resolveEnv())).toEqual({ ranked: [], confidence: 'none' });
  });

  it('no projects at all is none', () => {
    expect(resolveProject('do something', {}, [], resolveEnv())).toEqual({ ranked: [], confidence: 'none' });
  });
});

describe('resolveProject: a project central', () => {
  const env = resolveEnv({ central: { kind: 'project', scopeRef: AGENT } });

  it('is always its own folder, high, whatever the task or the hints say', () => {
    const r = resolveProject(`move it to ${SITE} (the site)`, { folder: SITE, name: 'site' }, [project(AGENT), project(SITE)], env);

    expect(r).toEqual({ ranked: [{ folder: AGENT, score: 100, why: expect.stringMatching(/own project/), by: 'own' }], confidence: 'high' });
  });

  it('is its folder even when the index does not list it', () => {
    expect(resolveProject('x', {}, [], env).ranked[0]).toMatchObject({ folder: AGENT, by: 'own' });
  });

  it('with no folder to hold it to resolves nothing', () => {
    expect(resolveProject('x', {}, projects, resolveEnv({ central: { kind: 'project', scopeRef: null } }))).toEqual({ ranked: [], confidence: 'none' });
  });
});

describe('resolveProject: the answer', () => {
  it('lists at most ten, best first, each with a lower or equal score and a reason', () => {
    const many = Array.from({ length: 30 }, (_, i) => project(`${HOME}/code/p${String(i).padStart(2, '0')}x`, { lastActiveAt: NOW - i * MIN }));
    const r = resolveProject(`see ${many[7].folder}`, {}, many, resolveEnv());

    expect(r.ranked).toHaveLength(10);
    expect(r.ranked[0].folder).toBe(many[7].folder);
    for (let i = 1; i < r.ranked.length; i += 1) expect(r.ranked[i].score).toBeLessThanOrEqual(r.ranked[i - 1].score);
    expect(r.ranked.every((p) => p.why.length > 0)).toBe(true);
    expect(new Set(foldersOf(r)).size).toBe(10);
  });

  it('names a folder once, at its best reason', () => {
    const r = resolveProject(`agent manager, again ${AGENT}/x and agent manager`, {}, projects, resolveEnv());

    expect(foldersOf(r).filter((f) => f === AGENT)).toHaveLength(1);
    expect(r.ranked[0].by).toBe('path');
  });

  it('changes nothing it is given', () => {
    const frozen = deepFreeze([project(AGENT), project(SITE)]);

    expect(() => resolveProject(`fix ${AGENT}/a.ts in agent manager`, { name: 'site' }, frozen, deepFreeze(resolveEnv()))).not.toThrow();
  });

  it('asks the disk only about the projects that matter, never about every project it holds', () => {
    const many = Array.from({ length: 2_000 }, (_, i) =>
      project(`${HOME}/code/proj-${i}-lib`, { sources: ['history'], lastActiveAt: i < 20 ? NOW - i : null }),
    );
    const asked: string[] = [];
    const env = resolveEnv({ exists: (p) => (asked.push(p), true) });

    // Twenty have a time; only as many as the answer lists (ten) are looked at.
    resolveProject('nothing in this task names any project at all', {}, many, env);
    expect(asked).toHaveLength(10);

    asked.length = 0;
    const r = resolveProject('look at proj 41 lib today', {}, many, env);
    expect(r.ranked[0]).toMatchObject({ folder: `${HOME}/code/proj-41-lib`, by: 'name' });
    expect(asked.length).toBeLessThanOrEqual(11);
    expect(asked).toContain(`${HOME}/code/proj-41-lib`);
  });

  it('reads no more than 60 000 characters of a task, or of a hinted name', () => {
    const only = [project(AGENT, { lastActiveAt: null })];
    const inside = 'x '.repeat(29_990);
    const beyond = 'x '.repeat(30_000);

    expect(resolveProject(`${inside}agent manager`, {}, only, resolveEnv()).ranked[0]).toMatchObject({ folder: AGENT, by: 'name' });
    expect(resolveProject(`${beyond}agent manager`, {}, only, resolveEnv()).ranked).toEqual([]);

    expect(resolveProject('do it', { name: `${inside}agent manager` }, only, resolveEnv()).ranked[0]).toMatchObject({ folder: AGENT, by: 'hint' });
    expect(resolveProject('do it', { name: `${beyond}agent manager` }, only, resolveEnv()).ranked).toEqual([]);
  });

  // No clock in here: how much work a long task costs is counted in routerResolveWork.test.ts, in operations.
  it('answers a very long task over thousands of projects without trouble', () => {
    const many = Array.from({ length: 3_000 }, (_, i) => project(`${HOME}/code/proj-${i}-lib`, { sources: ['history'], lastActiveAt: NOW - i }));
    // 27 000 characters either side of the mention: a task near the ledger's 60 000-character limit.
    const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(700);
    const asked: string[] = [];

    const r = resolveProject(`${filler} please look at proj 41 lib today ${filler}`, {}, many, resolveEnv({ exists: (p) => (asked.push(p), true) }));

    expect(r.ranked[0]).toMatchObject({ folder: `${HOME}/code/proj-41-lib`, by: 'name' });
    expect(r.ranked).toHaveLength(10);
    expect(r.confidence).toBe('high');
    // The one project named, and the ten most recent that fill the rest of the answer: never all three thousand.
    expect(asked.length).toBeLessThanOrEqual(11);
  });
});
