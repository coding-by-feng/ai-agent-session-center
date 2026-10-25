import { test, expect, publish, ok, api, job } from './fixtures/cloudTopology';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const base = '/api/resources/cloud';
test('real clone survives resource conflict; reviewed retry retains checkout; dirty and diverged pulls preserve local work', async ({
  topology: t,
  b,
}) => {
  const v = await publish(t),
    pin = { resourceId: v.manifest.resourceId, version: 1 };
  const project = {
    id: randomUUID(),
    version: 1,
    name: 'Acceptance project',
    repository: {
      provider: 'github',
      owner: 'fixture-owner',
      name: 'fixture-repo',
      url: 'https://github.com/fixture-owner/fixture-repo',
      branch: 'main',
    },
    description: 'Synthetic fixture only',
    resources: [pin],
    deleted: false,
  };
  await ok(t, 'a', base + '/projects', {
    mutationId: randomUUID(),
    baseVersion: null,
    value: project,
  });
  await t.control('write', {
    device: 'b',
    path: '.claude/skills/acceptance/SKILL.md',
    bytes: 'private receiver version\n',
  });
  const j = await job(
    t,
    'b',
    (
      await ok(t, 'b', base + `/projects/${project.id}/get`, {
        parentPath: t.b.home,
        directoryName: 'receiver-checkout',
        transport: 'https',
        resourceVersions: [pin],
      })
    ).id,
  );
  expect(j.state).toBe('partial');
  expect(j.steps.find((s: any) => s.id === 'git').state).toBe('complete');
  expect(await t.control('read', { device: 'b', path: 'receiver-checkout/README.md' })).toBe(
    'fixture repository\n',
  );
  const local = await ok(t, 'b', base + `/projects/${project.id}/local`);
  expect(local.openUrl).toContain('receiver-checkout');
  const inode = await t.control('stat', { device: 'b', path: 'receiver-checkout/.git' });
  const plan = await ok(t, 'b', base + `/projects/jobs/${j.id}/resources-plan`, {});
  expect(plan.items[0].action).toBe('replace');
  expect(
    (
      await job(
        t,
        'b',
        (
          await ok(t, 'b', base + `/projects/jobs/${j.id}/retry-resources`, {
            review: { planId: plan.id, decisions: { [pin.resourceId]: 'replace-with-backup' } },
          })
        ).id,
      )
    ).state,
  ).toBe('complete');
  expect(await t.control('stat', { device: 'b', path: 'receiver-checkout/.git' })).toEqual(inode);
  const head = await t.control('git', {
    device: 'b',
    directory: 'receiver-checkout',
    args: ['rev-parse', 'HEAD'],
  });
  await t.control('write', {
    device: 'b',
    path: 'receiver-checkout/README.md',
    bytes: 'dirty local data\n',
  });
  expect((await ok(t, 'b', base + `/projects/${project.id}/local`)).state).toBe('dirty');
  const dirty = await job(t, 'b', (await ok(t, 'b', base + `/projects/${project.id}/pull`, {})).id);
  expect(dirty.state).toBe('failed');
  expect(await t.control('read', { device: 'b', path: 'receiver-checkout/README.md' })).toBe(
    'dirty local data\n',
  );
  expect(
    await t.control('git', {
      device: 'b',
      directory: 'receiver-checkout',
      args: ['rev-parse', 'HEAD'],
    }),
  ).toBe(head);
  await t.control('git', { device: 'b', directory: 'receiver-checkout', args: ['add', '.'] });
  await t.control('git', {
    device: 'b',
    directory: 'receiver-checkout',
    args: ['commit', '-m', 'local commit'],
  });
  const localHead = await t.control('git', {
    device: 'b',
    directory: 'receiver-checkout',
    args: ['rev-parse', 'HEAD'],
  });
  await t.control('git', {
    directory: 'seed',
    args: ['commit', '--allow-empty', '-m', 'remote advances'],
  });
  await t.control('git', { directory: 'seed', args: ['push', 'origin', 'main'] });
  const diverged = await job(
    t,
    'b',
    (await ok(t, 'b', base + `/projects/${project.id}/pull`, {})).id,
  );
  expect(diverged.state).toBe('failed');
  expect(
    await t.control('git', {
      device: 'b',
      directory: 'receiver-checkout',
      args: ['rev-parse', 'HEAD'],
    }),
  ).toBe(localHead);
  // AASC-63: a refused pull never fetches, so the remote commit is not seen yet: only `ahead`.
  // Check fetches from GitHub; then both sides have commits, and the checkout reads `diverged`.
  expect((await ok(t, 'b', base + `/projects/${project.id}/local`)).state).toBe('ahead');
  expect(await ok(t, 'b', base + `/projects/${project.id}/check`, {})).toMatchObject({
    state: 'diverged',
    ahead: 1,
    behind: 1,
  });
  // Both clients compare the same real revision; no implicit rebase of a stale draft.
  const updated = await ok(
    t,
    'a',
    base + `/projects/${project.id}`,
    { mutationId: randomUUID(), baseVersion: 1, value: { ...project, name: 'A revision' } },
    'PUT',
  );
  expect(updated.version).toBe(2);
  expect(
    await api(
      t,
      'b',
      base + `/projects/${project.id}`,
      { mutationId: randomUUID(), baseVersion: 1, value: { ...project, name: 'B draft' } },
      'PUT',
    ),
  ).toMatchObject({
    status: 409,
    error: { code: 'version_conflict', details: { headVersion: 2 } },
  });
  expect((await ok(t, 'b', base + '/status')).state).toBe('connected');
  // AASC-63: the row shows the repository and how it compares with GitHub. A checkout with commits
  // on both sides is offered neither Pull nor Push, only Check: merging stays the user's step.
  await b.reload();
  await b.getByRole('tab', { name: 'Projects', exact: true }).click();
  const row = b.getByRole('listitem').filter({ hasText: 'fixture-repo' });
  await expect(row.getByText('1 commit to push · 1 behind')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Pull' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Push' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Check' })).toBeEnabled();
  await mkdir('test-screenshots/task14', { recursive: true });
  await b.screenshot({
    animations: 'disabled',
    path: 'test-screenshots/task14/project-desktop.png',
  });
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({ animations: 'disabled', path: 'test-screenshots/task14/project-390.png' });
  expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The project browser opens in its own window (like every Project Browser entry point).
  const opened = b.context().waitForEvent('page');
  await row.getByRole('link', { name: 'Open', exact: true }).click();
  const browser = await opened;
  await expect(
    browser.getByText('Fixture project-browser boundary', { exact: true }),
  ).toBeVisible();
  expect(browser.url()).toBe(new URL(local.openUrl, t.bUrl).href);
  await browser.close();
});
