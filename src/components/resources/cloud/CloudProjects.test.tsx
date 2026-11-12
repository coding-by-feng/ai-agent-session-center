// RESOURCES → Projects (AASC-63; one list since Oct 29 2026): every project folder on this Mac,
// most used first, merged with the saved GitHub projects; then the saved projects not on this
// Mac. Each row has one button; the ⋯ menu holds the rest; ♥ and tags live in AASC Cloud.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, beforeEach, afterEach } from 'vitest';
import CloudProjects from './CloudProjects';
import { CloudContext } from './cloudSession';
import { cloudApi } from '@/lib/cloudApi';
import { useUiStore } from '@/stores/uiStore';
import type { CloudStatus } from '@/types/cloud';
import type { LocalProject, ProjectFolder, ProjectMeta } from '@/types/cloudProjects';

const id = '00000000-0000-4000-8000-000000000001',
  siteId = '00000000-0000-4000-8000-000000000002';
const connection = {
  backendOrigin: 'https://fixture.invalid',
  accountId: id,
  generation: 1,
  deviceId: id,
  deviceName: 'fixture',
};
const github = (name: string, branch = 'main') => ({
  provider: 'github' as const,
  owner: 'example',
  name,
  url: `https://github.com/example/${name}`,
  branch,
});
const record = (pid: string, name: string) => ({
  id: pid,
  version: 1,
  name,
  repository: github(name),
  description: 'Old description, no longer shown',
  resources: [],
  deleted: false,
});
const project = record(id, 'project'),
  site = record(siteId, 'site');
const home = '/Users/me',
  checkout = '/Users/me/code/project';
const local = (fields: Partial<LocalProject>): LocalProject => ({
  state: 'missing',
  branch: null,
  openUrl: null,
  localProjectId: null,
  path: null,
  ahead: null,
  behind: null,
  account: null,
  agentActive: false,
  ...fields,
});
const linked = (fields: Partial<LocalProject> = {}) =>
  local({
    state: 'ready',
    branch: 'main',
    openUrl: `/project-browser?path=${encodeURIComponent(checkout)}`,
    localProjectId: 'project-1',
    path: checkout,
    ahead: 0,
    behind: 0,
    ...fields,
  });
