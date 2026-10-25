// test/mcp/tools.cloudProjectWrite.test.ts — the P6 project record writes (server/mcp/tools/cloudProjectWrite.ts):
// `cloud_project_create` and `cloud_project_update` leave the Mac (outward) and `cloud_project_remove` takes a project off
// the account (destructive), so each waits for the person, names the account it acts as and runs only as that account
// (P6-6); `cloud_project_set_account` and `cloud_project_associate` are writes on this Mac. Every one is global-only
// (P6-4), within the call budget (P6-15), and a folder a central names obeys the folder rule (P6-14). Create, set_account
// and remove need routes only newer builds have (P6-11); their answers here are main's shapes. /api is a fake client;
// nothing reaches a route, git or the file system.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCloudMemo } from '../../server/mcp/cloudMemo.js';
import { allTools } from '../../server/mcp/registry.js';
import { resetCloudBudget } from '../../server/mcp/tools/cloudWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { ACCOUNT, BACKEND, CLOUD_HEADERS, cloudFail, CONNECTION, PROJECT_ID, RESOURCE_ID, STATUS_PATH } from './cloudFixtures.js';
import { LOCAL_BRANCH, LOCAL_MAIN, MISSING, REMOVED_RECORD, SAVED_PROJECT_ID } from './cloudMainShapes.js';
import { askAndRun, askOf, cloudCtx, switchAccount } from './cloudWriteKit.js';
import { envelope, run, runRefused, type Answer, type ApiCall } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const HOME = homedir();
const FOLDER = join(HOME, 'code', 'demo');
const SAVED_FOLDER = join(HOME, 'code', 'saved');
const OTHER_RESOURCE = 'b1c2d3e4-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const KEY_A = `${BACKEND}|${ACCOUNT}|3`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANGED = 'What you asked about changed after the person was asked, so nothing was done.';

const CLOUD = '/resources/cloud';
const CANDIDATES_ROUTE = `GET ${CLOUD}/projects/candidates`;
const RECORD_PATH = `${CLOUD}/projects/${PROJECT_ID}`;

const repository = (name: string) => ({ provider: 'github', owner: 'octo', name, url: `https://github.com/octo/${name}`, branch: 'main' });

/** Main's candidates (cloudMainShapes CANDIDATES), with folders under this machine's home so the folder rule passes. */
const CANDIDATES = {
  items: [
    { path: FOLDER, repository: repository('demo'), projectId: null },
    { path: SAVED_FOLDER, repository: repository('saved'), projectId: SAVED_PROJECT_ID },
  ],
};

const record = (version = 3, over: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  version,
  name: 'demo',
  repository: repository('demo'),
  description: 'A demo project.',
  resources: [{ resourceId: RESOURCE_ID, version: 2 }],
  deleted: false,
  ...over,
});

const failureOf = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

const writes = (calls: ApiCall[]): ApiCall[] => calls.filter((c) => c.method !== 'GET');
const escaped = (s: string): string => s.replace(/[.|*+?^${}()[\]\\]/g, '\\$&');

afterEach(() => {
  resetCloudMemo();
  resetCloudBudget();
});

// ---------------------------------------------------------------------------
// cloud_project_create
// ---------------------------------------------------------------------------

