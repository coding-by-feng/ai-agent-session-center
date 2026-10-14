import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudAliases } from '../server/cloud/aliases.js';
import type { CloudConnector } from '../server/cloud/types.js';
import type { ResourceSummary } from '../src/types/resources.js';
const accountId = '11111111-1111-4111-8111-111111111111';
const identity = { backendOrigin: 'https://example.test', accountId, generation: 1 };
const key = 'claude:review';
let home: string,
  resources: ResourceSummary[],
  records: any[],
  connection: any,
  offline: boolean,
  stops: Set<() => void>,
  cloud: CloudConnector;
const resource = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: 'id1',
  type: 'skill',
  agent: 'claude',
  scope: 'global',
  origin: 'user',
  format: 'markdown',
  name: 'review',
  path: '~/.claude/skills/review',
  fileCount: 1,
  bytes: 1,
  mtimeMs: 0,
  repo: { status: 'not-tracked' },
  variantIds: [],
  findingCodes: [],
  ...over,
});
const note = (value: any = { fav: false, tags: [], abbr: 'rv', cli: true }, k = key) => ({
  key: k,
  value,
  version: 1,
  deleted: false,
  tagDots: [],
});
const service = () =>
  createCloudAliases({
    cloud,
    home,
    directory: join(home, 'private'),
    catalog: () => ({ state: 'ready', resources }),
  });
const file = () => join(home, '.claude/commands/rv.md');
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-cloud-alias-')));
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  resources = [resource()];
  records = [note()];
  connection = { ...identity, deviceId: accountId, deviceName: 'test' };
  offline = false;
  stops = new Set();
  cloud = {
    status: () => ({ connection, state: offline ? 'offline' : 'connected', lastError: null }),
    client: {
      request: vi.fn(async () => {
        if (offline) throw new Error('offline');
        return { records, cursor: 'end', hasMore: false };
      }),
    },
    onStop(fn) {
      stops.add(fn);
      return () => stops.delete(fn);
    },
  } as CloudConnector;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const install = async (s: Awaited<ReturnType<typeof service>>, keys = [key]) => {
  await s.setEnabled(true);
  const p = await s.preview(keys, identity);
  return s.reconcile(keys, p.reviewId, identity);
};
describe('acknowledged cloud aliases', () => {
  it('synced_alias_without_target_needs_resource', async () => {
    resources = [];
    const s = await service();
    expect((await install(s))[0].state).toBe('needs-resource');
    expect(existsSync(file())).toBe(false);
  });
  it('handwritten_command_is_preserved', async () => {
    mkdirSync(join(home, '.claude/commands'));
    writeFileSync(file(), 'mine');
    const s = await service();
    expect((await install(s))[0].state).toBe('conflict');
    expect(readFileSync(file(), 'utf8')).toBe('mine');
  });
  it('removal_only_touches_marked_file', async () => {
    const s = await service();
    await install(s);
    writeFileSync(file(), 'now mine');
    records = [note({ fav: false, tags: [] })];
    const p = await s.preview([key], identity);
    expect((await s.reconcile([key], p.reviewId, identity))[0].state).toBe('conflict');
    expect(readFileSync(file(), 'utf8')).toBe('now mine');
  });
  it('device_opt_out_writes_nothing', async () => {
    const s = await service();
    const p = await s.preview([key], identity);
    expect((await s.reconcile([key], p.reviewId, identity))[0].state).toBe('disabled');
    expect(existsSync(file())).toBe(false);
  });
  it('local_real_name_collision_is_visible', async () => {
    resources.push(
      resource({ id: 'real', type: 'command', name: 'rv', path: '~/.claude/commands/other.md' }),
    );
    const s = await service();
    expect((await install(s))[0].state).toBe('conflict');
    expect(existsSync(file())).toBe(false);
  });
  it('target_install_allows_retry', async () => {
    resources = [];
    const s = await service();
    await install(s);
    resources = [resource()];
    expect((await s.retryAcknowledgedTarget(key))[0].state).toBe('installed');
    expect(readFileSync(file(), 'utf8')).toContain('review');
  });
  it('persists opt-in, acknowledgment and approval for offline same-account retry', async () => {
    resources = [];
    const s = await service();
    await install(s);
    const restarted = await service();
    offline = true;
    resources = [resource()];
    expect((await restarted.retryAcknowledgedTarget(key))[0].state).toBe('installed');
  });
  it('changed acknowledged intent requires new review', async () => {
    const s = await service();
    await s.setEnabled(true);
    const p = await s.preview([key], identity);
    records = [note({ fav: false, tags: [], abbr: 'rr', cli: true })];
    await expect(s.reconcile([key], p.reviewId, identity)).rejects.toThrow(/review/i);
    expect(existsSync(file())).toBe(false);
  });
  it('account changes reject stale review and old target retry', async () => {
    const s = await service();
    await install(s);
    const p = await s.preview([key], identity);
    for (const stop of stops) stop();
    connection = {
      ...connection,
      accountId: '22222222-2222-4222-8222-222222222222',
      generation: 2,
    };
    await expect(s.reconcile([key], p.reviewId, identity)).rejects.toThrow(/connection/i);
    expect(await s.retryAcknowledgedTarget(key)).toEqual([]);
  });
  it('disconnect blocks cached writes and leaves installed files', async () => {
    const s = await service();
    await install(s);
    for (const stop of stops) stop();
    connection = null;
    offline = true;
    await expect(s.preview([key], identity)).rejects.toThrow(/disconnected/i);
    expect(await s.retryAcknowledgedTarget(key)).toEqual([]);
    expect(existsSync(file())).toBe(true);
  });
  it('ambiguous local matches never choose by scan order', async () => {
    resources.push(
      resource({ id: 'second', scope: 'project', path: '~/project/.claude/skills/review' }),
    );
    const s = await service();
    expect((await install(s))[0]).toMatchObject({
      state: 'conflict',
      message: expect.stringMatching(/multiple/i),
    });
  });
  it('codex plugin targets are unsupported', async () => {
    const k = 'codex:plugin:review';
    records = [note(undefined, k)];
    resources = [resource({ agent: 'codex', origin: 'plugin', pluginName: 'plugin' })];
    const s = await service();
    expect((await install(s, [k]))[0].state).toBe('unsupported');
  });
  it('a parent symlink cannot redirect alias writes', async () => {
    const outside = join(home, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(home, '.claude/commands'));
    const s = await service();
    expect((await install(s))[0].state).toBe('conflict');
    expect(existsSync(join(outside, 'rv.md'))).toBe(false);
  });
  it('explicit target retry cannot apply newly changed intent', async () => {
    resources = [];
    const s = await service();
    await install(s);
    resources = [resource()];
    records = [note({ fav: false, tags: [], abbr: 'changed', cli: true })];
    expect((await s.retryAcknowledgedTarget(key))[0].state).toBe('conflict');
    expect(existsSync(file())).toBe(false);
  });
});