const folder = (path: string, fields: Partial<ProjectFolder> = {}): ProjectFolder => ({
  path,
  repository: null,
  projectId: null,
  recent: 0,
  lastActivityAt: null,
  ...fields,
});
const FOLDERS = [
  folder(checkout, { repository: github('project'), projectId: id, recent: 4 }),
  folder('/Users/me/code/scratch', { repository: github('scratch', 'dev'), recent: 2 }),
  folder('/Users/me/notes', { recent: 1 }),
];
beforeEach(() => {
  localStorage.clear();
  // The view is a store choice that outlives a test: each starts with cards, the default.
  useUiStore.setState({ projectViewMode: 'card' });
  vi.spyOn(cloudApi, 'listProjects').mockResolvedValue({
    items: [project, site],
    nextCursor: null,
  });
  vi.spyOn(cloudApi, 'projectFolders').mockResolvedValue({ home, items: FOLDERS });
  vi.spyOn(cloudApi, 'projectMeta').mockResolvedValue({ available: true, items: [] });
  vi.spyOn(cloudApi, 'localProject').mockImplementation(async (pid) =>
    pid === id ? linked() : local({}),
  );
  vi.spyOn(cloudApi, 'checkProject').mockResolvedValue(linked());
  vi.spyOn(cloudApi, 'githubAccounts').mockResolvedValue({
    installed: true,
    accounts: [
      { login: 'octo', active: true, ok: true },
      { login: 'work-me', active: false, ok: true },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());
function tree(
  visible = true,
  status: CloudStatus = { connection, state: 'connected', lastError: null },
) {
  return (
    <CloudContext.Provider
      value={{
        status,
        epoch: 1,
        current: () => 1,
        refresh: vi.fn(),
        apply: vi.fn(),
        loaded: true,
        error: null,
        changed: false,
      }}
    >
      <CloudProjects visible={visible} />
    </CloudContext.Provider>
  );
}
const show = (visible = true) => render(tree(visible));
/** The list's rows (an open tag editor has list items of its own). */
const rows = () => {
  const list = screen.getByRole('list', { name: 'Projects' });
  return within(list)
    .getAllByRole('listitem')
    .filter((li) => li.parentElement === list);
};
/** A row by its name (the one span that says exactly that). */
const row = (name: string) =>
  rows().find((li) => within(li).queryAllByText(name, { selector: 'span' }).length > 0)!;
const names = () =>
  rows().map(
    (li) =>
      within(li).getAllByText(/^(project|scratch|notes|site)$/, { selector: 'span' })[0]
        .textContent,
  );
const more = (name: string) => {
  fireEvent.click(within(row(name)).getByRole('button', { name: `More actions for ${name}` }));
  return screen.getByRole('menu', { name: `Actions for ${name}` });
};

it('lists this Mac’s folders most used first, then the saved projects that are not here', async () => {
  show();
  await screen.findByText('Up to date');
  expect(names()).toEqual(['project', 'scratch', 'notes', 'site']);
  // A saved checkout: where it is (home as ~), its branch and repository, and Open.
  expect(within(row('project')).getByText(/~\/code\/project/)).toBeInTheDocument();
  expect(within(row('project')).getByRole('link', { name: 'example/project' })).toHaveAttribute(
    'href',
    'https://github.com/example/project',
  );
  expect(within(row('project')).getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    `/project-browser?path=${encodeURIComponent(checkout)}`,
  );
  expect(screen.queryByText(/Old description/)).not.toBeInTheDocument();
  // A GitHub folder not saved yet, a folder with no GitHub remote, a project only in the cloud.
  expect(within(row('scratch')).getByText('Not saved')).toBeInTheDocument();
  expect(within(row('scratch')).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(within(row('notes')).getByText('No GitHub remote')).toBeInTheDocument();
  expect(within(row('notes')).getByRole('link', { name: 'Open' })).toBeInTheDocument();
  expect(
    within(row('notes')).queryByRole('button', { name: /More actions/ }),
  ).not.toBeInTheDocument();
  expect(within(row('site')).getByText('Not on this device')).toBeInTheDocument();
  expect(within(row('site')).getByRole('button', { name: 'Clone' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(screen.getByText('octo (active)')).toBeInTheDocument();
  expect(screen.getByText('work-me', { selector: 'span' })).toBeInTheDocument();
});

it('checks each saved checkout as it opens, the server’s 10-minute skip included; Pull then appears', async () => {
  vi.mocked(cloudApi.checkProject).mockResolvedValue(linked({ behind: 3 }));
  show();
  expect(await screen.findByText('3 behind GitHub')).toBeInTheDocument();
  expect(cloudApi.checkProject).toHaveBeenCalledTimes(1);
  expect(cloudApi.checkProject).toHaveBeenCalledWith(
    id,
    expect.anything(),
    expect.any(AbortSignal),
    true,
  );
  expect(within(row('project')).getByRole('button', { name: 'Pull' })).toBeEnabled();
});

it('says why a check failed on the row, and keeps the rest of the list working', async () => {
  vi.mocked(cloudApi.checkProject).mockRejectedValue(new Error('GitHub could not be reached.'));
  show();
  await screen.findByText(/Couldn’t check GitHub: GitHub could not be reached/);
  expect(within(row('project')).getByText(/Couldn’t check GitHub/)).toBeInTheDocument();
  expect(within(row('scratch')).getByRole('button', { name: 'Save' })).toBeEnabled();
});

// Code review, Oct 29 2026: one checkout that can't be read used to blank the whole list.
it('a saved checkout that can’t be read says so on its row; the rest of the list stays', async () => {
  vi.mocked(cloudApi.localProject).mockImplementation(async (pid) => {
    if (pid === id) throw new Error('The checkout folder changed.');
    return local({});
  });
  show();
  await screen.findByText('Couldn’t read its folder: The checkout folder changed.');
  expect(
    within(row('project')).getByText('Couldn’t read its folder: The checkout folder changed.'),
  ).toBeInTheDocument();
  expect(within(row('project')).getByText('Not read')).toBeInTheDocument();
  expect(names()).toEqual(['project', 'scratch', 'notes', 'site']);
  expect(within(row('scratch')).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(cloudApi.checkProject).not.toHaveBeenCalled();
});

it('a GitHub checkout AASC won’t read says why instead of “No GitHub remote”', async () => {
  vi.mocked(cloudApi.projectFolders).mockResolvedValue({
    home,
    items: [...FOLDERS, folder('/Users/me/code/tunnel', { blocked: 'settings' })],
  });
  show();
  await screen.findByText('Up to date');
  const tunnel = rows().find((li) => within(li).queryByText('tunnel', { selector: 'span' }))!;
  expect(within(tunnel).getByText('Git settings block sync')).toBeInTheDocument();
  expect(within(tunnel).getByText(/url\.insteadOf, a proxy or a push URL/)).toBeInTheDocument();
  expect(within(row('notes')).getByText('No GitHub remote')).toBeInTheDocument();
});

it('Pull waits while an agent works in the folder, and says so', async () => {
  vi.mocked(cloudApi.localProject).mockImplementation(async (pid) =>
    pid === id ? linked({ behind: 2, agentActive: true }) : local({}),
  );
  vi.mocked(cloudApi.checkProject).mockResolvedValue(linked({ behind: 2, agentActive: true }));
  show();
  await screen.findByText('2 behind GitHub');
  expect(within(row('project')).getByRole('button', { name: 'Pull' })).toBeDisabled();
  expect(
    within(row('project')).getByText('An agent is working in this folder: Pull when it stops.'),
  ).toBeInTheDocument();
});

it('saves a GitHub folder from its row: the repository only, the folder linked here', async () => {
  const save = vi.spyOn(cloudApi, 'saveProject').mockResolvedValue(project);
  show();
  await screen.findByText('Up to date');
  fireEvent.click(within(row('scratch')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const [mutation, , , localPath] = save.mock.calls[0];
  expect(mutation.baseVersion).toBeNull();
  expect(mutation.value).toMatchObject({
    name: 'scratch',
    repository: { url: 'https://github.com/example/scratch', branch: 'dev' },
    description: '',
    resources: [],
  });
  expect(localPath).toBe('/Users/me/code/scratch');
  await waitFor(() => expect(cloudApi.listProjects).toHaveBeenCalledTimes(2));
});

it('adds a GitHub link that is not on this Mac, without any folder', async () => {
  const save = vi.spyOn(cloudApi, 'saveProject').mockResolvedValue(project);
  show();
  await screen.findByText('Up to date');
  fireEvent.click(screen.getByRole('button', { name: 'Add a GitHub link' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a GitHub link' });
  const link = within(dialog).getByLabelText('GitHub repository link');
  fireEvent.change(link, { target: { value: 'https://gitlab.com/a/b' } });
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/github.com\/owner\/repository/);
  expect(within(dialog).getByRole('button', { name: 'Save to cloud' })).toBeDisabled();
  fireEvent.change(link, { target: { value: 'https://github.com/Example/Other.git' } });
  fireEvent.change(within(dialog).getByLabelText('Branch'), { target: { value: 'develop' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save to cloud' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0].value.repository).toEqual({
    provider: 'github',
    owner: 'example',
    name: 'other',
    url: 'https://github.com/example/other',
    branch: 'develop',
  });
  expect(save.mock.calls[0][3]).toBeUndefined();
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('clones a saved project into a folder beside the others, with no transport or resource choice', async () => {
  const get = vi
    .spyOn(cloudApi, 'getProject')
    .mockResolvedValue({ id, kind: 'get-project', state: 'complete', steps: [] });
  show();
  await screen.findByText('Up to date');
  fireEvent.click(within(row('site')).getByRole('button', { name: 'Clone' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Folder name')).toHaveValue('site');
  expect(within(dialog).getByLabelText('Into this folder')).toHaveValue('/Users/me/code');
  expect(within(dialog).queryByText(/SSH|transport|resource/i)).not.toBeInTheDocument();
  expect(within(dialog).getByText(/with this Mac’s Git sign-in/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clone' }));
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      siteId,
      { parentPath: '/Users/me/code', directoryName: 'site' },
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
});

it('offers Push for commits to send; ⋯ opens the folder and checks again right now', async () => {
  vi.mocked(cloudApi.localProject).mockImplementation(async (pid) =>
    pid === id ? linked({ state: 'ahead', ahead: 2 }) : local({}),
  );
  vi.mocked(cloudApi.checkProject).mockResolvedValue(linked({ state: 'ahead', ahead: 2 }));
  const push = vi
    .spyOn(cloudApi, 'pushProject')
    .mockResolvedValue({ id, kind: 'push-project', state: 'complete', steps: [] });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  show();
  expect(await screen.findByText('2 commits to push')).toBeInTheDocument();
  await waitFor(() => expect(cloudApi.checkProject).toHaveBeenCalledTimes(1));
  expect(within(row('project')).queryByRole('button', { name: 'Pull' })).not.toBeInTheDocument();
  fireEvent.click(within(row('project')).getByRole('button', { name: 'Push' }));
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(id, expect.anything(), expect.any(AbortSignal)),
  );
  let menu = more('project');
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((m) => m.textContent),
  ).toEqual([
    'Open folder',
    'Check for changes now',
    'Edit tags…',
    'GitHub account…',
    'Remove from cloud…',
  ]);
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Open folder' }));
  expect(open).toHaveBeenCalledWith(
    `/project-browser?path=${encodeURIComponent(checkout)}`,
    '_blank',
  );
  await waitFor(() =>
    expect(within(row('project')).getByRole('button', { name: 'Push' })).toBeEnabled(),
  );
  menu = more('project');
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Check for changes now' }));
  // Asked for, so never skipped: no `auto`.
  await waitFor(() => expect(cloudApi.checkProject).toHaveBeenCalledTimes(2));
  expect(vi.mocked(cloudApi.checkProject).mock.calls[1]).toEqual([
    id,
    expect.anything(),
    expect.any(AbortSignal),
  ]);
});

it('chooses the GitHub account for the project on this device from the ⋯ menu', async () => {
  const set = vi
    .spyOn(cloudApi, 'setProjectAccount')
    .mockResolvedValue(linked({ account: 'work-me' }));
  show();
  await screen.findByText('Up to date');
  fireEvent.click(within(more('project')).getByRole('menuitem', { name: 'GitHub account…' }));
  const select = within(row('project')).getByLabelText('GitHub account');
  expect(select).toHaveValue('');
  expect(select).toHaveFocus();
  fireEvent.change(select, { target: { value: 'work-me' } });
  await waitFor(() =>
    expect(set).toHaveBeenCalledWith(id, 'work-me', expect.anything(), expect.any(AbortSignal)),
  );
  await waitFor(() =>
    expect(within(row('project')).getByLabelText('GitHub account')).toHaveValue('work-me'),
  );
});

it('Remove asks once, says folders stay, and the folder is then just a GitHub folder again', async () => {
  const remove = vi.spyOn(cloudApi, 'removeProject').mockResolvedValue({
    ...project,
    version: 2,
    deleted: true,
  });
  show();
  await screen.findByText('Up to date');
  fireEvent.click(within(more('project')).getByRole('menuitem', { name: 'Remove from cloud…' }));
  expect(
    within(row('project')).getByText('Remove from the cloud list? Folders stay.'),
  ).toBeInTheDocument();
  expect(within(row('project')).getByRole('button', { name: 'Keep' })).toHaveFocus();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(row('project')).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(remove).toHaveBeenCalled());
  await waitFor(() => expect(within(row('project')).getByText('Not saved')).toBeInTheDocument());
});

it('♥ marks a favourite at once and keeps it in the cloud; a refusal puts it back', async () => {
  const change = vi
    .spyOn(cloudApi, 'changeProjectMeta')
    .mockResolvedValueOnce({ projectId: id, version: 2, favorite: true, tags: [] })
    .mockRejectedValueOnce(new Error('Cloud is offline.'));
  show();
  await screen.findByText('Up to date');
  const heart = within(row('project')).getByRole('button', { name: 'Favourite project' });
  fireEvent.click(heart);
  expect(heart).toHaveAttribute('aria-pressed', 'true');
  expect(change).toHaveBeenCalledWith(id, { favorite: true }, expect.anything());
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1));
  fireEvent.click(within(row('project')).getByRole('button', { name: 'Favourite project' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cloud is offline.'));
  expect(within(row('project')).getByRole('button', { name: 'Favourite project' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The ♥ filter keeps only the favourites.
  fireEvent.click(screen.getByRole('button', { name: /Favourites/ }));
  expect(rows()).toHaveLength(1);
});

// Code review, Oct 29 2026: a project's changes reach the cloud one at a time, in order, and a
// refused one drops out of the row by itself, never leaving a state the cloud never saved.
it('♥ and tag changes go one at a time; each refused one drops out on its own', async () => {
  let answer!: (m: ProjectMeta) => void;
  const change = vi
    .spyOn(cloudApi, 'changeProjectMeta')
    .mockImplementationOnce(() => new Promise<ProjectMeta>((r) => (answer = r)))
    .mockRejectedValueOnce(new Error('Cloud is offline.'))
    .mockRejectedValueOnce(new Error('Cloud is offline.'));
  show();
  await screen.findByText('Up to date');
  const heart = () => within(row('project')).getByRole('button', { name: 'Favourite project' });
  fireEvent.click(heart()); // ♥ on: the cloud is slow to answer
  fireEvent.click(heart()); // ♥ off right after: it waits for the first
  expect(heart()).toHaveAttribute('aria-pressed', 'false');
  expect(change).toHaveBeenCalledTimes(1);
  answer({ projectId: id, version: 2, favorite: true, tags: [] });
  // The off is refused: the row shows what the cloud saved, ♥ on.
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cloud is offline.'));
  expect(change).toHaveBeenNthCalledWith(2, id, { favorite: false }, expect.anything());
  expect(heart()).toHaveAttribute('aria-pressed', 'true');
  // A refused tag takes only itself out.
  fireEvent.click(within(more('project')).getByRole('menuitem', { name: 'Edit tags…' }));
  fireEvent.change(within(row('project')).getByLabelText('Add a tag'), { target: { value: 'ops' } });
  fireEvent.click(within(row('project')).getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(change).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(within(row('project')).queryByText('#ops')).not.toBeInTheDocument());
  expect(heart()).toHaveAttribute('aria-pressed', 'true');
});

it('adds a tag from the ⋯ menu, shows it on the row, and filters by it', async () => {
  const change = vi
    .spyOn(cloudApi, 'changeProjectMeta')
    .mockResolvedValue({ projectId: id, version: 2, favorite: false, tags: ['work-stuff'] });
  show();
  await screen.findByText('Up to date');
  fireEvent.click(within(more('project')).getByRole('menuitem', { name: 'Edit tags…' }));
  const input = within(row('project')).getByLabelText('Add a tag');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: '  Work Stuff ' } });
  fireEvent.click(within(row('project')).getByRole('button', { name: 'Add' }));
  expect(change).toHaveBeenCalledWith(id, { addTags: ['work-stuff'] }, expect.anything());
  expect(await within(row('project')).findByText('#work-stuff')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '#work-stuff · 1' }));
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(screen.getByText('1 shown')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove the #work-stuff filter' }));
  expect(rows()).toHaveLength(4);
});

it('without ♥ and tags in AASC Cloud yet, the list has no ♥ and says why', async () => {
  vi.mocked(cloudApi.projectMeta).mockResolvedValue({ available: false, items: [] });
  show();
  await screen.findByText('Up to date');
  expect(screen.queryByRole('button', { name: /^Favourite / })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Favourites/ })).not.toBeInTheDocument();
  expect(screen.getByText('Favourites and tags need an AASC Cloud update.')).toBeInTheDocument();
  expect(
    within(more('project')).queryByRole('menuitem', { name: 'Edit tags…' }),
  ).not.toBeInTheDocument();
});

it('shows cards; List view shows the same projects and actions as rows, and is kept', async () => {
  show();
  await screen.findByText('Up to date');
  const cards = screen.getByRole('button', { name: 'Card view' }),
    list = screen.getByRole('button', { name: 'List view' });
  expect(cards).toHaveAttribute('aria-pressed', 'true');
  expect(list).toHaveAttribute('aria-pressed', 'false');
  const order = names();
  fireEvent.click(list);
  expect(list).toHaveAttribute('aria-pressed', 'true');
  expect(cards).toHaveAttribute('aria-pressed', 'false');
  expect(localStorage.getItem('projects-view-mode')).toBe('list');
  expect(names()).toEqual(order);
  expect(within(row('scratch')).getByRole('button', { name: 'Save' })).toBeEnabled();
  expect(within(row('site')).getByRole('button', { name: 'Clone' })).toBeEnabled();
  expect(within(row('project')).getByRole('link', { name: 'example/project' })).toBeInTheDocument();
  fireEvent.click(cards);
  expect(localStorage.getItem('projects-view-mode')).toBe('card');
});

it('has no List / Cards switch while nothing is listed', async () => {
  vi.mocked(cloudApi.listProjects).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(cloudApi.projectFolders).mockResolvedValue({ home, items: [] });
  show();
  expect(await screen.findByText('No projects on this Mac yet.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Card view' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add a GitHub link' })).toBeInTheDocument();
});

it('search narrows the list; nothing found offers Clear filters', async () => {
  show();
  await screen.findByText('Up to date');
  const search = screen.getByRole('textbox', { name: 'Search projects' });
  fireEvent.change(search, { target: { value: 'notes' } });
  await waitFor(() => expect(rows()).toHaveLength(1));
  fireEvent.change(search, { target: { value: 'zzz' } });
  expect(await screen.findByText('No projects match.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(rows()).toHaveLength(4));
});

it('Use this folder links one of two folders that hold a saved project', async () => {
  vi.mocked(cloudApi.projectFolders).mockResolvedValue({
    home,
    items: [
      folder(checkout, { repository: github('project'), projectId: id, recent: 2 }),
      folder('/Users/me/old/project', { repository: github('project'), projectId: id, recent: 1 }),
    ],
  });
  vi.mocked(cloudApi.localProject).mockResolvedValue(local({}));
  const associate = vi.spyOn(cloudApi, 'associateProject').mockResolvedValue(linked());
  show();
  const [first] = await screen.findAllByRole('button', { name: 'Use this folder' });
  fireEvent.click(first);
  await waitFor(() =>
    expect(associate).toHaveBeenCalledWith(
      id,
      checkout,
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
  expect(await screen.findByText('Up to date')).toBeInTheDocument();
  expect(screen.getByText('Another copy')).toBeInTheDocument();
});

// Code review, Oct 29 2026: one folder standing for a saved project says so plainly, and carries
// that project's ♥.
it('a lone folder with a saved project’s repository offers itself, with the project’s ♥', async () => {
  vi.mocked(cloudApi.projectFolders).mockResolvedValue({
    home,
    items: [folder('/Users/me/old/project', { repository: github('project'), recent: 1 })],
  });
  vi.mocked(cloudApi.localProject).mockResolvedValue(local({}));
  vi.mocked(cloudApi.projectMeta).mockResolvedValue({
    available: true,
    items: [{ projectId: id, version: 3, favorite: true, tags: [] }],
  });
  show();
  expect(
    await screen.findByText('project is saved with this repository and branch. Use this folder for it?'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Favourite project' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

it('lists this Mac’s folders with no connection; saving them waits for one', async () => {
  render(tree(true, { connection: null, state: 'disconnected', lastError: null }));
  expect(await screen.findAllByText('Not saved')).toHaveLength(2);
  expect(cloudApi.projectFolders).toHaveBeenCalledWith(null, expect.any(AbortSignal));
  expect(cloudApi.listProjects).not.toHaveBeenCalled();
  expect(names()).toEqual(['project', 'scratch', 'notes']);
  expect(within(row('scratch')).getByRole('button', { name: 'Save' })).toBeDisabled();
  expect(
    screen.getByText('Connect to AASC Cloud to save, clone, pull or push.'),
  ).toBeInTheDocument();
});

it('offline: the saved projects from the last visit, with this Mac’s folders and checkouts read now', async () => {
  localStorage.setItem(
    'aasc.cloud.browse.' + JSON.stringify([connection.backendOrigin, connection.accountId]),
    JSON.stringify({ resources: [], projects: [project, site], jobs: [], savedAt: 1 }),
  );
  render(tree(true, { connection, state: 'offline', lastError: 'AASC Cloud did not answer' }));
  expect(await screen.findByText('Up to date')).toBeInTheDocument();
  expect(names()).toEqual(['project', 'scratch', 'notes', 'site']);
  expect(cloudApi.projectFolders).toHaveBeenCalledWith(null, expect.any(AbortSignal));
  expect(cloudApi.localProject).toHaveBeenCalledWith(id, connection, expect.any(AbortSignal));
  expect(cloudApi.listProjects).not.toHaveBeenCalled();
  expect(cloudApi.checkProject).not.toHaveBeenCalled();
  expect(within(row('site')).getByText('Not on this device')).toBeInTheDocument();
  expect(within(row('site')).getByRole('button', { name: 'Clone' })).toBeDisabled();
  expect(
    screen.getByText(
      'Saved projects are from this browser’s last visit. Connect to AASC Cloud to save, clone, pull or push.',
    ),
  ).toBeInTheDocument();
});

it('reads everything again each time the tab is shown', async () => {
  const view = show();
  await screen.findByText('Up to date');
  expect(cloudApi.listProjects).toHaveBeenCalledTimes(1);
  view.rerender(tree(false));
  view.rerender(tree(true));
  await waitFor(() => expect(cloudApi.listProjects).toHaveBeenCalledTimes(2));
  expect(cloudApi.projectFolders).toHaveBeenCalledTimes(2);
});

it('without the GitHub CLI, says how to install it', async () => {
  vi.mocked(cloudApi.githubAccounts).mockResolvedValue({ installed: false, accounts: [] });
  show();
  expect(await screen.findByText(/brew install gh/)).toBeInTheDocument();
});