describe('cloud_project_create', () => {
  it('create on a build without the candidates route is UNAVAILABLE before any card', async () => {
    for (const missing of [MISSING.idClash, MISSING.notFound, MISSING.page, MISSING.media]) {
      const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: missing } });

      const err = await failureOf(askOf(h, 'cloud_project_create', { folder: FOLDER }));

      expect(err).toMatchObject({ code: 'UNAVAILABLE', message: 'This build of AASC cannot save a project.' });
      expect(writes(h.client.calls)).toEqual([]);
      expect(h.confirmBook.pending()).toEqual([]);
    }
  });

  it('asks for the candidates as the reviewed account', async () => {
    const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES) } });

    await askOf(h, 'cloud_project_create', { folder: FOLDER });

    expect(h.client.calls.filter((c) => c.path === `${CLOUD}/projects/candidates`)).toEqual([
      { method: 'GET', path: `${CLOUD}/projects/candidates`, headers: CLOUD_HEADERS },
    ]);
  });

  it('create of a folder that is not a candidate is NOT_FOUND, without the path', async () => {
    const folder = join(HOME, 'code', 'elsewhere');
    const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES) } });

    const err = await failureOf(askOf(h, 'cloud_project_create', { folder }));

    expect(err).toMatchObject({
      code: 'NOT_FOUND',
      message: 'That folder is not a git folder with a GitHub origin AASC lists (cloud_project_candidates).',
    });
    expect(`${err.message} ${err.hint ?? ''} ${JSON.stringify(err.data ?? {})}`).not.toContain('elsewhere');
    expect(h.confirmBook.pending()).toEqual([]);
  });

  it('create of an already saved folder is INVALID naming the project id', async () => {
    const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES) } });

    const err = await failureOf(askOf(h, 'cloud_project_create', { folder: SAVED_FOLDER }));

    expect(err.code).toBe('INVALID');
    expect(err.message).toContain(SAVED_PROJECT_ID);
    expect(err.data).toMatchObject({ projectId: SAVED_PROJECT_ID });
    expect(`${err.message} ${err.hint ?? ''} ${JSON.stringify(err.data ?? {})}`).not.toContain(SAVED_FOLDER);
    expect(h.confirmBook.pending()).toEqual([]);
  });

  it('create asks, then posts localPath and a version-1 record once allowed', async () => {
    const h = cloudCtx({
      routes: {
        [CANDIDATES_ROUTE]: envelope(CANDIDATES),
        [`POST ${CLOUD}/projects`]: (call) => envelope((call.body as { value: unknown }).value),
      },
    });

    const { ask, result } = await askAndRun(h, 'cloud_project_create', { folder: '~/code/demo', description: 'Line one.\nLine two.' });

    expect(ask.summary).toBe("AASC Cloud: save octo/demo@main as a project as 0b1f6d5e and link this Mac's folder");
    expect(ask.detail).toContain('Name: demo');
    expect(ask.detail).toContain('Line one.\nLine two.');
    expect(ask.fingerprint).toMatch(new RegExp(`^create:${escaped(KEY_A)}:[0-9a-f]{40}$`));
    const posted = writes(h.client.calls);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ method: 'POST', path: `${CLOUD}/projects`, headers: CLOUD_HEADERS });
    const body = posted[0].body as { localPath: string; mutationId: string; baseVersion: null; value: { id: string } };
    expect(body).toEqual({
      localPath: FOLDER,
      mutationId: expect.stringMatching(UUID),
      baseVersion: null,
      value: {
        id: expect.stringMatching(UUID),
        version: 1,
        name: 'demo',
        repository: repository('demo'),
        description: 'Line one.\nLine two.',
        resources: [],
        deleted: false,
      },
    });
    expect(body.mutationId).not.toBe(body.value.id);
    expect(result.data).toMatchObject({ project: { id: body.value.id, version: 1, name: 'demo', deleted: false } });
    expect(JSON.stringify(result.data)).toContain('<untrusted');
  });

  it('the create summary stays within 300 characters for the longest repository and account, its clauses whole', async () => {
    const email = `${'e'.repeat(47)}@example.test`;
    const long = { provider: 'github', owner: 'o'.repeat(39), name: 'n'.repeat(100), url: 'https://github.com/o/n', branch: 'b'.repeat(255) };
    const h = cloudCtx({
      routes: {
        [STATUS_PATH]: envelope({ connection: { ...CONNECTION, accountEmail: email }, state: 'connected', lastError: null }),
        [CANDIDATES_ROUTE]: envelope({ items: [{ path: FOLDER, repository: long, projectId: null }] }),
      },
    });

    const ask = await askOf(h, 'cloud_project_create', { folder: FOLDER, name: 'demo' });

    expect(email).toHaveLength(60);
    expect(ask?.summary.length).toBeLessThanOrEqual(300);
    expect(ask?.summary).toMatch(/^AASC Cloud: save o{39}\/n+…@b+… as a project as /);
    expect(ask?.summary).toContain(`as ${email} and link this Mac's folder`);
  });

  it('a genuine 400 from the save keeps its words: INVALID, not a missing route', async () => {
    const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES), [`POST ${CLOUD}/projects`]: MISSING.idClash } });

    const err = await failureOf(askAndRun(h, 'cloud_project_create', { folder: FOLDER }));

    expect(err).toMatchObject({ code: 'INVALID', message: 'Invalid cloud project request.', data: { cloudCode: 'invalid_request' } });
  });

  it('takes the name the central gives', async () => {
    const h = cloudCtx({
      routes: {
        [CANDIDATES_ROUTE]: envelope(CANDIDATES),
        [`POST ${CLOUD}/projects`]: (call) => envelope((call.body as { value: unknown }).value),
      },
    });

    await askAndRun(h, 'cloud_project_create', { folder: FOLDER, name: 'Demo app' });

    expect(writes(h.client.calls)[0].body).toMatchObject({ value: { name: 'Demo app', description: '' } });
  });

  it('a name or description with a hidden or control character is INVALID before any call', async () => {
    for (const args of [
      { folder: FOLDER, name: 'demo‮exe' },
      { folder: FOLDER, name: 'de\u0007mo' },
      { folder: FOLDER, name: ' demo' },
      { folder: FOLDER, description: 'fine​hidden' },
      { folder: FOLDER, description: 'bell\u0085' },
    ]) {
      const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES) } });
      const err = await failureOf(askOf(h, 'cloud_project_create', args));
      expect(err.code, JSON.stringify(args)).toBe('INVALID');
      expect(h.client.calls).toEqual([]);
    }
  });

  it('an account switched after the allow is CHANGED and posts nothing', async () => {
    const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES), [`POST ${CLOUD}/projects`]: envelope(record(1)) } });

    const err = await failureOf(askAndRun(h, 'cloud_project_create', { folder: FOLDER }, () => switchAccount(h, 'B')));

    expect(err.message).toBe(CHANGED);
    expect(writes(h.client.calls)).toEqual([]);
  });

  it('a run the person did not allow is INVALID and posts nothing', async () => {
    const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES) } });

    const err = await runRefused('cloud_project_create', { folder: FOLDER }, h.ctx);

    expect(err).toMatchObject({ code: 'INVALID', message: 'That changed; call again.' });
    expect(writes(h.client.calls)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The folder rule
// ---------------------------------------------------------------------------

describe('the folder rule', () => {
  const BAD = ['~/.ssh/keys', join(HOME, '.config', 'demo'), '~/Library/Mobile Documents/demo', '/etc/demo', 'code/demo', '~'];

  it('a hidden-folder or ~/Library path is INVALID before any call', async () => {
    for (const folder of BAD) {
      const h = cloudCtx({ routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES) } });
      const create = await failureOf(askOf(h, 'cloud_project_create', { folder }));
      const associate = await runRefused('cloud_project_associate', { id: PROJECT_ID, folder }, h.ctx);

      for (const err of [create, associate]) {
        expect(err.code, folder).toBe('INVALID');
        expect(`${err.message} ${err.hint ?? ''}`).not.toContain(folder.replace(/^~\//, ''));
      }
      expect(h.client.calls).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// cloud_project_update
// ---------------------------------------------------------------------------

describe('cloud_project_update', () => {
  const routes = (read: Answer): Record<string, Answer> => ({
    [`GET ${RECORD_PATH}`]: read,
    [`PUT ${RECORD_PATH}`]: (call) => envelope({ ...(call.body as { value: Record<string, unknown> }).value, version: 4 }),
  });

  it('update shows old and new, and puts the whole record at its version once allowed', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });

    const { ask, result } = await askAndRun(h, 'cloud_project_update', {
      id: PROJECT_ID,
      name: 'demo two',
      resources: [{ resourceId: OTHER_RESOURCE, version: 1 }],
    });

    expect(ask.summary).toBe('AASC Cloud: update project 3f2b8c1d (v3) as 0b1f6d5e: name, resources');
    expect(ask.detail).toBe(['Name: demo → demo two', 'Resources:', `+ ${OTHER_RESOURCE} v1`, `− ${RESOURCE_ID} v2`].join('\n'));
    expect(ask.fingerprint).toMatch(new RegExp(`^update:${PROJECT_ID}:v3:${escaped(KEY_A)}:[0-9a-f]{40}$`));
    const put = writes(h.client.calls);
    expect(put).toEqual([
      {
        method: 'PUT',
        path: RECORD_PATH,
        headers: CLOUD_HEADERS,
        body: {
          mutationId: expect.stringMatching(UUID),
          baseVersion: 3,
          value: { ...record(), name: 'demo two', resources: [{ resourceId: OTHER_RESOURCE, version: 1 }], version: 3 },
        },
      },
    ]);
    expect(result.data).toMatchObject({ project: { id: PROJECT_ID, version: 4, name: 'demo two' } });
  });

  it('shows a description change and a pin moved to another version', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });

    const ask = await askOf(h, 'cloud_project_update', {
      id: PROJECT_ID,
      description: 'New words.',
      resources: [{ resourceId: RESOURCE_ID, version: 5 }],
    });

    expect(ask?.summary).toBe('AASC Cloud: update project 3f2b8c1d (v3) as 0b1f6d5e: description, resources');
    expect(ask?.detail).toBe(['Description was:', 'A demo project.', 'Description becomes:', 'New words.', 'Resources:', `+ ${RESOURCE_ID} v5`, `− ${RESOURCE_ID} v2`].join('\n'));
  });

  it('a record changed after the allow (new version) is CHANGED', async () => {
    let version = 3;
    const h = cloudCtx({ routes: routes(() => envelope(record(version))) });

    const err = await failureOf(askAndRun(h, 'cloud_project_update', { id: PROJECT_ID, name: 'demo two' }, () => (version = 4)));

    expect(err.message).toBe(CHANGED);
    expect(writes(h.client.calls)).toEqual([]);
  });

  it('a record that moved between the recheck and the run puts nothing', async () => {
    let reads = 0;
    const h = cloudCtx({ routes: routes(() => envelope(record((reads += 1) >= 3 ? 4 : 3))) });

    const err = await failureOf(askAndRun(h, 'cloud_project_update', { id: PROJECT_ID, name: 'demo two' }));

    expect(err).toMatchObject({ code: 'INVALID', message: 'That changed; call again.' });
    expect(writes(h.client.calls)).toEqual([]);
  });

  it('update with nothing different is INVALID', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });

    for (const args of [
      { id: PROJECT_ID, name: 'demo' },
      { id: PROJECT_ID, description: 'A demo project.', resources: [{ resourceId: RESOURCE_ID, version: 2 }] },
    ]) {
      const err = await failureOf(askOf(h, 'cloud_project_update', args));
      expect(err).toMatchObject({ code: 'INVALID', message: 'That is already so.' });
    }
    expect(h.confirmBook.pending()).toEqual([]);
  });

  it('update with no field is INVALID before any call', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });

    expect((await failureOf(askOf(h, 'cloud_project_update', { id: PROJECT_ID }))).code).toBe('INVALID');
    expect(h.client.calls).toEqual([]);
  });

  it('pins with a repeated resource are refused by the schema', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });
    const resources = [
      { resourceId: OTHER_RESOURCE, version: 1 },
      { resourceId: OTHER_RESOURCE, version: 2 },
    ];

    await expect(askOf(h, 'cloud_project_update', { id: PROJECT_ID, resources })).rejects.toThrow();
  });

  it('a removed project is INVALID, an unknown one NOT_FOUND', async () => {
    const removed = cloudCtx({ routes: routes(envelope(record(3, { deleted: true }))) });
    const unknown = cloudCtx({ routes: routes(cloudFail(404, 'not_found', 'Cloud project was not found.')) });

    expect((await failureOf(askOf(removed, 'cloud_project_update', { id: PROJECT_ID, name: 'x' }))).code).toBe('INVALID');
    const err = await failureOf(askOf(unknown, 'cloud_project_update', { id: PROJECT_ID, name: 'x' }));
    expect(err).toMatchObject({ code: 'NOT_FOUND', message: 'Cloud project was not found.' });
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain(PROJECT_ID);
  });

  it('a new name with a hidden character is INVALID', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });

    expect((await failureOf(askOf(h, 'cloud_project_update', { id: PROJECT_ID, name: 'de‍mo' }))).code).toBe('INVALID');
  });

  it('a run the person did not allow is INVALID and puts nothing', async () => {
    const h = cloudCtx({ routes: routes(envelope(record())) });

    expect((await runRefused('cloud_project_update', { id: PROJECT_ID, name: 'x' }, h.ctx)).message).toBe('That changed; call again.');
    expect(writes(h.client.calls)).toEqual([]);
  });

  it('the 409 version_conflict says make a new plan, with cloudCode', async () => {
    const h = cloudCtx({
      routes: { [`GET ${RECORD_PATH}`]: envelope(record()), [`PUT ${RECORD_PATH}`]: cloudFail(409, 'version_conflict', 'The project changed.') },
    });

    const err = await failureOf(askAndRun(h, 'cloud_project_update', { id: PROJECT_ID, name: 'x' }));

    expect(err).toMatchObject({ message: 'The project changed.', data: { cloudCode: 'version_conflict' } });
  });
});

