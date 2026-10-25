// test/mcp/cloudWrite.test.ts — what every P6 cloud write shares (server/mcp/tools/cloudWrite.ts): the cloud's refusals
// in AASC's words with the route's code in `data.cloudCode` (P6-20), a route a build lacks read as UNAVAILABLE (P6-11),
// the call budget (P6-15), the folder rule (P6-14), the card digest, and how a write is sent. Nothing reaches a route or
// the file system: /api is a fake client, and the folder rule reads only the path's words.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudFailure } from '../../server/mcp/tools/cloudCall.js';
import {
  accountLabelOf,
  cardDetail,
  cardDigest,
  CLOUD_CALLS_PER_MINUTE,
  CLOUD_RULES,
  cloudFolder,
  cloudSend,
  cloudWriteBody,
  cloudWriteFailure,
  resetCloudBudget,
  short,
  spendCloudCall,
} from '../../server/mcp/tools/cloudWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { CLOUD_HEADERS, CONNECTION, cloudFail } from './cloudFixtures.js';
import { MISSING } from './cloudMainShapes.js';
import { envelope, makeCentral, makeCtx, NOW, ok } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const BINDING = { backendOrigin: CONNECTION.backendOrigin, accountId: CONNECTION.accountId, generation: CONNECTION.generation };

const thrown = (fn: () => unknown): ToolError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

const rejected = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

afterEach(() => {
  resetCloudBudget();
});

describe('cloudWriteFailure', () => {
  it('cloudWriteFailure keeps the route’s sentence and puts its code in data.cloudCode', () => {
    const r = cloudFail(409, 'publication_blocked', 'Some resources in this plan cannot be published.');

    const err = cloudWriteFailure(r);

    expect(err.code).toBe(cloudFailure(r).code);
    expect(err.message).toBe('Some resources in this plan cannot be published.');
    expect(err.data).toEqual({ cloudCode: 'publication_blocked' });
  });

  it('a code that is not lower-case words, or is longer than 40, is null', () => {
    expect(cloudWriteFailure(cloudFail(409, 'X-Y', 'no')).data).toEqual({ cloudCode: null });
    expect(cloudWriteFailure(cloudFail(409, 'a'.repeat(41), 'no')).data).toEqual({ cloudCode: null });
    // The alias and generic routers send `error` as text: no code at all.
    expect(cloudWriteFailure({ ok: false, status: 403, data: { success: false, error: 'Same-origin request required' }, error: 'Same-origin request required' }).data).toEqual({
      cloudCode: null,
    });
  });

  it('a blocked plan says make a new plan (publication_blocked, installation_blocked)', () => {
    for (const code of ['publication_blocked', 'installation_blocked']) {
      expect(cloudWriteFailure(cloudFail(409, code, 'Blocked.')).hint, code).toBe('Make a new plan: the plan tool shows what is blocked now.');
    }
  });

  it('cuts the route’s sentence to 200 characters', () => {
    expect(cloudWriteFailure(cloudFail(503, 'local_error', 'w'.repeat(500))).message).toHaveLength(200);
  });

  it.each([
    ['connection_changed', 409, /call cloud_status, then plan again/i],
    ['review_required', 409, /make a new plan/i],
    ['version_conflict', 409, /make a new plan/i],
    ['project_mapping_required', 409, /cloud_project_get_copy or cloud_project_associate first/i],
    ['busy', 409, /wait for its job \(cloud_job_get\)/i],
    ['rate_limited', 429, /wait a minute/i],
  ])('each P6 code has its hint: %s', (code, status, hint) => {
    expect(cloudWriteFailure(cloudFail(status, code, 'The route said so.')).hint).toMatch(hint);
  });

  it('any other code keeps cloudFailure’s hint', () => {
    const r = cloudFail(502, 'invalid_response', 'The backend answered badly.');

    expect(cloudWriteFailure(r).hint).toBe(cloudFailure(r).hint);
  });
});

