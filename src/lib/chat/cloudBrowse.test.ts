// cloudBrowse.test.ts — the phone's read-only AASC Cloud view (AASC-51): the three reads through the Mac,
// what each failure says, and the words the screens and rows use.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudFetchError, CLOUD_FETCH_WORDS, fetchCloudBrowse, fetchCloudStatus, fetchCloudVersions, type CloudStatus } from './cloudBrowseApi';
import {
  agoWords, agentWords, cloudStateWords, firstSentence, filesWords, kindWords, projectDetail, repoWords, resourceLine, sizeWords, syncWords, versionDate,
} from './cloudBrowseModel';

const RES = { id: '0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c', name: 'retouch', kind: 'skill', agent: 'claude', scope: 'global', version: 3, updatedAt: '2026-10-14T08:00:00.000Z', bytes: 2500, files: 2 } as const;
const PROJ = { id: '3e9bad6f-4c5a-4b8d-8ebf-a09b8c7d6e5f', name: 'Website', host: 'github.com', owner: 'kason', repo: 'website', branch: 'main', resources: 4 } as const;
const STATUS = { connected: true, state: 'connected', lastSyncAt: '2026-10-16T09:00:00.000Z', problem: null } as const;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('reads through the Mac', () => {
  it('asks the three phone-cloud routes, never cached, and only refresh=1 as a query', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/status')) return reply(STATUS);
      if (url.includes('/browse')) return reply({ ...STATUS, resources: [RES], projects: [PROJ], truncated: false });
      return reply({ ...STATUS, resource: RES, versions: [{ version: 3, createdAt: RES.updatedAt, bytes: 2500, files: 2 }], truncated: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchCloudStatus()).toEqual(STATUS);
    expect((await fetchCloudBrowse()).resources).toEqual([RES]);
    await fetchCloudBrowse({ refresh: true });
    expect((await fetchCloudVersions(RES.id)).versions).toHaveLength(1);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/phone-cloud/status', '/api/phone-cloud/browse', '/api/phone-cloud/browse?refresh=1', `/api/phone-cloud/resources/${RES.id}/versions`,
    ]);
    for (const call of fetchMock.mock.calls) expect((call as unknown as [string, RequestInit])[1]).toMatchObject({ cache: 'no-store' });
  });

  it('says why when there is no answer: an unreachable Mac, an older Mac, a busy cloud, a strange answer', async () => {
    const cases: Array<[() => Promise<Response>, string, number | null]> = [
      [async () => { throw new TypeError('Failed to fetch'); }, 'unreachable', null],
      [async () => reply({ error: 'Not found', code: 'PHONE_NOT_ALLOWED' }, 404), 'unsupported', null],
      [async () => reply({ code: 'PHONE_CLOUD_LIMIT', retryAfter: 12.2 }, 429), 'busy', 13],
      [async () => reply({ error: 'x' }, 500), 'unreachable', null],
      [async () => reply({ connected: 'yes' }), 'invalid', null],
    ];
    for (const [impl, problem, retryAfter] of cases) {
      vi.stubGlobal('fetch', vi.fn(impl));
      const err = await fetchCloudStatus().catch((e: unknown) => e);
      expect(err, problem).toBeInstanceOf(CloudFetchError);
      expect((err as CloudFetchError).problem).toBe(problem);
      expect((err as CloudFetchError).retryAfter).toBe(retryAfter);
      expect((err as CloudFetchError).message).toBe(CLOUD_FETCH_WORDS[problem as keyof typeof CLOUD_FETCH_WORDS]);
    }
  });

  it('lets an aborted read stay an abort (a screen that closed), not a “couldn’t reach”', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError'); }));
    const err = await fetchCloudBrowse({ signal: controller.signal }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CloudFetchError);
  });
});

describe('words', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');

  it('the connection, never the account', () => {
    expect(cloudStateWords('connected')).toBe('Connected');
    expect(cloudStateWords('unchecked')).toBe('Connected');
    expect(cloudStateWords('offline')).toBe('Offline');
    expect(cloudStateWords('revoked')).toBe('Revoked');
    expect(cloudStateWords('not-connected')).toBe('Not connected');
  });

  it('the last sync, or why there is none', () => {
    const at = (iso: string | null, state: CloudStatus['state'] = 'connected'): CloudStatus => ({ connected: state !== 'not-connected', state, lastSyncAt: iso, problem: null });
    expect(syncWords(at('2026-10-16T11:58:00.000Z'), now)).toBe('Last synced 2 min ago');
    expect(syncWords(at(null, 'unchecked'), now)).toBe('Not checked since your Mac started');
    expect(syncWords(at(null), now)).toBe('Not synced yet');
    expect(syncWords(at(null, 'not-connected'), now)).toBe('Set it up on your Mac');
  });

  it('ages: minutes, hours, days, then a date (with the year only when it differs)', () => {
    expect(agoWords('2026-10-16T11:59:30.000Z', now)).toBe('just now');
    expect(agoWords('2026-10-16T09:00:00.000Z', now)).toBe('3 h ago');
    expect(agoWords('2026-10-15T10:00:00.000Z', now)).toBe('yesterday');
    expect(agoWords('2026-10-13T10:00:00.000Z', now)).toBe('3 days ago');
    expect(agoWords('2026-10-02T12:00:00.000Z', now)).toMatch(/^Oct \d+$/);
    expect(agoWords('2025-10-02T12:00:00.000Z', now)).toMatch(/^Oct \d+, 2025$/);
    expect(agoWords('not a date', now)).toBe('');
  });

  it('kinds, agents, sizes and counts, with real plurals', () => {
    expect(kindWords('instruction')).toBe('Instructions');
    expect(agentWords('shared')).toBe('Claude Code and Codex');
    expect(sizeWords(512)).toBe('512 B');
    expect(sizeWords(2500)).toBe('2.4 KB');
    expect(sizeWords(40_000)).toBe('39 KB');
    expect(sizeWords(3_500_000)).toBe('3.3 MB');
    expect(filesWords(1)).toBe('1 file');
    expect(filesWords(4)).toBe('4 files');
    expect(resourceLine(RES)).toBe('Skill · Claude Code · v3');
    expect(repoWords(PROJ)).toBe('github.com/kason/website');
    expect(projectDetail(PROJ)).toBe('Branch main · 4 resources');
    expect(projectDetail({ ...PROJ, resources: 1 })).toBe('Branch main · 1 resource');
    expect(versionDate(RES.updatedAt)).toMatch(/2026/);
    expect(firstSentence('Your Mac can’t reach AASC Cloud right now. Check its internet connection.')).toBe('Your Mac can’t reach AASC Cloud right now.');
    expect(firstSentence('No full stop')).toBe('No full stop');
  });
});