// ---------------------------------------------------------------------------
// cloud_project_set_account and cloud_project_associate
// ---------------------------------------------------------------------------

describe('cloud_project_set_account', () => {
  const ACCOUNT_ROUTE = `PUT ${RECORD_PATH}/account`;

  it('set_account sends the login or null; a malformed login is INVALID by the schema', async () => {
    for (const login of ['octo-cat', null]) {
      const h = cloudCtx({ routes: { [ACCOUNT_ROUTE]: envelope(LOCAL_MAIN('ready', { account: login })) } });

      const result = await run('cloud_project_set_account', { id: PROJECT_ID, login }, h.ctx);

      expect(writes(h.client.calls)).toEqual([{ method: 'PUT', path: `${RECORD_PATH}/account`, body: { login }, headers: CLOUD_HEADERS }]);
      expect(result.data).toMatchObject({ local: { id: PROJECT_ID, state: 'ready', account: login } });
    }
    const h = cloudCtx();
    for (const login of ['-octo', 'octo--cat', 'octo_cat', 'a'.repeat(40), '']) {
      await expect(run('cloud_project_set_account', { id: PROJECT_ID, login }, h.ctx)).rejects.toThrow(/Arguments refused/);
    }
    expect(h.client.calls).toEqual([]);
  });

  it('on a build without the route it is UNAVAILABLE', async () => {
    const h = cloudCtx({ routes: { [ACCOUNT_ROUTE]: MISSING.notFound } });

    const err = await runRefused('cloud_project_set_account', { id: PROJECT_ID, login: 'octo-cat' }, h.ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/^This build of AASC cannot/);
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain('octo-cat');
  });

  it('a project the account does not have stays NOT_FOUND', async () => {
    const h = cloudCtx({ routes: { [ACCOUNT_ROUTE]: cloudFail(404, 'not_found', 'Cloud project was not found.') } });

    expect((await runRefused('cloud_project_set_account', { id: PROJECT_ID, login: null }, h.ctx)).code).toBe('NOT_FOUND');
  });
});

