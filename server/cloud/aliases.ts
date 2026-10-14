/** Acknowledged account intent -> explicit local review -> marker-protected files. */
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstatSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  AliasIdentitySchema,
  AliasKeysSchema,
  type AliasIdentity,
  type AliasPreview,
  type AliasStatus,
} from '../../src/types/cloudAliases.js';
import {
  NoteKeySchema,
  NoteRecordSchema,
  NotesPullResultSchema,
  type NoteRecord,
} from '../../src/types/skillNotesSync.js';
import type { ResourceSummary, ScanState } from '../../src/types/resources.js';
import {
  aliasFilesFor,
  aliasCatalogRealNames,
  createAlias,
  removeAlias,
  AliasError,
  ABBR_RE,
  TARGET_RE,
  type AliasRequest,
} from '../resourceAliases.js';
import { readPrivateFile, writePrivateFile } from './secretStore.js';
import { CloudError, type CloudConnector } from './types.js';
const requestSchema = z
  .object({
    agent: z.enum(['claude', 'codex', 'shared']),
    kind: z.enum(['skill', 'command']),
    target: z.string().regex(TARGET_RE),
    abbr: z.string().regex(ABBR_RE),
  })
  .strict();
const savedSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    snapshot: z
      .object({ identity: AliasIdentitySchema, records: z.array(NoteRecordSchema).max(10000) })
      .strict()
      .nullable(),
    approved: z.record(
      z.string().max(2048),
      z
        .object({
          intent: z.string().length(64),
          files: z.string().length(64),
          generation: z.number().int().nonnegative().safe(),
        })
        .strict(),
    ),
    installed: z
      .array(
        z
          .object({ owner: z.string().max(2048), key: NoteKeySchema, request: requestSchema })
          .strict(),
      )
      .max(10000),
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
export interface CloudAliasesOptions {
  cloud: CloudConnector;
  home: string;
  directory: string;
  catalog: () => { state: ScanState; resources: ResourceSummary[] };
}
export type CloudAliasesService = Awaited<ReturnType<typeof createCloudAliases>>;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const account = (i: AliasIdentity) => JSON.stringify([i.backendOrigin, i.accountId]);
const binding = (i: AliasIdentity | null) =>
  i ? JSON.stringify([i.backendOrigin, i.accountId, i.generation]) : null;
const expected = (cloud: CloudConnector): AliasIdentity | null => {
  const c = cloud.status().connection;
  return c
    ? { backendOrigin: c.backendOrigin, accountId: c.accountId, generation: c.generation }
    : null;
};
const intent = (r: NoteRecord | undefined) =>
  r && !r.deleted ? { abbr: r.value.abbr ?? null, cli: r.value.cli === true } : null;
const stale = () =>
  new CloudError(
    'review_changed',
    'Alias intent or local files changed. Review again before writing.',
    409,
  );
