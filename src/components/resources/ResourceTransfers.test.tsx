import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResourceSelection from './ResourceSelection';
import TransferPanel from './TransferPanel';
import {
  resourceIsSelected,
  type ResourceSelection as Selection,
  type TransferTask,
  type TransferDevice,
} from '@/types/resourceTransfers';
import {
  CATALOG,
  res,
  ready,
  renderView,
  stubApi,
  railButton,
} from '@/__tests__/fixtures/resourceCatalog';
import { transfersApi } from '@/lib/resourceTransfersApi';

const resources = [
  res({ id: 'global-c', name: 'global-c', hash: 'hash' }),
  res({ id: 'global-x', name: 'global-x', agent: 'codex', hash: 'hash' }),
  res({
    id: 'project-rule',
    name: 'project-rule',
    scope: 'project',
    projectId: 'p-app',
    type: 'rule',
    hash: 'hash',
  }),
  res({
    id: 'project-skill',
    name: 'project-skill',
    scope: 'project',
    projectId: 'p-app',
    hash: 'hash',
  }),
];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('combines scope, project, agent and type rules with leaf exclusions, including future additions', () => {
  const selection: Selection = [
    { scope: 'global', agent: 'codex', include: true },
    { projectId: 'p-app', type: 'rule', include: true },
    { resourceId: 'global-x', include: false },
  ];
  expect(resources.filter((r) => resourceIsSelected(r, selection)).map((r) => r.id)).toEqual([
    'project-rule',
  ]);
  expect(resourceIsSelected(res({ id: 'future', name: 'future', agent: 'codex' }), selection)).toBe(
    true,
  );
  expect(
    resourceIsSelected(resources[3], [...selection, { projectId: 'p-app', include: true }]),
  ).toBe(true);
});
it('shows a mixed parent and retains exceptions when switching agent filters', () => {
  function Harness() {
    const [selection, setSelection] = useState<Selection>([
      { scope: 'global', include: true },
      { resourceId: 'global-c', include: false },
    ]);
    return (
      <ResourceSelection
        resources={resources}
        projects={CATALOG.projects.filter((p) => p.id === 'p-app')}
        selection={selection}
        onChange={setSelection}
      />
    );
  }
  render(<Harness />);
  expect(screen.getByRole('checkbox', { name: 'Select global resources (1/2)' })).toHaveAttribute(
    'aria-checked',
    'mixed',
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent selection' }), {
    target: { value: 'codex' },
  });
  expect(screen.getByRole('checkbox', { name: 'Select global resources (1/1)' })).toBeChecked();
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent selection' }), {
    target: { value: 'all' },
  });
  expect(screen.getByRole('checkbox', { name: 'Select global resources (1/2)' })).toHaveAttribute(
    'aria-checked',
    'mixed',
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select global resources (1/2)' }));
  expect(screen.getByRole('checkbox', { name: 'Select global resources (2/2)' })).toBeChecked();
});
it('keeps Library transfer selection across type filters without opening resource previews', async () => {
  stubApi();
  renderView();
  await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select for transfer' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Transfer tdd (claude)' }));
  expect(screen.getByRole('button', { name: 'Create transfer (1)' })).toBeInTheDocument();
  expect(screen.getByText('Select a resource to see what is inside it.')).toBeInTheDocument();
  fireEvent.click(railButton('Rules'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Transfer coding-style.md (claude)' }));
  fireEvent.click(railButton('Skills'));
  expect(screen.getByRole('checkbox', { name: 'Transfer tdd (claude)' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Create transfer (2)' })).toBeInTheDocument();
});
const device: TransferDevice = {
  id: 'device',
  name: 'Office Mac',
  host: 'office',
  username: 'test',
  port: 22,
  home: '/Users/test',
  platform: 'darwin',
  fingerprint: 'trusted',
  checkedAt: 0,
};
const task: TransferTask = {
  id: 'task',
  name: 'Review copy',
  createdAt: 0,
  updatedAt: 0,
  state: 'review',
  selection: [{ include: true }],
  targets: [{ deviceId: 'device', projects: {} }],
  items: [
    {
      id: 'new',
      resourceId: 'global-c',
      deviceId: 'device',
      name: 'New skill',
      sourcePath: '~/.claude/skills/new',
      destinationPath: '/Users/test/.claude/skills/new',
      sourceHash: 'abc',
      destinationHash: null,
      action: 'add',
      state: 'pending',
    },
    {
      id: 'conflict',
      resourceId: 'rule',
      deviceId: 'device',
      name: 'Existing rule',
      sourcePath: '~/.claude/rules/a.md',
      destinationPath: '/Users/test/.claude/rules/a.md',
      sourceHash: 'abc',
      destinationHash: 'old',
      action: 'review',
      state: 'pending',
    },
    {
      id: 'blocked',
      resourceId: 'config',
      deviceId: 'device',
      name: 'Settings',
      sourcePath: '~/.claude/settings.json',
      destinationPath: '',
      action: 'review',
      state: 'pending',
      reason: 'Needs a migration adapter',
    },
  ],
};
describe('review', () => {
  it('requires explicit conflict choices and an explicit skip for unsupported resources', async () => {
    vi.spyOn(transfersApi, 'overview').mockResolvedValue({
      devices: [device],
      tasks: [structuredClone(task)],
    });
    const run = vi.spyOn(transfersApi, 'run').mockResolvedValue({ ...task, state: 'running' });
    render(
      <TransferPanel
        section="transfers"
        catalog={CATALOG}
        selection={[]}
        onSelection={() => {}}
        onDevices={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review copy' }));
    const copy = screen.getByRole('button', { name: 'Copy reviewed resources' });
    expect(copy).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip blocked items' }));
    expect(copy).toBeDisabled();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Action for Existing rule on Office Mac' }),
      { target: { value: 'replace' } },
    );
    expect(copy).toBeEnabled();
    fireEvent.click(copy);
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith('task', { blocked: 'skip', conflict: 'replace' }),
    );
  });
  it('offers restore on completed replacements', async () => {
    vi.spyOn(transfersApi, 'overview').mockResolvedValue({
      devices: [device],
      tasks: [
        {
          ...task,
          state: 'complete',
          items: [{ ...task.items[1], action: 'replace', state: 'complete', backupId: 'backup' }],
        },
      ],
    });
    const restore = vi
      .spyOn(transfersApi, 'restore')
      .mockResolvedValue({ ...task, state: 'complete', items: [] });
    render(
      <TransferPanel
        section="transfers"
        catalog={CATALOG}
        selection={[]}
        onSelection={() => {}}
        onDevices={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review copy' }));
    fireEvent.click(screen.getByText('Existing rule'));
    const button = screen.getByRole('button', { name: 'Restore previous destination copy' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(restore).toHaveBeenCalledWith('task', 'conflict'));
  });
  it('saves project folder mappings and ordered selection rules before comparison', async () => {
    vi.spyOn(transfersApi, 'overview').mockResolvedValue({ devices: [device], tasks: [] });
    const save = vi
      .spyOn(transfersApi, 'saveDraft')
      .mockResolvedValue({ ...task, state: 'draft', items: [] });
    const compare = vi.spyOn(transfersApi, 'compare').mockResolvedValue(task);
    const selection: Selection = [{ scope: 'project', projectId: 'p-app', include: true }];
    render(
      <TransferPanel
        section="transfers"
        catalog={CATALOG}
        selection={selection}
        onSelection={() => {}}
        onDevices={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Office Mac · office' }));
    const mapping = screen.getByPlaceholderText(/\/Users\/test\/Projects\//);
    fireEvent.change(mapping, { target: { value: '/Users/test/code/app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save task & compare' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        name: 'Resource copy',
        selection,
        targets: [{ deviceId: 'device', projects: { 'p-app': '/Users/test/code/app' } }],
      }),
    );
    await waitFor(() => expect(compare).toHaveBeenCalledWith('task'));
  });
});