it('a target retry cannot implicitly adopt another account’s marked alias', async () => {
  resources = [];
  const s = await service();
  await install(s);
  connection = { ...connection, accountId: '22222222-2222-4222-8222-222222222222', generation: 2 };
  resources = [resource()];
  const other = { ...identity, accountId: connection.accountId, generation: 2 };
  const p = await s.preview([key], other);
  await s.reconcile([key], p.reviewId, other);
  connection = { ...connection, ...identity };
  const out = await s.retryAcknowledgedTarget(key);
  expect(out[0].state).toBe('conflict');
  expect(readFileSync(file(), 'utf8')).toContain('review');
});
it('an old account removal cannot remove a file explicitly adopted by another account', async () => {
  const s = await service();
  await install(s);
  connection = { ...connection, accountId: '22222222-2222-4222-8222-222222222222', generation: 2 };
  const other = { ...identity, accountId: connection.accountId, generation: 2 };
  const p = await s.preview([key], other);
  await s.reconcile([key], p.reviewId, other);
  connection = { ...connection, ...identity };
  records = [note({ fav: false, tags: [] })];
  const p2 = await s.preview([key], identity);
  await s.reconcile([key], p2.reviewId, identity);
  expect(existsSync(file())).toBe(true);
});
it('review cannot write if a file changes after preview', async () => {
  const s = await service();
  await s.setEnabled(true);
  const p = await s.preview([key], identity);
  mkdirSync(join(home, '.claude/commands'));
  writeFileSync(file(), 'my command');
  await expect(s.reconcile([key], p.reviewId, identity)).rejects.toThrow(/review/i);
  expect(readFileSync(file(), 'utf8')).toBe('my command');
});
it('a late acknowledged fetch from an old account cannot populate cache or write', async () => {
  const s = await service();
  await s.setEnabled(true);
  let resolve: (data: any) => void = () => {};
  cloud.client.request = () =>
    new Promise((r) => {
      resolve = r;
    });
  const p = s.preview([key], identity);
  await new Promise((r) => setTimeout(r, 0));
  for (const stop of stops) stop();
  connection = { ...connection, accountId: '22222222-2222-4222-8222-222222222222', generation: 2 };
  resolve({ records, cursor: 'end', hasMore: false });
  await expect(p).rejects.toThrow(/connection/i);
  expect(existsSync(file())).toBe(false);
});
it('changing target kind preserves overlapping Claude file and removes only obsolete Codex file', async () => {
  records = [note(undefined, 'shared:review')];
  resources = [resource({ agent: 'shared' })];
  const s = await service();
  await install(s, ['shared:review']);
  resources = [resource({ agent: 'shared', type: 'command' })];
  const p = await s.preview(['shared:review'], identity);
  expect((await s.reconcile(['shared:review'], p.reviewId, identity))[0].state).toBe('installed');
  expect(existsSync(file())).toBe(true);
  expect(existsSync(join(home, '.codex/prompts/rv.md'))).toBe(true);
  expect(existsSync(join(home, '.codex/skills/rv/SKILL.md'))).toBe(false);
});
it('a handwritten previous alias blocks replacement before creating the new file', async () => {
  const s = await service();
  await install(s);
  writeFileSync(file(), 'mine');
  records = [note({ fav: false, tags: [], abbr: 'rr', cli: true })];
  const p = await s.preview([key], identity);
  expect(p.statuses[0].state).toBe('conflict');
  await s.reconcile([key], p.reviewId, identity);
  expect(existsSync(join(home, '.claude/commands/rr.md'))).toBe(false);
  expect(readFileSync(file(), 'utf8')).toBe('mine');
});
it('full acknowledged replacement removes restored-history ghosts and never trusts partial pages', async () => {
  const s = await service();
  await install(s);
  records = [];
  const p = await s.preview([key], identity);
  expect(p.changes.some((x) => x.action === 'remove')).toBe(true);
  await s.reconcile([key], p.reviewId, identity);
  expect(existsSync(file())).toBe(false);
  records = [note()];
  let calls = 0;
  cloud.client.request = async () =>
    ++calls === 1
      ? { records, cursor: 'next', hasMore: true }
      : { records: [{ malformed: true }], cursor: 'end', hasMore: false };
  await expect(s.preview([key], identity)).rejects.toThrow(/invalid/i);
  expect(existsSync(file())).toBe(false);
});
it('returning to an account under a new generation cannot revive old target approvals', async () => {
  resources = [];
  const s = await service();
  await install(s);
  for (const stop of stops) stop();
  connection = { ...connection, accountId: '22222222-2222-4222-8222-222222222222', generation: 2 };
  resources = [resource()];
  expect(await s.retryAcknowledgedTarget(key)).toEqual([]);
  connection = { ...connection, ...identity, generation: 3 };
  expect(await s.retryAcknowledgedTarget(key)).toEqual([]);
  expect(existsSync(file())).toBe(false);
});
it('shared plugin aliases also refuse the unverified Codex adapter', async () => {
  const k = 'shared:plugin:review';
  records = [note(undefined, k)];
  resources = [resource({ agent: 'shared', origin: 'plugin', pluginName: 'plugin' })];
  const s = await service();
  expect((await install(s, [k]))[0].state).toBe('unsupported');
  expect(existsSync(file())).toBe(false);
});
it('partial adoption of another account’s shared alias is an actionable conflict', async () => {
  records = [note(undefined, 'shared:review')];
  resources = [resource({ agent: 'shared' })];
  const s = await service();
  await install(s, ['shared:review']);
  connection = { ...connection, accountId: '22222222-2222-4222-8222-222222222222', generation: 2 };
  records = [note()];
  resources = [resource()];
  const other = { ...identity, accountId: connection.accountId, generation: 2 };
  const p = await s.preview([key], other);
  expect(p.statuses[0]).toMatchObject({
    state: 'conflict',
    message: expect.stringMatching(/shared alias/i),
  });
  expect(existsSync(file())).toBe(true);
  expect(existsSync(join(home, '.codex/skills/rv/SKILL.md'))).toBe(true);
});