describe('cloud_project_associate', () => {
  it('posts the folder as the live account and answers how this Mac holds it', async () => {
    const h = cloudCtx({ routes: { [`POST ${RECORD_PATH}/associate`]: envelope(LOCAL_MAIN('ready', { path: FOLDER })) } });

    const result = await run('cloud_project_associate', { id: PROJECT_ID, folder: '~/code/demo' }, h.ctx);

    expect(writes(h.client.calls)).toEqual([{ method: 'POST', path: `${RECORD_PATH}/associate`, body: { path: FOLDER }, headers: CLOUD_HEADERS }]);
    expect(result.data).toMatchObject({ local: { id: PROJECT_ID, state: 'ready', path: FOLDER } });
  });

  it('the route’s 409 checkout_mismatch keeps its words and code', async () => {
    const h = cloudCtx({
      routes: { [`POST ${RECORD_PATH}/associate`]: cloudFail(409, 'checkout_mismatch', 'Choose a canonical checkout with this remote and branch.') },
    });

    const err = await runRefused('cloud_project_associate', { id: PROJECT_ID, folder: FOLDER }, h.ctx);

    expect(err).toMatchObject({ message: 'Choose a canonical checkout with this remote and branch.', data: { cloudCode: 'checkout_mismatch' } });
  });
});