export async function createCloudAliases(options: CloudAliasesOptions) {
  const path = join(options.directory, 'aliases.json');
  let saved: Saved = { version: 1, enabled: false, snapshot: null, approved: {}, installed: [] };
  const bytes = await readPrivateFile(path);
  if (bytes) {
    try {
      saved = savedSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw new CloudError(
        'alias_storage',
        'Saved alias state is invalid. No aliases were written.',
        503,
      );
    }
  }
  let epoch = 0;
  let pending = Promise.resolve();
  const reviews = new Map<
    string,
    { epoch: number; identity: AliasIdentity; keys: string[]; fingerprint: string }
  >();
  // Register again after a transition: CloudConnector clears teardown callbacks.
  let detach: (() => void) | null = null;
  const watch = () => {
    if (!detach)
      detach = options.cloud.onStop(() => {
        epoch++;
        reviews.clear();
        detach = null;
      });
  };
  watch();
  const serialize = <T>(f: () => Promise<T>) => {
    const result = pending.then(f);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const persist = async () => {
    const text = JSON.stringify(saved);
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new CloudError(
        'alias_storage',
        'Alias metadata exceeds the private snapshot limit. No further writes are allowed.',
        503,
      );
    await writePrivateFile(path, text);
  };
  const guard = (identity: AliasIdentity, e = epoch) => {
    const c = expected(options.cloud);
    if (!c)
      throw new CloudError(
        'disconnected',
        'Cloud is disconnected. Existing aliases are retained.',
        409,
      );
    if (e !== epoch || binding(identity) !== binding(c))
      throw new CloudError(
        'connection_changed',
        'The cloud connection changed. Refresh the alias review.',
        409,
      );
    if (options.cloud.status().state === 'revoked')
      throw new CloudError('revoked', 'Cloud authentication is no longer valid.', 403);
    watch();
  };
  const acknowledged = async (identity: AliasIdentity) => {
    guard(identity);
    const e = epoch;
    const rows = new Map<string, NoteRecord>();
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let pages = 0;
    try {
      do {
        if (++pages > 1000)
          throw new CloudError(
            'invalid_response',
            'Cloud notes exceed the bounded local alias review feed.',
          );
        const response = await options.cloud.client.request(
          'GET',
          `/v1/skill-notes?limit=100${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}`,
        );
        const parsed = NotesPullResultSchema.safeParse(response);
        if (!parsed.success)
          throw new CloudError(
            'invalid_response',
            'Cloud returned invalid acknowledged alias notes.',
          );
        const page = parsed.data;
        guard(identity, e);
        for (const r of page.records) {
          const old = rows.get(r.key);
          if (!old || old.version < r.version) rows.set(r.key, r);
        }
        if (rows.size > 10000)
          throw new CloudError('alias_storage', 'Too many notes for local alias review.', 503);
        if (!page.hasMore) break;
        if (cursors.has(page.cursor))
          throw new CloudError('invalid_response', 'Cloud returned repeated note pages.');
        cursors.add(page.cursor);
        cursor = page.cursor;
      } while (true);
      saved.snapshot = { identity, records: [...rows.values()] };
      await persist();
      guard(identity, e);
      return { records: saved.snapshot.records, cached: false };
    } catch (error) {
      guard(identity, e);
      const code = error instanceof CloudError ? error.code : null;
      if (code && !['offline', 'backend_error', 'cancelled'].includes(code)) throw error;
      if (
        options.cloud.status().state !== 'offline' ||
        !saved.snapshot ||
        account(saved.snapshot.identity) !== account(identity)
      )
        throw new CloudError(
          'offline',
          'Acknowledged alias intent is unavailable. Reconnect and review.',
          409,
        );
      return { records: saved.snapshot.records, cached: true };
    }
  };
  const ownFiles = (req: AliasRequest) =>
    aliasFilesFor(req.agent, req.kind, req.abbr, options.home).map((f) => f.display);
  const fileState = (req: AliasRequest) =>
    aliasFilesFor(req.agent, req.kind, req.abbr, options.home).map((f) => {
      try {
        const s = lstatSync(f.abs);
        return [
          f.display,
          s.isSymbolicLink() ? 'link' : s.isFile() ? hash(readFileSync(f.abs)) : 'other',
          s.nlink,
        ];
      } catch {
        return [f.display, 'absent'];
      }
    });
  const approvalFiles = (key: string, record: NoteRecord | undefined) => {
    const abbr = intent(record)?.abbr;
    const agent = key.split(':')[0] as AliasRequest['agent'];
    return abbr
      ? hash(
          (['skill', 'command'] as const).flatMap((kind) =>
            fileState({ agent, kind, target: 'review', abbr }),
          ),
        )
      : hash([]);
  };
  const prior = (identity: AliasIdentity, key: string) =>
    saved.installed.find((x) => x.owner === account(identity) && x.key === key);
  const prepare = async (keys: string[], identity: AliasIdentity, records: NoteRecord[]) => {
    const catalog = options.catalog();
    const statuses: AliasStatus[] = [];
    const changes: AliasPreview['changes'] = [];
    const requests = new Map<string, AliasRequest>();
    for (const key of keys) {
      const record = records.find((r) => r.key === key),
        old = prior(identity, key);
      const value = intent(record);
      if (!value?.cli) {
        if (old) {
          try {
            const removal = await removeAlias(old.request, { home: options.home, dryRun: true });
            if (removal.files.some((f) => f.action === 'kept'))
              throw new AliasError(
                409,
                'The previous alias is handwritten or changed; it was left alone.',
              );
          } catch (err) {
            statuses.push({
              key,
              state: 'conflict',
              message:
                err instanceof AliasError
                  ? err.message
                  : 'The previous alias cannot be inspected safely.',
            });
            continue;
          }
        }
        statuses.push({
          key,
          state: 'disabled',
          message: old
            ? 'Acknowledged intent removes this device’s marked alias.'
            : 'No acknowledged CLI alias is requested.',
        });
        if (old) changes.push({ key, action: 'remove', files: ownFiles(old.request) });
        continue;
      }
      const [agent, ...name] = key.split(':');
      const target = name.join(':');
      if ((agent === 'codex' || agent === 'shared') && name.length > 1) {
        statuses.push({
          key,
          state: 'unsupported',
          message: 'Codex plugin aliases require real CLI acceptance and are unsupported.',
        });
        continue;
      }
      if (catalog.state !== 'ready') {
        statuses.push({
          key,
          state: 'needs-resource',
          message: 'Wait for the local catalog scan, then retry.',
        });
        changes.push({ key, action: 'retry', files: [] });
        continue;
      }
      const matches = catalog.resources.filter(
        (r) =>
          (r.type === 'skill' || r.type === 'command') &&
          r.agent === agent &&
          (r.origin === 'plugin' && r.pluginName ? `${r.pluginName}:${r.name}` : r.name) === target,
      );
      if (!matches.length) {
        statuses.push({
          key,
          state: 'needs-resource',
          message: 'Install the target on this device, then retry.',
        });
        changes.push({ key, action: 'retry', files: [] });
        continue;
      }
      if (matches.length !== 1) {
        statuses.push({
          key,
          state: 'conflict',
          message:
            'Multiple local resources match this note. Resolve the duplicate target before retrying.',
        });
        continue;
      }
      const r = matches[0];
      if ((r.agent === 'codex' || r.agent === 'shared') && r.origin === 'plugin') {
        statuses.push({
          key,
          state: 'unsupported',
          message: 'Codex plugin aliases are unsupported.',
        });
        continue;
      }
      const req: AliasRequest = {
        agent: r.agent,
        kind: r.type as 'skill' | 'command',
        target,
        abbr: value.abbr!,
      };
      requests.set(key, req);
      const paths = new Set(ownFiles(req));
      const realNames = aliasCatalogRealNames(catalog.resources, [req], options.home);
      const conflicting = records.some(
        (x) =>
          x.key !== key &&
          !x.deleted &&
          x.value.abbr === req.abbr &&
          (x.key.startsWith('shared:') || agent === 'shared' || x.key.startsWith(`${agent}:`)),
      );
      try {
        const partialAdoption = saved.installed.some(
          (x) =>
            x.owner !== account(identity) &&
            ownFiles(x.request).some((p) => paths.has(p)) &&
            ownFiles(x.request).some((p) => !paths.has(p)),
        );
        if (partialAdoption)
          throw new AliasError(
            409,
            'Another account owns a shared alias with additional files. Remove it through that account before adopting this abbreviation.',
          );
        if (old && JSON.stringify(old.request) !== JSON.stringify(req)) {
          const removal = await removeAlias(old.request, {
            home: options.home,
            dryRun: true,
            preserveFiles: paths,
          });
          if (removal.files.some((f) => f.action === 'kept'))
            throw new AliasError(
              409,
              'The previous alias is handwritten or changed; it was left alone.',
            );
        }
        if (conflicting)
          throw new AliasError(409, 'Another acknowledged note uses this abbreviation.');
        const plan = await createAlias(req, { home: options.home, realNames, dryRun: true });
        const installed = plan.files.every((f) => f.action === 'unchanged');
        statuses.push({
          key,
          state: installed ? 'installed' : 'disabled',
          message: installed
            ? 'Verified on this device.'
            : 'Reviewed installation is required on this device.',
        });
        const adoption = saved.installed.some(
          (x) => x.owner !== account(identity) && ownFiles(x.request).some((p) => paths.has(p)),
        );
        changes.push({
          key,
          action: installed ? 'update' : 'create',
          files: [...paths],
          ...(adoption
            ? { message: 'This explicitly adopts an existing AASC alias from another account.' }
            : {}),
        });
        if (old && JSON.stringify(old.request) !== JSON.stringify(req))
          changes.push({
            key,
            action: 'remove',
            files: ownFiles(old.request).filter((p) => !paths.has(p)),
          });
      } catch (err) {
        statuses.push({
          key,
          state: 'conflict',
          message:
            err instanceof AliasError ? err.message : 'Alias files cannot be inspected safely.',
        });
      }
    }
    const fingerprint = hash({
      enabled: saved.enabled,
      intents: records.map((r) => [r.key, intent(r)]).sort(),
      plans: keys.map((key) => ({
        key,
        request: requests.get(key),
        old: prior(identity, key),
        files: requests.has(key) ? fileState(requests.get(key)!) : [],
        oldFiles: prior(identity, key) ? fileState(prior(identity, key)!.request) : [],
      })),
      catalog: catalog.resources
        .map((r) => [r.id, r.type, r.agent, r.name, r.pluginName, r.path])
        .sort(),
      statuses,
    });
    return { statuses, changes, requests, fingerprint };
  };
  const apply = async (
    keys: string[],
    identity: AliasIdentity,
    records: NoteRecord[],
    plan: Awaited<ReturnType<typeof prepare>>,
  ) => {
    const out: AliasStatus[] = [];
    if (!saved.enabled)
      return keys.map((key) => ({
        key,
        state: 'disabled' as const,
        message: 'Cloud alias installation is off on this device.',
      }));
    const e = epoch;
    for (const status of plan.statuses) {
      guard(identity, e);
      const record = records.find((r) => r.key === status.key);
      const approvalKey = JSON.stringify([account(identity), status.key]);
      if (status.state === 'conflict' || status.state === 'unsupported') {
        out.push(status);
        continue;
      }
      // Persist exact intent approval BEFORE the first filesystem write; retries survive restart.
      saved.approved[approvalKey] = {
        intent: hash(intent(record)),
        generation: identity.generation,
        files: approvalFiles(status.key, record),
      };
      await persist();
      guard(identity, e);
      const old = prior(identity, status.key),
        req = plan.requests.get(status.key);
      if (status.state === 'needs-resource') {
        out.push(status);
        continue;
      }
      try {
        if (req) {
          const current = await prepare([status.key], identity, records);
          guard(identity, e);
          const live = current.statuses[0];
          if (
            live.state === 'conflict' ||
            live.state === 'unsupported' ||
            live.state === 'needs-resource' ||
            JSON.stringify(current.requests.get(status.key)) !== JSON.stringify(req)
          )
            throw new AliasError(409, live.message ?? 'The local target changed; review again.');
          const realNames = aliasCatalogRealNames(options.catalog().resources, [req], options.home);
          await createAlias(req, { home: options.home, realNames });
          guard(identity, e);
        }
        if (old && (!req || JSON.stringify(old.request) !== JSON.stringify(req))) {
          const removed = await removeAlias(old.request, {
            home: options.home,
            preserveFiles: req ? new Set(ownFiles(req)) : undefined,
          });
          if (removed.files.some((f) => f.action === 'kept'))
            throw new AliasError(
              409,
              'The previous alias is handwritten or changed; it was left alone.',
            );
        }
        if (req) {
          const paths = ownFiles(req);
          saved.installed = saved.installed.filter(
            (x) =>
              !(x.owner === account(identity) && x.key === status.key) &&
              !ownFiles(x.request).some((p) => paths.includes(p)),
          );
          saved.installed.push({ owner: account(identity), key: status.key, request: req });
        } else
          saved.installed = saved.installed.filter(
            (x) => !(x.owner === account(identity) && x.key === status.key),
          );
        saved.approved[approvalKey] = {
          intent: hash(intent(record)),
          generation: identity.generation,
          files: approvalFiles(status.key, record),
        };
        await persist();
        guard(identity, e);
        out.push({
          key: status.key,
          state: req ? 'installed' : 'disabled',
          message: req
            ? 'Installed and verified on this device.'
            : 'Removed only this account’s marked alias.',
        });
      } catch (error) {
        out.push({
          key: status.key,
          state: 'conflict',
          message:
            error instanceof AliasError
              ? error.message
              : 'Local alias operation could not be saved. Review before retrying.',
        });
      }
    }
    return out;
  };
  return {
    async setEnabled(enabled: boolean, identity?: AliasIdentity) {
      return serialize(async () => {
        if (identity) guard(identity);
        const previous = saved.enabled;
        saved.enabled = z.boolean().parse(enabled);
        reviews.clear();
        try {
          await persist();
          if (identity) guard(identity);
        } catch (error) {
          saved.enabled = previous;
          throw error;
        }
        return { enabled: saved.enabled };
      });
    },
    async status(keys: string[], identity: AliasIdentity) {
      return serialize(async () => {
        AliasKeysSchema.parse(keys);
        if (expected(options.cloud)) guard(identity);
        else if (!saved.snapshot || account(saved.snapshot.identity) !== account(identity))
          throw new CloudError('disconnected', 'No cached aliases for this account.', 409);
        const records =
          saved.snapshot && account(saved.snapshot.identity) === account(identity)
            ? saved.snapshot.records
            : [];
        const plan = await prepare(keys, identity, records);
        return {
          enabled: saved.enabled,
          connection: expected(options.cloud),
          statuses: plan.statuses,
          cached: true,
        };
      });
    },
    async preview(keys: string[], identity: AliasIdentity): Promise<AliasPreview> {
      return serialize(async () => {
        AliasKeysSchema.parse(keys);
        const data = await acknowledged(identity),
          plan = await prepare(keys, identity, data.records);
        guard(identity);
        const reviewId = randomUUID();
        reviews.clear();
        reviews.set(reviewId, { epoch, identity, keys: [...keys], fingerprint: plan.fingerprint });
        return {
          reviewId,
          intents: keys.map(key => {
            const [agent, ...names] = key.split(':');
            const value = intent(data.records.find(record => record.key === key));
            return {key, agent: agent as AliasRequest['agent'], target: names.join(':'), abbr: value?.abbr ?? null, cli: value?.cli ?? false};
          }),
          statuses: plan.statuses,
          changes: plan.changes,
          cached: data.cached,
          enabled: saved.enabled,
        };
      });
    },
    async reconcile(
      keys: string[],
      reviewId: string,
      identity: AliasIdentity,
    ): Promise<AliasStatus[]> {
      return serialize(async () => {
        AliasKeysSchema.parse(keys);
        guard(identity);
        const review = reviews.get(reviewId);
        if (
          !review ||
          review.epoch !== epoch ||
          binding(review.identity) !== binding(identity) ||
          JSON.stringify(review.keys) !== JSON.stringify(keys)
        )
          throw stale();
        const data = await acknowledged(identity),
          plan = await prepare(keys, identity, data.records);
        guard(identity, review.epoch);
        if (plan.fingerprint !== review.fingerprint) throw stale();
        reviews.delete(reviewId);
        return apply(keys, identity, data.records, plan);
      });
    },
    /** Task10 calls ONLY after verified target installation and catalog refresh. */
    async retryAcknowledgedTarget(key: string): Promise<AliasStatus[]> {
      return serialize(async () => {
        const identity = expected(options.cloud);
        if (!identity || !saved.enabled || options.cloud.status().state === 'revoked') return [];
        const approvalKey = JSON.stringify([account(identity), key]);
        if (
          !saved.approved[approvalKey] ||
          saved.approved[approvalKey].generation !== identity.generation
        )
          return [];
        AliasKeysSchema.parse([key]);
        const data = await acknowledged(identity),
          record = data.records.find((r) => r.key === key);
        if (saved.approved[approvalKey].intent !== hash(intent(record)))
          return [
            {
              key,
              state: 'conflict',
              message: 'Acknowledged alias intent changed. Review again before retrying.',
            },
          ];
        const plan = await prepare([key], identity, data.records);
        guard(identity);
        const req = plan.requests.get(key);
        const otherOwner =
          req &&
          saved.installed.some(
            (x) =>
              x.owner !== account(identity) &&
              ownFiles(x.request).some((p) => ownFiles(req).includes(p)),
          );
        if (otherOwner || saved.approved[approvalKey].files !== approvalFiles(key, record))
          return [
            {
              key,
              state: 'conflict',
              message:
                'Local alias files or their account ownership changed. Review again before retrying.',
            },
          ];
        return apply([key], identity, data.records, plan);
      });
    },
  };
}
