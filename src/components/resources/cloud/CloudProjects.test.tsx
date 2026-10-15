import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect, beforeEach, afterEach } from 'vitest';
import CloudProjects from './CloudProjects';
import { CloudContext } from './cloudSession';
import { cloudApi, CloudApiError } from '@/lib/cloudApi';
import { CATALOG } from '@/__tests__/fixtures/resourceCatalog';
const id = '00000000-0000-4000-8000-000000000001';
const connection = {
  backendOrigin: 'https://fixture.invalid',
  accountId: id,
  generation: 1,
  deviceId: id,
  deviceName: 'fixture',
};
const project = {
  id,
  version: 1,
  name: 'Example project',
  repository: {
    provider: 'github' as const,
    owner: 'example',
    name: 'project',
    url: 'https://github.com/example/project',
    branch: 'main',
  },
  description: '',
  resources: [{ resourceId: id, version: 2 }],
  deleted: false,
};
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(cloudApi, 'listProjects').mockResolvedValue({ items: [project], nextCursor: null });
  vi.spyOn(cloudApi, 'listResources').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(cloudApi, 'localProject').mockResolvedValue({
    state: 'missing',
    branch: null,
    localProjectId: null,
    openUrl: null,
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
        changed: false,
      }}
    >
      <CloudProjects catalog={CATALOG} />
    </CloudContext.Provider>,
  );
}
it('get_project_has_destination_and_versions', async () => {
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Get project' }));
  expect(screen.getByLabelText('Parent folder on this device')).toBeInTheDocument();
  expect(screen.getByLabelText('Git transport')).toBeInTheDocument();
  expect(screen.getByText(new RegExp(id + ' · v2'))).toBeInTheDocument();
});
it('preserves metadata draft on 409 and requires explicit comparison', async () => {
  vi.spyOn(cloudApi, 'saveProject').mockRejectedValue(
    new CloudApiError('version_conflict', 'Cloud changed'),
  );
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
  fireEvent.change(screen.getByLabelText('Project name'), {
    target: { value: 'My preserved draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save project details' }));
  await screen.findByText(/Your draft is preserved/);
  expect(screen.getByLabelText('Project name')).toHaveValue('My preserved draft');
  expect(screen.getByRole('button', { name: 'Load latest for comparison' })).toBeInTheDocument();
});
it('partial_clone_can_open and retry resources without another clone', async () => {
  const job = {
    id,
    kind: 'get-project' as const,
    state: 'partial' as const,
    steps: [
      { id: 'git', label: 'Git checkout', state: 'complete' as const },
      {
        id: 'resources',
        label: 'Resource installation',
        state: 'failed' as const,
        error: 'Needs review',
      },
    ],
  };
  localStorage.setItem(
    'aasc.cloud.browse.' + JSON.stringify([connection.backendOrigin, id]),
    JSON.stringify({
      resources: [],
      projects: [project],
      jobs: [{ job, generation: 1, projectId: id }],
      savedAt: 1,
    }),
  );
  vi.mocked(cloudApi.localProject).mockResolvedValue({
    state: 'ready',
    branch: 'main',
    localProjectId: 'local',
    openUrl: '/project?path=fixture',
  });
  show();
  expect(await screen.findByRole('link', { name: 'Open project' })).toHaveAttribute(
    'href',
    '/project?path=fixture',
  );
  expect(screen.getByRole('button', { name: 'Review resources for retry' })).toBeInTheDocument();
});

it('preserves edits typed while metadata save is in flight', async () => {
  let finish!: (p: typeof project) => void;
  vi.spyOn(cloudApi, 'saveProject').mockImplementation(() => new Promise<typeof project>((r) => (finish = r)));
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Saved first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save project details' }));
  fireEvent.change(screen.getByLabelText('Project name'), {
    target: { value: 'Newer unsaved text' },
  });
  await act(async () => {
    finish({ ...project, version: 2, name: 'Saved first' });
  });
  await waitFor(() =>
    expect(screen.getByLabelText('Project name')).toHaveValue('Newer unsaved text'),
  );
  expect(screen.getByRole('heading', { name: 'Latest revision 2' })).toBeInTheDocument();
  expect(screen.getByText('Saved first')).toBeInTheDocument();
});

