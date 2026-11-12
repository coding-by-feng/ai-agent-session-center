// Oct 29 2026: RESOURCES → Projects is one list. This Mac's folders come first, in the server's
// /known-projects order, each merged with its saved project, favourites leading; the saved
// projects with no checkout here follow. Search, ♥ and tags narrow it.
import { describe, expect, it } from 'vitest';
import type {
  LocalProject,
  ProjectFolder,
  ProjectMeta,
  ProjectRecord,
} from '@/types/cloudProjects';
import {
  applyMetaChange,
  buildProjectRows,
  displayPath,
  filterProjectRows,
  folderName,
  mergeMetas,
  projectTagChoices,
  withPendingMeta,
  type ProjectRow,
} from './projectList';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const repo = (name: string, branch = 'main') => ({
  provider: 'github' as const,
  owner: 'me',
  name,
  url: `https://github.com/me/${name}`,
  branch,
});
const project = (n: number, name: string): ProjectRecord => ({
  id: uuid(n),
  version: 1,
  name,
  repository: repo(name),
  description: '',
  resources: [],
  deleted: false,
});
const folder = (path: string, fields: Partial<ProjectFolder> = {}): ProjectFolder => ({
  path,
  repository: null,
  projectId: null,
  recent: 0,
  lastActivityAt: null,
  ...fields,
});
const at = (path: string | null, state: LocalProject['state'] = 'ready'): LocalProject => ({
  state: path ? state : 'missing',
  branch: path ? 'main' : null,
  openUrl: path ? `/project-browser?path=${encodeURIComponent(path)}` : null,
  localProjectId: null,
  path,
  ahead: 0,
  behind: 0,
  account: null,
  agentActive: false,
});
const meta = (n: number, fields: Partial<ProjectMeta> = {}): ProjectMeta => ({
  projectId: uuid(n),
  version: 1,
  favorite: false,
  tags: [],
  ...fields,
});
const keys = (rows: ProjectRow[]) =>
  rows.map((r) => (r.kind === 'saved' ? `saved:${r.project.name}` : `${r.state}:${r.folder.path}`));

const app = project(1, 'app'),
  tools = project(2, 'tools'),
  notes = project(3, 'notes'),
  site = project(4, 'site');