describe('cloudWriteBody', () => {
  const words = { what: 'This build of AASC cannot sync.', hint: 'cloud_resource_list and cloud_publish_plan work here.' };

  it.each(Object.entries(MISSING))('cloudWriteBody throws UNAVAILABLE with the given words for a missing route: %s', (_name, r) => {
    const err = thrown(() => cloudWriteBody(r, words));

    expect(err).toMatchObject({ code: 'UNAVAILABLE', message: words.what, hint: words.hint });
  });

  it('a cloud router’s own not_found is NOT_FOUND, not a missing route', () => {
    const err = thrown(() => cloudWriteBody(cloudFail(404, 'not_found', 'Cloud project was not found.'), words));

    expect(err).toMatchObject({ code: 'NOT_FOUND', message: 'Cloud project was not found.', data: { cloudCode: 'not_found' } });
  });

  it('without words, a failure is the cloud’s refusal and the 400 stays INVALID', () => {
    expect(thrown(() => cloudWriteBody(MISSING.idClash))).toMatchObject({ code: 'INVALID', data: { cloudCode: 'invalid_request' } });
    expect(thrown(() => cloudWriteBody(cloudFail(409, 'busy', 'A job is running.')))).toMatchObject({ code: 'UNAVAILABLE', data: { cloudCode: 'busy' } });
    expect(thrown(() => cloudWriteBody(MISSING.page)).code).toBe('UNAVAILABLE');
  });

  it('answers the data of the envelope', () => {
    expect(cloudWriteBody(envelope({ id: 'j1' }))).toEqual({ id: 'j1' });
  });
});

describe('spendCloudCall', () => {
  it('spendCloudCall refuses the 21st call in a minute with BUDGET, and counts per central', () => {
    const one = makeCtx({ central: makeCentral('global', null, { centralId: 'central-1' }) }).ctx;
    const two = makeCtx({ central: makeCentral('global', null, { centralId: 'central-2' }) }).ctx;

    for (let i = 0; i < CLOUD_CALLS_PER_MINUTE; i += 1) spendCloudCall(one);
    const err = thrown(() => spendCloudCall(one));

    expect(CLOUD_CALLS_PER_MINUTE).toBe(20);
    expect(err.code).toBe('BUDGET');
    expect(err.hint).toMatch(/wait a minute/i);
    expect(() => spendCloudCall(two)).not.toThrow();
  });

  it('a minute later the calls are free again', () => {
    let now = NOW;
    const { ctx } = makeCtx();
    const later = { ...ctx, now: () => now };

    for (let i = 0; i < CLOUD_CALLS_PER_MINUTE; i += 1) spendCloudCall(later);
    now += 60_001;

    expect(() => spendCloudCall(later)).not.toThrow();
  });
});

describe('cloudFolder', () => {
  const home = homedir();

  it('answers the absolute folder for ~/ and for an absolute path under home', async () => {
    expect(await cloudFolder('~/code/demo')).toBe(join(home, 'code', 'demo'));
    expect(await cloudFolder(join(home, 'code', 'x', '..', 'demo'))).toBe(join(home, 'code', 'demo'));
  });

  it.each([
    ['~/Library/Mobile Documents/repo', 'library'],
    ['~/library/x', 'library in any case'],
    ['~/.ssh/repo', 'a hidden folder'],
    ['~/code/.hidden/repo', 'a hidden segment below'],
    ['~/code/../.config/repo', 'a hidden folder after ..'],
    ['/etc/secret-repo', 'outside home'],
    ['relative/secret-repo', 'a relative path'],
    ['~other/secret-repo', 'another user’s ~'],
    ['~/code/a\0b', 'a NUL'],
  ])('cloudFolder refuses %s (%s) without repeating it', async (raw) => {
    const err = await rejected(cloudFolder(raw));

    expect(err.code).toBe('INVALID');
    for (const word of ['secret-repo', 'Mobile Documents', '.ssh', '.hidden', '.config', 'a\0b']) {
      expect(`${err.message} ${err.hint}`).not.toContain(word);
    }
  });

  it('allows home itself only with allowHome', async () => {
    expect((await rejected(cloudFolder('~'))).code).toBe('INVALID');
    expect((await rejected(cloudFolder(home))).code).toBe('INVALID');
    expect(await cloudFolder('~', { allowHome: true })).toBe(home);
    expect(await cloudFolder(`${home}/`, { allowHome: true })).toBe(home);
  });
});