const otherProject = {
  ...project,
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Other project',
};
it.each([
  ['latest', 'replace'],
  ['save', 'replace'],
  ['latest', 'return'],
  ['save', 'return'],
  ['latest', 'close'],
  ['save', 'close'],
] as const)('I1: %s completion cannot survive editor %s', async (path, transition) => {
  let finish!: (p: typeof project) => void;
  vi.mocked(cloudApi.listProjects).mockResolvedValue({
    items: [project, otherProject],
    nextCursor: null,
  });
  vi.spyOn(cloudApi, path === 'latest' ? 'project' : 'saveProject').mockImplementation(
    () => new Promise<typeof project>((r) => (finish = r)),
  );
  show();
  const edits = await screen.findAllByRole('button', { name: 'Edit project' });
  fireEvent.click(edits[0]);
  fireEvent.click(
    screen.getByRole('button', {
      name: path === 'latest' ? 'Load latest for comparison' : 'Save project details',
    }),
  );
  if (transition === 'close') {
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    fireEvent.click(edits[0]);
  } else {
    fireEvent.click(edits[1]);
    if (transition === 'return') fireEvent.click(edits[0]);
  }
  await act(async () => {
    finish({ ...project, version: 7, name: 'Old A response' });
  });
  expect(screen.getByLabelText('Project name')).toHaveValue(
    transition === 'replace' ? 'Other project' : 'Example project',
  );
  expect(
    screen.queryByRole('button', { name: 'Keep my draft using this reviewed revision' }),
  ).not.toBeInTheDocument();
});
it('I1: wrong-record latest cannot become the draft revision base', async () => {
  vi.spyOn(cloudApi, 'project').mockResolvedValue({ ...otherProject, version: 9 });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load latest for comparison' }));
  await act(async () => {});
  expect(
    screen.queryByRole('button', { name: 'Keep my draft using this reviewed revision' }),
  ).not.toBeInTheDocument();
});
it('M1: same-editor comparison names latest and draft fields without requiring JSON', async () => {
  vi.spyOn(cloudApi, 'project').mockResolvedValue({
    ...project,
    version: 3,
    name: 'Latest title',
    description: 'Latest description',
    repository: { ...project.repository, branch: 'release' },
    resources: [],
  });
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'My draft title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load latest for comparison' }));
  expect(await screen.findByRole('region', { name: 'Revision comparison' })).toBeInTheDocument();
  expect(screen.getByText('Latest saved')).toBeInTheDocument();
  expect(screen.getByText('Your draft')).toBeInTheDocument();
  expect(screen.getByText('Latest title')).toBeInTheDocument();
  expect(screen.getByText('My draft title')).toBeInTheDocument();
  expect(screen.getByText('release')).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Keep my draft using this reviewed revision' }),
  );
  expect(screen.getByLabelText('Project name')).toHaveValue('My draft title');
  expect(screen.getByRole('heading', { name: 'Edit project · revision 3' })).toBeInTheDocument();
});
it.each(['latest', 'save'] as const)(
  'I1: delayed %s error does not label a replacement editor as conflicted',
  async (path) => {
    let fail!: (e: Error) => void;
    vi.mocked(cloudApi.listProjects).mockResolvedValue({
      items: [project, otherProject],
      nextCursor: null,
    });
    vi.spyOn(cloudApi, path === 'latest' ? 'project' : 'saveProject').mockImplementation(
      () => new Promise<typeof project>((_resolve, reject) => (fail = reject)),
    );
    show();
    const edits = await screen.findAllByRole('button', { name: 'Edit project' });
    fireEvent.click(edits[0]);
    fireEvent.click(
      screen.getByRole('button', {
        name: path === 'latest' ? 'Load latest for comparison' : 'Save project details',
      }),
    );
    fireEvent.click(edits[1]);
    await act(async () => {
      fail(new CloudApiError('version_conflict', 'Old editor failed'));
    });
    expect(screen.queryByText(/Your draft is preserved/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project name')).toHaveValue('Other project');
    expect(screen.getByRole('button', { name: 'Save project details' })).toBeEnabled();
  },
);