describe('buildProjectRows', () => {
  it('lists the folders in the server’s order, each saved one as its project', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/app', {
          repository: repo('app'),
          projectId: app.id,
          recent: 5,
          lastActivityAt: 9,
        }),
        folder('/h/scratch', { repository: repo('scratch'), recent: 2, lastActivityAt: 8 }),
        folder('/h/drafts', { recent: 1, lastActivityAt: 7 }),
      ],
      projects: [app],
      locals: { [app.id]: at('/h/app') },
      metas: {},
    });
    expect(keys(rows)).toEqual(['saved:app', 'unsaved:/h/scratch', 'plain:/h/drafts']);
    expect(rows[0]).toMatchObject({ kind: 'saved', path: '/h/app', lastActivityAt: 9, meta: null });
  });

  it('puts favourites first, then the saved projects not on this Mac (favourites, then by name)', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 5 }),
        folder('/h/tools', { repository: repo('tools'), projectId: tools.id, recent: 1 }),
        folder('/h/drafts', { recent: 3 }),
      ],
      projects: [site, notes, app, tools, project(5, 'blog')],
      locals: {
        [app.id]: at('/h/app'),
        [tools.id]: at('/h/tools'),
        [notes.id]: at(null),
        [site.id]: at(null),
        [uuid(5)]: at(null),
      },
      metas: { [tools.id]: meta(2, { favorite: true }), [site.id]: meta(4, { favorite: true }) },
    });
    expect(keys(rows)).toEqual([
      'saved:tools',
      'saved:app',
      'plain:/h/drafts',
      'saved:site',
      'saved:blog',
      'saved:notes',
    ]);
  });

  it('counts a checkout no agent worked in as here, after the folders that were used', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 1 }),
        folder('/h/a-old'),
        folder('/h/z-old'),
      ],
      projects: [app, tools],
      locals: { [app.id]: at('/h/app'), [tools.id]: at('/h/m-cloned') },
      metas: {},
    });
    expect(keys(rows)).toEqual(['saved:app', 'plain:/h/a-old', 'saved:tools', 'plain:/h/z-old']);
  });

  it('places a saved project at its first folder while its checkout is still being read', () => {
    const rows = buildProjectRows({
      folders: [folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 1 })],
      projects: [app],
      locals: {},
      metas: {},
    });
    expect(keys(rows)).toEqual(['saved:app']);
    expect(rows[0]).toMatchObject({ path: '/h/app' });
  });

  it('offers Link when two folders hold one saved project and neither is linked', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 2 }),
        folder('/h/app-2', { repository: repo('app'), projectId: app.id, recent: 1 }),
      ],
      projects: [app],
      locals: { [app.id]: at(null) },
      metas: {},
    });
    // The two folders stand for it: no "Not on this device" row offering a third copy.
    expect(keys(rows)).toEqual(['unlinked:/h/app', 'unlinked:/h/app-2']);
  });

  // Code review, Oct 29 2026: a checkout moved or deleted on this Mac held the project still, so
  // the real clone read "Another copy" with nothing to do.
  it('a checkout that is gone does not hold its project; the clone left offers itself', () => {
    const rows = buildProjectRows({
      folders: [folder('/h/app-2', { repository: repo('app'), recent: 1 })],
      projects: [app],
      locals: { [app.id]: at('/h/app-gone', 'missing') },
      metas: {},
    });
    expect(keys(rows)).toEqual(['unlinked:/h/app-2']);
  });

  it('gives the folders that stand for a project its ♥ and tags', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/drafts', { recent: 9 }),
        folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 2 }),
        folder('/h/app-2', { repository: repo('app'), projectId: app.id, recent: 1 }),
      ],
      projects: [app],
      locals: { [app.id]: at(null) },
      metas: { [app.id]: meta(1, { favorite: true, tags: ['work'] }) },
    });
    const both = ['unlinked:/h/app', 'unlinked:/h/app-2'];
    expect(keys(rows)).toEqual([...both, 'plain:/h/drafts']);
    const none = { query: '', favOnly: false, tags: [] };
    expect(keys(filterProjectRows(rows, { ...none, favOnly: true }))).toEqual(both);
    expect(keys(filterProjectRows(rows, { ...none, tags: ['work'] }))).toEqual(both);
    expect(keys(filterProjectRows(rows, { ...none, query: '#work' }))).toEqual(both);
    // One project, however many folders stand for it.
    expect(projectTagChoices(rows)).toEqual([{ tag: 'work', count: 1 }]);
  });

  it('shows another checkout of a linked project as a copy, never a second project row', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/app-2', { repository: repo('app'), projectId: app.id, recent: 3 }),
        folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 1 }),
      ],
      projects: [app],
      locals: { [app.id]: at('/h/app') },
      metas: {},
    });
    expect(keys(rows)).toEqual(['copy:/h/app-2', 'saved:app']);
  });

  it('takes the folder a project is linked to as that project, whatever its origin says now', () => {
    const rows = buildProjectRows({
      folders: [folder('/h/app', { repository: repo('other'), recent: 1 })],
      projects: [app],
      locals: { [app.id]: at('/h/app', 'wrong-remote') },
      metas: {},
    });
    expect(keys(rows)).toEqual(['saved:app']);
  });

  it('matches a folder to its saved project by repository and branch, not only by the server’s id', () => {
    const rows = buildProjectRows({
      folders: [
        folder('/h/app', { repository: repo('app'), recent: 2 }),
        folder('/h/app-dev', { repository: repo('app', 'dev'), recent: 1 }),
      ],
      projects: [app],
      locals: {},
      metas: {},
    });
    expect(keys(rows)).toEqual(['saved:app', 'unsaved:/h/app-dev']);
  });

  it('treats a folder whose saved project is not in the list as unsaved', () => {
    const rows = buildProjectRows({
      folders: [folder('/h/app', { repository: repo('app'), projectId: app.id })],
      projects: [],
      locals: {},
      metas: {},
    });
    expect(keys(rows)).toEqual(['unsaved:/h/app']);
  });
});