describe('cardDigest and short', () => {
  it('cardDigest is stable for the same parts and differs for a changed one', () => {
    const parts = [['a', 1], ['b', 2]];

    expect(cardDigest(parts)).toBe(cardDigest(JSON.parse(JSON.stringify(parts))));
    expect(cardDigest(parts)).toMatch(/^[0-9a-f]{40}$/);
    expect(cardDigest([['a', 1], ['b', 3]])).not.toBe(cardDigest(parts));
  });

  it('short is the first 8 characters', () => {
    expect(short('0b1f6d5e-3c1a-4a52-8c8e-2f6a4f0f9a11')).toBe('0b1f6d5e');
  });

  it('cardDetail joins the rows and, past 2 000 characters, says how many more there are', () => {
    expect(cardDetail(['- one', '- two'])).toBe('- one\n- two');
    const many = Array.from({ length: 100 }, (_, i) => `- row ${i} ${'x'.repeat(40)}`);
    const detail = cardDetail(many);

    expect(detail.length).toBeLessThanOrEqual(2_000);
    expect(detail).toMatch(/… and \d+ more$/);
  });
});

describe('cloudSend', () => {
  it('sends JSON ({} for no body) with the binding headers and the call’s signal', async () => {
    const { ctx, client } = makeCtx({ routes: { 'POST /resources/cloud/recheck': ok({ success: true, data: {} }) } });

    await cloudSend(ctx, 'post', '/resources/cloud/recheck', undefined, BINDING);
    await cloudSend(ctx, 'put', '/resources/cloud/projects/p1', { a: 1 }, BINDING);
    await cloudSend(ctx, 'post', '/resources/cloud/aliases/preview', { keys: [] }, BINDING, 'notes');

    expect(client.calls).toEqual([
      { method: 'POST', path: '/resources/cloud/recheck', body: {}, headers: CLOUD_HEADERS },
      { method: 'PUT', path: '/resources/cloud/projects/p1', body: { a: 1 }, headers: CLOUD_HEADERS },
      {
        method: 'POST',
        path: '/resources/cloud/aliases/preview',
        body: { keys: [] },
        headers: { 'x-aasc-notes-backend': BINDING.backendOrigin, 'x-aasc-notes-account': BINDING.accountId, 'x-aasc-notes-generation': '3' },
      },
    ]);
  });
});

describe('CLOUD_RULES', () => {
  it('holds the rule sentences the P6 descriptions are built from (Ruling 65)', () => {
    expect(CLOUD_RULES).toEqual({
      global: 'Only a global central may do this; a room or project central is DENIED.',
      waits: 'It waits for the person on the Mac first (an AASC card): NEEDS_CONFIRMATION means call confirm_wait with data.confirmId.',
      ownPlan: 'Only a plan you made yourself in the last 30 minutes.',
      ownJob: 'Only a job you started yourself (in the last 24 hours).',
      job: 'It answers at once with data.jobId: follow it with cloud_job_get (waitSec up to 45).',
      newer: 'Only newer builds of AASC have this: otherwise UNAVAILABLE.',
    });
  });
});

describe('accountLabelOf', () => {
  // A card summary is cut at 300 characters: a long label would push out its last clauses (memory, ~/.claude,
  // replacements, skips), which are what the person most needs to see (Review Focus 2).
  it('is the email when it is one of at most 60 characters, else the account id’s first 8', () => {
    expect(accountLabelOf('me@example.test', 'abcdef0123456789')).toBe('me@example.test');
    const sixty = `${'a'.repeat(47)}@example.test`;
    expect(sixty).toHaveLength(60);
    expect(accountLabelOf(sixty, 'abcdef0123456789')).toBe(sixty);
    expect(accountLabelOf(`a${sixty}`, 'abcdef0123456789')).toBe('abcdef01');
    expect(accountLabelOf('not an email', 'abcdef0123456789')).toBe('abcdef01');
    expect(accountLabelOf(null, 'abcdef0123456789')).toBe('abcdef01');
  });
});
