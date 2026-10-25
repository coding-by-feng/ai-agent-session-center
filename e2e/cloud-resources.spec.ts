import { test, expect, publish, ok, api, job } from './fixtures/cloudTopology';
import { mkdir } from 'node:fs/promises';
const base = '/api/resources/cloud';
test('A saves from Library; B sees changed in both places, chooses the cloud copy, and restores its own', async ({
  topology: t,
  a,
  b,
}) => {
  const errors: string[] = [];
  a.on('pageerror', (e) => errors.push(e.message));
  b.on('pageerror', (e) => errors.push(e.message));
  expect(t.a.home).not.toBe(t.b.home);
  expect(t.a.binding.deviceId).not.toBe(t.b.binding.deviceId);
  // Saved connector reload while the browser still uses local notes must have a usable health action.
  expect((await t.control('reload-cloud', { device: 'a' })).state).toBe('offline');
  const trafficBefore = (await t.control('traffic')).length;
  await a.reload();
  await expect(a.getByText(/Cloud · offline/)).toBeVisible();
  expect(
    await a.evaluate(() => (window as any).cloudAcceptanceNotes.getState().identity),
  ).toBeNull();
  await a.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  await expect(a.getByText(/Cloud · connected/)).toBeVisible();
  await t.control('fault', { device: 'a', kind: 'health-outage' });
  await a.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  await expect(a.getByText(/Cloud · offline/)).toBeVisible();
  await a.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  await expect(a.getByText(/Cloud · connected/)).toBeVisible();
  const recoveryTraffic = (await t.control('traffic'))
    .slice(trafficBefore)
    .filter((r: any) => r.device === 'a');
  expect(recoveryTraffic.filter((r: any) => r.path === '/v1/health')).toHaveLength(3);
  expect(recoveryTraffic.every((r: any) => r.method === 'GET')).toBe(true);
  expect(recoveryTraffic.some((r: any) => r.path.startsWith('/v1/skill-notes'))).toBe(false);
  // AASC-62 (Library flow since Oct 23 2026): A selects resources in Library and saves them from
  // the bar under the list; the review is one dialog (focus trapped, Escape returns focus) that
  // leaves blocked ones out.
  await a.getByRole('tab', { name: 'Library', exact: true }).click();
  await a.getByRole('button', { name: 'Select', exact: true }).click();
  await a.getByRole('checkbox', { name: /^Select all/ }).check();
  const bar = a.getByRole('region', { name: 'Selected resources' });
  const saveButton = bar.getByRole('button', { name: /^Save( \d+)? to cloud$/ });
  await saveButton.click();
  await expect(a.getByRole('dialog')).toBeVisible();
  await a.keyboard.press('Shift+Tab');
  expect(await a.getByRole('dialog').evaluate((el) => el.contains(document.activeElement))).toBe(
    true,
  );
  await a.keyboard.press('Escape');
  await expect(a.getByRole('dialog')).toBeHidden();
  await expect(saveButton).toBeFocused();
  await saveButton.click();
  await a.getByRole('button', { name: /^Save \d+ resources? to cloud$/ }).click();
  // The Library row says it syncs; Cloud sync lists it as Synced (a folded group: open it).
  await expect(
    a.getByRole('list', { name: 'Resources' }).getByRole('img', { name: 'Cloud: Synced' }).first(),
  ).toBeVisible();
  await a.getByRole('tab', { name: /^Cloud sync/ }).click();
  await a.getByRole('button', { name: /^Synced/ }).click();
  const aRow = a.getByRole('listitem').filter({ hasText: 'acceptance' });
  await expect(aRow.getByText('Synced', { exact: true })).toBeVisible();
  const v = (await ok(t, 'b', base + '/sync-status')).items.find(
    (i: any) => i.name === 'acceptance',
  );
  expect(v).toMatchObject({ state: 'cloud-only', cloudVersion: 1 });
  expect(JSON.stringify(v)).not.toContain(t.root);
  // B already has its own edit of the same skill: changed in both places, so Sync now waits for
  // a choice and touches nothing until it gets one.
  await t.control('write', {
    device: 'b',
    path: '.claude/skills/acceptance/SKILL.md',
    bytes: 'B original edits\n',
  });
  await b.reload();
  const bRow = b.getByRole('listitem').filter({ hasText: 'acceptance' });
  await expect(bRow.getByText('Changed in both places')).toBeVisible();
  await expect(b.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  // A portable ZIP is output only; it installs nothing.
  const dl = await job(
    t,
    'b',
    (await ok(t, 'b', base + '/downloads', { resourceId: v.resourceId, version: 1 })).id,
  );
  expect(dl.state).toBe('complete');
  const response = await fetch(t.bUrl + base + `/downloads/${dl.id}/file`, {
    headers: (await import('./fixtures/cloudTopology')).headers(t, 'b'),
  });
  expect(response.status).toBe(200);
  expect(
    Buffer.from(await response.arrayBuffer())
      .subarray(0, 2)
      .toString(),
  ).toBe('PK');
  expect(await t.control('read', { device: 'b', path: '.claude/skills/acceptance/SKILL.md' })).toBe(
    'B original edits\n',
  );
  await bRow.getByRole('button', { name: 'Use cloud’s' }).click();
  await mkdir('test-screenshots/task14', { recursive: true });
  await b.screenshot({
    animations: 'disabled',
    path: 'test-screenshots/task14/sync-choice-desktop.png',
  });
  await b.setViewportSize({ width: 390, height: 844 });
  await b.screenshot({
    animations: 'disabled',
    path: 'test-screenshots/task14/sync-choice-390.png',
  });
  expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await b.getByRole('button', { name: 'Sync now (1)' }).click();
  // Synced, it moves to the Synced group, which starts folded.
  await b.getByRole('button', { name: /^Synced/ }).click();
  await expect(bRow.getByText('Synced', { exact: true })).toBeVisible();
  expect(await t.control('read', { device: 'b', path: '.claude/skills/acceptance/SKILL.md' })).toBe(
    await t.control('read', { device: 'a', path: '.claude/skills/acceptance/SKILL.md' }),
  );
  // The replaced copy is backed up: Activity restores it.
  await b.getByRole('button', { name: /Activity/ }).click();
  await b.getByRole('button', { name: 'Restore backup' }).click();
  await expect(b.getByText('Backup restored', { exact: true })).toBeVisible();
  expect(await t.control('read', { device: 'b', path: '.claude/skills/acceptance/SKILL.md' })).toBe(
    'B original edits\n',
  );
  expect(errors).toEqual([]);
});
test('lost commit response replays one immutable receipt; disappearing BE upload retries after restart; revoked device cannot publish', async ({
  topology: t,
}) => {
  const plan = await ok(t, 'a', base + '/publish-plans', {
    selection: [{ scope: 'global', type: 'skill', include: true }],
  });
  await t.control('fault', { kind: 'after-commit' });
  const j = await job(t, 'a', (await ok(t, 'a', base + `/publish-plans/${plan.id}/run`, {})).id);
  expect(j.state).toBe('failed');
  const retry = await job(t, 'a', (await ok(t, 'a', base + `/jobs/${j.id}/retry`, {})).id);
  expect(retry.state).toBe('complete');
  const calls = await t.control('traffic');
  expect(calls.filter((x: any) => x.path === '/v1/resources/uploads')).toHaveLength(1);
  expect(calls.filter((x: any) => x.path.endsWith('/commit'))).toHaveLength(2);
  const before = (await ok(t, 'b', base + '/resources')).items[0];
  expect(before.version).toBe(1);
  await t.control('write', {
    path: '.claude/skills/acceptance/SKILL.md',
    bytes: '# Acceptance\nUpdated portable bytes\n',
  });
  const p2 = await ok(t, 'a', base + '/publish-plans', {
    selection: [{ scope: 'global', type: 'skill', include: true }],
  });
  await t.control('fault', { kind: 'before-put' });
  const failed = await job(t, 'a', (await ok(t, 'a', base + `/publish-plans/${p2.id}/run`, {})).id);
  expect(failed.state).toBe('failed');
  expect((await ok(t, 'a', base + '/status')).state).toBe('offline');
  await t.control('resume-be');
  expect(
    (await job(t, 'a', (await ok(t, 'a', base + `/jobs/${failed.id}/retry`, {})).id)).state,
  ).toBe('complete');
  expect((await ok(t, 'b', base + '/resources')).items[0].version).toBe(2);
  await t.control('revoke', { device: 'b' });
  expect((await api(t, 'b', base + '/resources')).error.code).toBe('revoked');
  expect((await ok(t, 'b', base + '/status')).state).toBe('revoked');
});
test('retired endpoint probes are unavailable and never dispatch any cloud or Git work', async ({
  topology: t,
}) => {
  const before = await t.control('traffic');
  const head = await t.control('git', { directory: 'seed', args: ['rev-parse', 'HEAD'] });
  for (const prefix of ['transfers', 'sync'])
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await api(
        t,
        'a',
        `/api/resources/${prefix}/tasks/deadbeef/run`,
        method === 'GET' ? undefined : {},
        method,
      );
      expect(r).toMatchObject({ status: 404, success: false, error: 'Not found' });
    }
  expect(await t.control('traffic')).toEqual(before);
  expect(await t.control('git', { directory: 'seed', args: ['rev-parse', 'HEAD'] })).toBe(head);
});