describe('filterProjectRows', () => {
  const rows = buildProjectRows({
    folders: [
      folder('/h/app', { repository: repo('app'), projectId: app.id, recent: 3 }),
      folder('/h/scratch-api', { repository: repo('scratch-api', 'dev'), recent: 2 }),
      folder('/h/Drafts', { recent: 1 }),
    ],
    projects: [app, tools],
    locals: { [app.id]: at('/h/app'), [tools.id]: at(null) },
    metas: {
      [app.id]: meta(1, { favorite: true, tags: ['work', 'web'] }),
      [tools.id]: meta(2, { tags: ['work'] }),
    },
  });
  const none = { query: '', favOnly: false, tags: [] };

  it('searches names, paths, repositories, branches and tags, ignoring case and a leading #', () => {
    expect(keys(filterProjectRows(rows, { ...none, query: 'drafts' }))).toEqual([
      'plain:/h/Drafts',
    ]);
    expect(keys(filterProjectRows(rows, { ...none, query: ' DEV ' }))).toEqual([
      'unsaved:/h/scratch-api',
    ]);
    expect(keys(filterProjectRows(rows, { ...none, query: '#web' }))).toEqual(['saved:app']);
    expect(keys(filterProjectRows(rows, { ...none, query: 'me/tools' }))).toEqual(['saved:tools']);
  });

  it('keeps only favourites, and any of the chosen tags', () => {
    expect(keys(filterProjectRows(rows, { ...none, favOnly: true }))).toEqual(['saved:app']);
    expect(keys(filterProjectRows(rows, { ...none, tags: ['work'] }))).toEqual([
      'saved:app',
      'saved:tools',
    ]);
    expect(keys(filterProjectRows(rows, { ...none, tags: ['web', 'nope'] }))).toEqual([
      'saved:app',
    ]);
  });

  it('counts each tag over the saved projects, most used first', () => {
    expect(projectTagChoices(rows)).toEqual([
      { tag: 'work', count: 2 },
      { tag: 'web', count: 1 },
    ]);
  });
});

it('displayPath writes the home folder as ~', () => {
  expect(displayPath('/Users/me/code/app', '/Users/me')).toBe('~/code/app');
  expect(displayPath('/Users/me', '/Users/me')).toBe('~');
  expect(displayPath('/Users/meow/app', '/Users/me')).toBe('/Users/meow/app');
  expect(displayPath('/Users/me/app', null)).toBe('/Users/me/app');
});

it('folderName is the last folder of a path', () => {
  expect(folderName('/Users/me/code/app')).toBe('app');
  expect(folderName('/Users/me/code/app/')).toBe('app');
  expect(folderName('/')).toBe('/');
});

it('applyMetaChange shows a ♥ or tag change before the cloud answers', () => {
  const before = meta(1, { tags: ['web', 'work'] });
  expect(applyMetaChange(before, { favorite: true })).toEqual({ ...before, favorite: true });
  expect(applyMetaChange(before, { addTags: ['ops', 'web'], removeTags: ['work'] })).toEqual({
    ...before,
    tags: ['ops', 'web'],
  });
  expect(applyMetaChange(null, { addTags: ['ops'] }, uuid(9))).toEqual(
    meta(9, { version: 1, tags: ['ops'] }),
  );
});

// Code review, Oct 29 2026: a row shows the cloud's last answer with the changes still on their way,
// and a reload read before a change landed does not undo it.
it('withPendingMeta applies the changes on their way over the last answer, in order', () => {
  const confirmed = { [uuid(1)]: meta(1, { version: 4, tags: ['web'] }) };
  expect(withPendingMeta(confirmed, {})).toEqual(confirmed);
  expect(
    withPendingMeta(confirmed, {
      [uuid(1)]: [{ favorite: true }, { favorite: false }, { addTags: ['ops'] }],
      [uuid(2)]: [{ favorite: true }],
      [uuid(3)]: [],
    }),
  ).toEqual({
    [uuid(1)]: meta(1, { version: 4, tags: ['ops', 'web'] }),
    [uuid(2)]: meta(2, { favorite: true }),
  });
});

it('mergeMetas keeps the newer answer per project, and what only one side has', () => {
  expect(
    mergeMetas(
      { [uuid(1)]: meta(1, { version: 5, favorite: true }), [uuid(2)]: meta(2, { version: 2 }) },
      { [uuid(1)]: meta(1, { version: 4 }), [uuid(3)]: meta(3, { version: 1, tags: ['x'] }) },
    ),
  ).toEqual({
    [uuid(1)]: meta(1, { version: 5, favorite: true }),
    [uuid(2)]: meta(2, { version: 2 }),
    [uuid(3)]: meta(3, { version: 1, tags: ['x'] }),
  });
  expect(
    mergeMetas({ [uuid(1)]: meta(1, { version: 5 }) }, { [uuid(1)]: meta(1, { version: 6, favorite: true }) }),
  ).toEqual({ [uuid(1)]: meta(1, { version: 6, favorite: true }) });
});