it.each(['codex','shared'] as const)('I1: %s skill survives its package-directory catalog rescan',async agent=>{const k=`${agent}:review`;records=[note(undefined,k)];resources=[resource({agent})];const s=await service();await install(s,[k]);resources.push(resource({id:'generated-codex',agent:'codex',name:'rv',path:'~/.codex/skills/rv'}));if(agent==='shared')resources.push(resource({id:'generated-claude',agent:'claude',type:'command',name:'rv',path:'~/.claude/commands/rv.md'}));expect((await s.status([k],identity)).statuses[0].state).toBe('installed');expect((await s.preview([k],identity)).statuses[0].state).toBe('installed');expect((await s.retryAcknowledgedTarget(k))[0].state).toBe('installed');resources.push(resource({id:'unrelated',agent:'codex',type:'command',name:'rv',path:'~/project/.codex/prompts/rv.md'}));expect((await s.preview([k],identity)).statuses[0].state).toBe('conflict');});
it('I5: missing target review discloses exact acknowledged alias and retry installs that value',async()=>{resources=[];const s=await service();await s.setEnabled(true);const p=await s.preview([key],identity);expect(p.intents).toEqual([{key,agent:'claude',target:'review',abbr:'rv',cli:true}]);await s.reconcile([key],p.reviewId,identity);resources=[resource()];expect((await s.retryAcknowledgedTarget(key))[0].state).toBe('installed');expect(readFileSync(file(),'utf8')).toContain('review');expect(existsSync(join(home,'.claude/commands/rr.md'))).toBe(false);});
it('I5: not-yet-scanned target still discloses acknowledged alias desire',async()=>{const s=await createCloudAliases({cloud,home,directory:join(home,'private'),catalog:()=>({state:'scanning',resources:[]})});const p=await s.preview([key],identity);expect(p.intents).toEqual([{key,agent:'claude',target:'review',abbr:'rv',cli:true}]);});