// ---------------------------------------------------------------------------
// cloud_project_remove
// ---------------------------------------------------------------------------

describe('cloud_project_remove', () => {
  const REMOVE_ROUTE = `POST ${RECORD_PATH}/remove`;
  const LOCAL_ROUTE = `GET ${RECORD_PATH}/local`;
  /** A newer build: the record, how this Mac holds it (main's shape, with `path`), and `extra`. */
  const removeRoutes = (extra: Record<string, Answer> = {}): Record<string, Answer> => ({
    [`GET ${RECORD_PATH}`]: envelope(record()),
    [LOCAL_ROUTE]: envelope(LOCAL_MAIN('ready')),
    [REMOVE_ROUTE]: envelope(REMOVED_RECORD),
    ...extra,
  });

  it('remove asks with the untouched-folder words, then posts {}', async () => {
    const h = cloudCtx({ routes: removeRoutes() });

    const { ask, result } = await askAndRun(h, 'cloud_project_remove', { id: PROJECT_ID });

    expect(ask.summary).toBe(
      'AASC Cloud: remove project 3f2b8c1d (v3) from the account for every device as 0b1f6d5e: no folder, checkout or GitHub repository is touched',
    );
    expect(ask.detail).toBe('Name: demo\nRepository: octo/demo@main');
    expect(ask.fingerprint).toBe(`remove:${PROJECT_ID}:v3:${KEY_A}`);
    expect(writes(h.client.calls)).toEqual([{ method: 'POST', path: `${RECORD_PATH}/remove`, body: {}, headers: CLOUD_HEADERS }]);
    expect(result.data).toEqual({ id: PROJECT_ID, version: 4, deleted: true });
  });

  it('the remove summary keeps "for every device" and the untouched clause with the longest account label', async () => {
    const email = `${'e'.repeat(47)}@example.test`;
    const h = cloudCtx({
      routes: removeRoutes({ [STATUS_PATH]: envelope({ connection: { ...CONNECTION, accountEmail: email }, state: 'connected', lastError: null }) }),
    });

    const ask = await askOf(h, 'cloud_project_remove', { id: PROJECT_ID });

    expect(ask?.summary.length).toBeLessThanOrEqual(300);
    expect(ask?.summary).toContain(`for every device as ${email}: no folder, checkout or GitHub repository is touched`);
  });

  it('remove on a build whose local answer has no path (the branch) is UNAVAILABLE before any card', async () => {
    const h = cloudCtx({ routes: removeRoutes({ [LOCAL_ROUTE]: envelope(LOCAL_BRANCH('ready')) }) });

    const err = await failureOf(askOf(h, 'cloud_project_remove', { id: PROJECT_ID }));

    expect(err).toMatchObject({ code: 'UNAVAILABLE', message: 'This build of AASC cannot remove a project.' });
    expect(h.client.calls.filter((c) => c.path === `${RECORD_PATH}/local`)).toEqual([{ method: 'GET', path: `${RECORD_PATH}/local`, headers: CLOUD_HEADERS }]);
    expect(writes(h.client.calls)).toEqual([]);
    expect(h.confirmBook.pending()).toEqual([]);
  });

  it('a project with no checkout here can still be removed (main answers path: null)', async () => {
    const h = cloudCtx({ routes: removeRoutes({ [LOCAL_ROUTE]: envelope(LOCAL_MAIN('missing')) }) });

    expect((await askAndRun(h, 'cloud_project_remove', { id: PROJECT_ID })).result.data).toEqual({ id: PROJECT_ID, version: 4, deleted: true });
  });

  it('a remove route missing at the run is still UNAVAILABLE, nothing removed', async () => {
    for (const missing of [MISSING.notFound, MISSING.page]) {
      const h = cloudCtx({ routes: removeRoutes({ [REMOVE_ROUTE]: missing }) });

      const err = await failureOf(askAndRun(h, 'cloud_project_remove', { id: PROJECT_ID }));

      expect(err).toMatchObject({ code: 'UNAVAILABLE', message: 'This build of AASC cannot remove a project.' });
    }
  });

  it('an already removed project is INVALID before a card; an unknown one NOT_FOUND', async () => {
    const removed = cloudCtx({ routes: { [`GET ${RECORD_PATH}`]: envelope(record(3, { deleted: true })) } });
    const unknown = cloudCtx({ routes: { [`GET ${RECORD_PATH}`]: cloudFail(404, 'not_found', 'Cloud project was not found.') } });

    expect((await failureOf(askOf(removed, 'cloud_project_remove', { id: PROJECT_ID }))).code).toBe('INVALID');
    expect((await failureOf(askOf(unknown, 'cloud_project_remove', { id: PROJECT_ID }))).code).toBe('NOT_FOUND');
    expect(writes(removed.client.calls)).toEqual([]);
  });

  it('an account switched after the allow is CHANGED and removes nothing', async () => {
    const h = cloudCtx({ routes: removeRoutes() });

    const err = await failureOf(askAndRun(h, 'cloud_project_remove', { id: PROJECT_ID }, () => switchAccount(h, 'B')));

    expect(err.message).toBe(CHANGED);
    expect(writes(h.client.calls)).toEqual([]);
  });

  it('a run the person did not allow is INVALID and removes nothing', async () => {
    const h = cloudCtx({ routes: removeRoutes() });

    expect((await runRefused('cloud_project_remove', { id: PROJECT_ID }, h.ctx)).message).toBe('That changed; call again.');
    expect(writes(h.client.calls)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every tool
// ---------------------------------------------------------------------------

const CALLS: Array<[string, Record<string, unknown>, boolean]> = [
  ['cloud_project_create', { folder: FOLDER }, true],
  ['cloud_project_update', { id: PROJECT_ID, name: 'x' }, true],
  ['cloud_project_set_account', { id: PROJECT_ID, login: 'octo-cat' }, false],
  ['cloud_project_associate', { id: PROJECT_ID, folder: FOLDER }, false],
  ['cloud_project_remove', { id: PROJECT_ID }, true],
];

describe('every project record write', () => {
  it('a project central is DENIED for all five', async () => {
    for (const kind of ['project', 'room'] as const) {
      for (const [name, args, waits] of CALLS) {
        const h = cloudCtx({ kind, routes: { [CANDIDATES_ROUTE]: envelope(CANDIDATES), [`GET ${RECORD_PATH}`]: envelope(record()) } });
        const err = waits ? await failureOf(askOf(h, name, args)) : await runRefused(name, args, h.ctx);
        expect(err.code, `${kind} ${name}`).toBe('DENIED');
        expect(h.client.calls).toEqual([]);
      }
    }
  });

  it('the 21st call in a minute is BUDGET', async () => {
    const h = cloudCtx({ routes: { [`POST ${RECORD_PATH}/associate`]: envelope(LOCAL_MAIN('ready')) } });

    for (let i = 0; i < 20; i += 1) await run('cloud_project_associate', { id: PROJECT_ID, folder: FOLDER }, h.ctx);

    expect((await runRefused('cloud_project_associate', { id: PROJECT_ID, folder: FOLDER }, h.ctx)).code).toBe('BUDGET');
    expect((await failureOf(askOf(h, 'cloud_project_remove', { id: PROJECT_ID }))).code).toBe('BUDGET');
  });

  it('the descriptions carry the rules each tool is under (Ruling 65)', () => {
    const byName = (name: string) => allTools().find((t) => t.name === name);

    expect(byName('cloud_project_create')).toMatchObject({ risk: 'outward', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_project_update')).toMatchObject({ risk: 'outward', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_project_set_account')).toMatchObject({ risk: 'write', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_project_associate')).toMatchObject({ risk: 'write', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_project_remove')).toMatchObject({ risk: 'destructive', phase: 6, toolset: 'cloud' });
    for (const [name, , waits] of CALLS) {
      const text = byName(name)?.description ?? '';
      expect(text, name).toContain('Only a global central may do this; a room or project central is DENIED.');
      expect(text, name).toContain('At most 20 cloud changes a minute (BUDGET).');
      if (waits) {
        expect(text, name).toContain(
          'It waits for the person on the Mac first (an AASC card): NEEDS_CONFIRMATION means call confirm_wait with data.confirmId.',
        );
      }
    }
    for (const name of ['cloud_project_create', 'cloud_project_set_account', 'cloud_project_remove']) {
      expect(byName(name)?.description, name).toContain('Only newer builds of AASC have this: otherwise UNAVAILABLE.');
    }
    expect(byName('cloud_project_remove')?.description).toMatch(/no folder, checkout or GitHub repository is touched/);
    expect(byName('cloud_project_remove')?.description).toContain('off the AASC Cloud account, for every device');
    expect(byName('cloud_project_remove')?.description).toContain('On an older build it is UNAVAILABLE before any card.');
    expect(byName('cloud_project_remove')?.description).not.toMatch(/cannot tell beforehand|card can open/);
  });

  it('a call refused before the cloud spends none of the budget (P6-40)', async () => {
    for (let i = 0; i < 25; i += 1) {
      await failureOf(askOf(cloudCtx(), 'cloud_project_create', { folder: '~/.ssh/keys' }));
      await failureOf(askOf(cloudCtx(), 'cloud_project_create', { folder: FOLDER, name: 'de\u0007mo' }));
      await failureOf(askOf(cloudCtx(), 'cloud_project_create', { folder: FOLDER, description: 'bell\u0085' }));
      await failureOf(askOf(cloudCtx(), 'cloud_project_update', { id: PROJECT_ID }));
      await failureOf(askOf(cloudCtx(), 'cloud_project_update', { id: PROJECT_ID, name: 'de‍mo' }));
      await runRefused('cloud_project_associate', { id: PROJECT_ID, folder: '/etc/demo' }, cloudCtx().ctx);
    }
    const h = cloudCtx({ routes: { [`POST ${RECORD_PATH}/associate`]: envelope(LOCAL_MAIN('ready')) } });

    expect((await run('cloud_project_associate', { id: PROJECT_ID, folder: FOLDER }, h.ctx)).data).toMatchObject({ local: { state: 'ready' } });
  });
});
