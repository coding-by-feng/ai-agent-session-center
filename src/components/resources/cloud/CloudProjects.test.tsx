// AASC-63: Cloud → Projects keeps only GitHub repositories. Save from a folder or a link; each
// device clones, pulls, pushes and checks with the GitHub account chosen for the project.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, it, expect, beforeEach, afterEach } from 'vitest';
import CloudProjects from './CloudProjects';
import { CloudContext } from './cloudSession';
import { cloudApi } from '@/lib/cloudApi';
import type { LocalProject } from '@/types/cloudProjects';

const id = '00000000-0000-4000-8000-000000000001';
const connection = {
  backendOrigin: 'https://fixture.invalid',
  accountId: id,
  generation: 1,
  deviceId: id,
  deviceName: 'fixture',
};
const repository = {
  provider: 'github' as const,
  owner: 'example',
  name: 'project',
  url: 'https://github.com/example/project',
  branch: 'main',
};
const project = {
  id,
  version: 1,
  name: 'project',
  repository,
  description: 'Old description, no longer shown',
  resources: [{ resourceId: id, version: 2 }],
  deleted: false,
};
const local = (fields: Partial<LocalProject>): LocalProject => ({
  state: 'missing',
  branch: null,
  openUrl: null,
  localProjectId: null,
  path: null,
  ahead: null,
  behind: null,
  account: null,
  ...fields,
});
const linked = (fields: Partial<LocalProject>) =>
  local({
    state: 'ready',
    branch: 'main',
    openUrl: '/project-browser?path=%2FUsers%2Fme%2Fcode%2Fproject',
    localProjectId: 'project-1',
    path: '/Users/me/code/project',
    ahead: 0,
    behind: 0,
    ...fields,
  });
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(cloudApi, 'listProjects').mockResolvedValue({ items: [project], nextCursor: null });
  vi.spyOn(cloudApi, 'localProject').mockResolvedValue(local({}));
  vi.spyOn(cloudApi, 'githubAccounts').mockResolvedValue({
    installed: true,
    accounts: [
      { login: 'octo', active: true, ok: true },
      { login: 'work-me', active: false, ok: true },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());
function show() {
  return render(
    <CloudContext.Provider
      value={{
        status: { connection, state: 'connected', lastError: null },
        epoch: 1,
        current: () => 1,
        refresh: vi.fn(),
        apply: vi.fn(),
        loaded: true,
        error: null,
        changed: false,
      }}
    >
      <CloudProjects />
    </CloudContext.Provider>,
  );
}
const row = () => screen.getByText('project', { selector: 'span' }).closest('li')!;

it('shows each project as its GitHub repository and branch, and only Clone when it is not here', async () => {
  show();
  await screen.findByText('Not on this device');
  expect(within(row()).getByRole('link', { name: 'github.com/example/project' })).toHaveAttribute(
    'href',
    'https://github.com/example/project',
  );
  expect(within(row()).getByText('main')).toBeInTheDocument();
  expect(screen.queryByText(/Old description/)).not.toBeInTheDocument();
  expect(within(row()).getByRole('button', { name: 'Clone' })).toBeEnabled();
  expect(within(row()).queryByRole('button', { name: 'Pull' })).not.toBeInTheDocument();
  expect(within(row()).queryByRole('button', { name: 'Push' })).not.toBeInTheDocument();
  expect(screen.getByText('octo (active)')).toBeInTheDocument();
  expect(screen.getByText('work-me', { selector: 'span' })).toBeInTheDocument();
});

const tool = { ...repository, name: 'tool', url: 'https://github.com/example/tool' };
const site = { ...repository, name: 'site', url: 'https://github.com/example/site' };
const candidates = () =>
  vi.spyOn(cloudApi, 'projectCandidates').mockResolvedValue({
    items: [
      { path: '/Users/me/code/project', repository, projectId: id },
      { path: '/Users/me/code/tool', repository: tool, projectId: null },
      { path: '/Users/me/code/valux', repository: site, projectId: null },
    ],
  });
async function openSave() {
  show();
  await screen.findByText('Not on this device');
  fireEvent.click(screen.getByRole('button', { name: 'Save projects' }));
  const dialog = await screen.findByRole('dialog', { name: 'Save projects to cloud' });
  await within(dialog).findByRole('checkbox', { name: /tool/ });
  return dialog;
}

// Oct 26 2026: tick several of this Mac's GitHub folders and save their basic information at once.
it('saves several GitHub folders at once: repository only, each folder linked here', async () => {
  candidates();
  const save = vi.spyOn(cloudApi, 'saveProject').mockResolvedValue(project);
  const dialog = await openSave();
  const saved = within(dialog).getByRole('checkbox', { name: /project/ });
  expect(saved).toBeChecked();
  expect(saved).toBeDisabled();
  expect(within(dialog).getByText('Saved')).toBeInTheDocument();
  // The folder's path is shown: valux holds the repository "site".
  expect(within(dialog).getByText('/Users/me/code/valux')).toBeInTheDocument();
  const button = within(dialog).getByRole('button', { name: /^Save( \d+)? to cloud$/ });
  expect(button).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /tool/ }));
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /site/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save 2 to cloud' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const [mutation, , , localPath] = save.mock.calls[0];
  expect(mutation.baseVersion).toBeNull();
  expect(mutation.value).toMatchObject({
    name: 'tool',
    repository: { url: 'https://github.com/example/tool', branch: 'main' },
    description: '',
    resources: [],
  });
  expect(localPath).toBe('/Users/me/code/tool');
  expect(save.mock.calls[1][0].value.name).toBe('site');
  expect(save.mock.calls[1][3]).toBe('/Users/me/code/valux');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('Select all ticks every folder not yet saved, and again clears them', async () => {
  candidates();
  const dialog = await openSave();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select all' }));
  expect(within(dialog).getByRole('checkbox', { name: /tool/ })).toBeChecked();
  expect(within(dialog).getByRole('checkbox', { name: /site/ })).toBeChecked();
  expect(within(dialog).getByRole('button', { name: 'Save 2 to cloud' })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
  expect(within(dialog).getByRole('checkbox', { name: /tool/ })).not.toBeChecked();
  expect(within(dialog).getByRole('checkbox', { name: /project/ })).toBeChecked();
});

it('says which save failed and keeps the saved ones locked, instead of one banner', async () => {
  candidates();
  const save = vi
    .spyOn(cloudApi, 'saveProject')
    .mockResolvedValueOnce(project)
    .mockRejectedValueOnce(new Error('That folder is not on a branch.'));
  const dialog = await openSave();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select all' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save 2 to cloud' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(await within(dialog).findByText('1 of 2 saved')).toBeInTheDocument();
  expect(within(dialog).getByText('That folder is not on a branch.')).toBeInTheDocument();
  expect(within(dialog).getByRole('checkbox', { name: /tool/ })).toBeDisabled();
  expect(within(dialog).getByRole('checkbox', { name: /site/ })).toBeChecked();
  expect(within(dialog).getByRole('button', { name: 'Save 1 to cloud' })).toBeEnabled();
});

it('saves a pasted GitHub link without any folder', async () => {
  vi.spyOn(cloudApi, 'projectCandidates').mockResolvedValue({ items: [] });
  const save = vi.spyOn(cloudApi, 'saveProject').mockResolvedValue(project);
  show();
  await screen.findByText('Not on this device');
  fireEvent.click(screen.getByRole('button', { name: 'Save projects' }));
  const dialog = await screen.findByRole('dialog');
  const toggle = within(dialog).getByRole('button', { name: 'Paste a GitHub link instead' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(within(dialog).queryByLabelText('GitHub repository link')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  const link = within(dialog).getByLabelText('GitHub repository link');
  fireEvent.change(link, { target: { value: 'https://gitlab.com/a/b' } });
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/github.com\/owner\/repository/);
  expect(within(dialog).getByRole('button', { name: /^Save( \d+)? to cloud$/ })).toBeDisabled();
  fireEvent.change(link, { target: { value: 'https://github.com/Example/Other.git' } });
  fireEvent.change(within(dialog).getByLabelText('Branch'), { target: { value: 'develop' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save 1 to cloud' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0].value.repository).toEqual({
    provider: 'github',
    owner: 'example',
    name: 'other',
    url: 'https://github.com/example/other',
    branch: 'develop',
  });
  expect(save.mock.calls[0][3]).toBeUndefined();
});

it('clones into a chosen folder, with no transport or resource choice', async () => {
  const get = vi
    .spyOn(cloudApi, 'getProject')
    .mockResolvedValue({ id, kind: 'get-project', state: 'complete', steps: [] });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Clone' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByLabelText('Folder name')).toHaveValue('project');
  expect(within(dialog).queryByText(/SSH|transport|resource/i)).not.toBeInTheDocument();
  expect(within(dialog).getByText(/with this mac’s git sign-in/i)).toBeInTheDocument();
  fireEvent.change(within(dialog).getByLabelText('Into this folder'), {
    target: { value: '/Users/me/code' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Clone' }));
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      id,
      { parentPath: '/Users/me/code', directoryName: 'project' },
      expect.anything(),
      expect.any(AbortSignal),
    ),
  );
});

it('offers Push for commits to send and Pull when GitHub is ahead', async () => {
  vi.mocked(cloudApi.localProject).mockResolvedValue(linked({ state: 'ahead', ahead: 2 }));
  const push = vi
    .spyOn(cloudApi, 'pushProject')
    .mockResolvedValue({ id, kind: 'push-project', state: 'complete', steps: [] });
  show();
  expect(await screen.findByText('2 commits to push')).toBeInTheDocument();
  expect(within(row()).queryByRole('button', { name: 'Pull' })).not.toBeInTheDocument();
  expect(within(row()).getByRole('link', { name: 'Open' })).toHaveAttribute(
    'href',
    '/project-browser?path=%2FUsers%2Fme%2Fcode%2Fproject',
  );
  fireEvent.click(within(row()).getByRole('button', { name: 'Push' }));
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(id, expect.anything(), expect.any(AbortSignal)),
  );
});

it('Check asks GitHub and shows what is behind; Pull then appears', async () => {
  vi.mocked(cloudApi.localProject).mockResolvedValue(linked({}));
  vi.spyOn(cloudApi, 'checkProject').mockResolvedValue(linked({ behind: 3 }));
  show();
  await screen.findByText('Up to date');
  fireEvent.click(within(row()).getByRole('button', { name: 'Check' }));
  expect(await screen.findByText('3 behind GitHub')).toBeInTheDocument();
  expect(within(row()).getByRole('button', { name: 'Pull' })).toBeEnabled();
});

it('chooses the GitHub account for the project on this device', async () => {
  vi.mocked(cloudApi.localProject).mockResolvedValue(linked({}));
  const set = vi
    .spyOn(cloudApi, 'setProjectAccount')
    .mockResolvedValue(linked({ account: 'work-me' }));
  show();
  await screen.findByText('Up to date');
  const select = within(row()).getByLabelText('GitHub account');
  expect(select).toHaveValue('');
  fireEvent.change(select, { target: { value: 'work-me' } });
  await waitFor(() =>
    expect(set).toHaveBeenCalledWith(id, 'work-me', expect.anything(), expect.any(AbortSignal)),
  );
  await waitFor(() =>
    expect(within(row()).getByLabelText('GitHub account')).toHaveValue('work-me'),
  );
});

it('Remove asks once, says folders stay, and drops only the cloud entry', async () => {
  const remove = vi.spyOn(cloudApi, 'removeProject').mockResolvedValue({
    ...project,
    version: 2,
    deleted: true,
    resources: [],
  });
  show();
  await screen.findByText('Not on this device');
  fireEvent.click(within(row()).getByRole('button', { name: 'Remove' }));
  expect(screen.getByText('Remove from the cloud list? Folders stay.')).toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(row()).getAllByRole('button', { name: 'Remove' }).at(-1)!);
  await waitFor(() => expect(remove).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByText('No projects saved to cloud yet.')).toBeInTheDocument(),
  );
});

it('without the GitHub CLI, says how to install it', async () => {
  vi.mocked(cloudApi.githubAccounts).mockResolvedValue({ installed: false, accounts: [] });
  show();
  expect(await screen.findByText(/brew install gh/)).toBeInTheDocument();
});
