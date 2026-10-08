import { randomUUID } from 'crypto';
import { isAbsolute } from 'path';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import type { ResourceCatalogService } from '../resourceCatalog.js';
import { redactPatch, redactPemBlocks, redactSecretsInString } from '../resourceMask.js';
import { readTransferPacket, type TransferPacket } from './packet.js';
import { knownFingerprint, sshRemoteCall, type RemoteCall } from './transport.js';
import {
  resourceIsSelected,
  transferBlocker,
  type TransferDevice,
  type TransferDeviceInput,
  type TransferDraft,
  type TransferItem,
  type TransferOverview,
  type TransferTask,
  type TransferAction,
} from '../../src/types/resourceTransfers.js';

const remoteComparisonSchema = z.object({
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  destinationPath: z.string().max(4096).refine(isAbsolute),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(4096),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.union([z.literal(0o644), z.literal(0o755)]),
        text: z.string().max(262144).optional(),
      }),
    )
    .max(2000),
});
function previewPatch(before: string, after: string): Promise<string | undefined> {
  return new Promise((resolve) =>
    createTwoFilesPatch(
      'Destination',
      'Source',
      redactPemBlocks(before),
      redactPemBlocks(after),
      undefined,
      undefined,
      {
        context: 3,
        timeout: 1500,
        callback: (patch) => resolve(patch ? redactPatch(patch).slice(0, 20000) : undefined),
      },
    ),
  );
}

interface PlanLocation {
  agent: string;
  project?: string;
  relativePath: string;
  kind: string;
}
export interface TransferState extends TransferOverview {
  locations: Record<string, PlanLocation>;
}
export interface TransferStore {
  load(): Promise<TransferState | null>;
  save(state: TransferState): Promise<void>;
}
const defaultStore: TransferStore = {
  load: async () =>
    JSON.parse(
      (await import('../db.js')).loadResourceTransferState() || 'null',
    ) as TransferState | null,
  save: async (state) =>
    (await import('../db.js')).saveResourceTransferState(JSON.stringify(state)),
};
export interface TransferServiceDeps {
  catalog: ResourceCatalogService;
  store?: TransferStore;
  remote?: RemoteCall;
  fingerprint?: typeof knownFingerprint;
}
const cleanError = (err: unknown) =>
  redactSecretsInString(err instanceof Error ? err.message : 'Transfer failed').slice(0, 500);
export function createTransferService(deps: TransferServiceDeps) {
  const store = deps.store ?? defaultStore,
    remote = deps.remote ?? sshRemoteCall,
    fingerprint = deps.fingerprint ?? knownFingerprint;
  let state: TransferState = { devices: [], tasks: [], locations: {} };
  let loaded: Promise<void> | undefined;
  let working = false;
  const load = () =>
    (loaded ??= (async () => {
      const saved = await store.load();
      if (saved) state = saved;
      let recovered = false;
      for (const t of state.tasks)
        if (t.state === 'running') {
          t.state = 'interrupted';
          recovered = true;
        }
      if (recovered) await store.save(state);
    })());
  const save = () => store.save(state);
  const device = (id: string) => {
    const d = state.devices.find((x) => x.id === id);
    if (!d) throw new Error('Destination not found.');
    return d;
  };
  const task = (id: string) => {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) throw new Error('Task not found.');
    return t;
  };
  const check = async (d: TransferDevice) => {
    if ((await fingerprint(d)) !== d.fingerprint)
      throw new Error(
        'Trusted host keys changed. Verify its identity in your terminal, then add it as a new destination.',
      );
  };
  const snapshot = (): TransferOverview =>
    JSON.parse(JSON.stringify({ devices: state.devices, tasks: state.tasks }));
  async function addDevice(input: TransferDeviceInput) {
    await load();
    const fp = await fingerprint(input),
      probe = await remote(input, { op: 'probe' });
    if (
      typeof probe.home !== 'string' ||
      !isAbsolute(probe.home) ||
      !['darwin', 'linux'].includes(String(probe.platform))
    )
      throw new Error('Destination must be macOS or Linux with Node.js 18+.');
    if (
      !Number.isFinite(Number(String(probe.node).split('.')[0])) ||
      Number(String(probe.node).split('.')[0]) < 18
    )
      throw new Error('Destination needs Node.js 18+.');
    if ((await fingerprint(input)) !== fp)
      throw new Error('Host keys changed during connection. Try again.');
    if (
      state.devices.some(
        (d) =>
          d.host === input.host &&
          d.port === input.port &&
          d.username === input.username &&
          d.fingerprint === fp,
      )
    )
      throw new Error('This destination is already saved.');
    const d: TransferDevice = {
      ...input,
      id: randomUUID(),
      fingerprint: fp,
      home: probe.home,
      platform: String(probe.platform),
      checkedAt: Date.now(),
    };
    state.devices.push(d);
    await save();
    return d;
  }
  async function saveDraft(draft: TransferDraft) {
    await load();
    for (const target of draft.targets) device(target.deviceId);
    const now = Date.now();
    const t: TransferTask = {
      ...draft,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      state: 'draft',
      items: [],
    };
    state.tasks.unshift(t);
    await save();
    return t;
  }
  async function compare(id: string) {
    await load();
    if (working)
      throw new Error('Another comparison or transfer is running. Try again when it finishes.');
    working = true;
    try {
      const t = task(id);
      if (t.state !== 'draft') throw new Error('Use Run again to create a fresh comparison.');
      const catalog = deps.catalog.getCatalog();
      if (catalog.state !== 'ready') throw new Error('Finish a resource scan before comparing.');
      if (!t.targets.length) throw new Error('Choose at least one destination.');
      const chosen = catalog.resources.filter((r) => resourceIsSelected(r, t.selection));
      if (!chosen.length) throw new Error('Select at least one resource.');
      if (chosen.length * t.targets.length > 2000)
        throw new Error('Choose fewer resources or destinations (maximum 2,000 results).');
      const packets = new Map<string, TransferPacket>(),
        problems = new Map<string, string>(),
        required = new Map<string, string[]>();
      const internals = deps.catalog.transferInternals();
      let totalBytes = 0;
      let totalFiles = 0;
      let previewBytes = 0;
      for (let i = 0; i < chosen.length; i++) {
        if (chosen.length * t.targets.length > 2000)
          throw new Error('Dependencies exceed the 2,000-result limit. Select fewer resources.');
        const r = chosen[i];
        try {
          const blocked = transferBlocker(r);
          if (blocked) throw new Error(blocked);
          const internal = internals.find((x) => x.summary.id === r.id);
          if (!internal) throw new Error('Resource disappeared. Rescan.');
          if (totalBytes > 128 * 1024 * 1024 || totalFiles > 20000)
            throw new Error(
              'Selection exceeds the comparison budget. Split it into smaller tasks.',
            );
          const packet = await readTransferPacket(internal);
          totalBytes += packet.files.reduce(
            (n, f) => n + Buffer.byteLength(f.content, 'base64'),
            0,
          );
          totalFiles += packet.files.length * t.targets.length;
          if (totalBytes > 128 * 1024 * 1024 || totalFiles > 20000)
            throw new Error(
              'Selection exceeds the transfer comparison budget (128 MiB or 20,000 files). Split it into smaller tasks.',
            );
          packets.set(r.id, packet);
          for (const dependency of packet.dependencies) {
            const found = internals.find(
              (x) => dependency === x.entry.absPath || dependency.startsWith(x.entry.absPath + '/'),
            );
            if (!found || transferBlocker(found.summary))
              throw new Error(
                'A reference outside this package cannot be transferred. Review its dependencies first.',
              );
            if (found.summary.id === r.id) continue;
            required.set(found.summary.id, [
              ...new Set([...(required.get(found.summary.id) ?? []), r.id]),
            ]);
            if (!chosen.some((x) => x.id === found.summary.id)) chosen.push(found.summary);
          }
        } catch (e) {
          problems.set(r.id, cleanError(e));
        }
      }
      const items: TransferItem[] = [];
      for (const target of t.targets) {
        const d = device(target.deviceId);
        let connectionError: string | undefined;
        try {
          await check(d);
        } catch (e) {
          connectionError = cleanError(e);
        }
        for (const r of chosen) {
          const packet = packets.get(r.id);
          const item: TransferItem = {
            id: randomUUID(),
            deviceId: d.id,
            resourceId: r.id,
            name: r.name,
            sourcePath: r.path,
            destinationPath: '',
            ...(r.findingCodes.includes('hardcoded-home-path')
              ? {
                  warnings: [
                    'Contains a machine-specific home path. Copying preserves it; adapt it on the destination before use.',
                  ],
                }
              : {}),
            action: 'review',
            state: 'pending',
            ...(required.has(r.id) ? { requiredBy: required.get(r.id) } : {}),
          };
          try {
            if (connectionError) throw new Error(connectionError);
            if (problems.has(r.id)) throw new Error(problems.get(r.id));
            if (!packet) throw new Error('Resource could not be read.');
            const project = r.scope === 'project' ? target.projects[r.projectId ?? ''] : undefined;
            if (r.scope === 'project' && !project)
              throw new Error('Choose a destination folder for this project.');
            const location = {
              agent: r.agent,
              ...(project ? { project } : {}),
              relativePath: packet.relativePath,
              kind: packet.kind,
            };
            const result = await remote(d, { op: 'inspect', ...location });
            const parsed = remoteComparisonSchema.safeParse(result);
            if (!parsed.success) throw new Error('Invalid destination comparison.');
            const other = parsed.data;
            item.destinationPath = other.destinationPath;
            item.sourceHash = packet.hash;
            item.destinationHash = other.hash;
            item.action =
              other.hash === packet.hash ? 'skip' : other.hash === null ? 'add' : 'review';
            if (other.hash === packet.hash) item.reason = 'Identical';
            const left = new Map(packet.files.map((f) => [f.path, f])),
              right = new Map(other.files.map((f) => [f.path, f]));
            item.files = [...new Set([...left.keys(), ...right.keys()])].sort().map((path) => ({
              path,
              status: !left.has(path)
                ? 'remove'
                : !right.has(path)
                  ? 'add'
                  : left.get(path)!.hash === right.get(path)!.hash &&
                      left.get(path)!.mode === right.get(path)!.mode
                    ? 'same'
                    : 'change',
            }));
            const main =
              packet.kind === 'file'
                ? packet.files[0]
                : packet.files.find((f) => f.path === 'SKILL.md');
            if (main) {
              const before = right.get(main.path)?.text;
              const after = Buffer.from(main.content, 'base64');
              if (after.length < 262144 && !after.includes(0) && previewBytes < 2 * 1024 * 1024) {
                item.patch = await previewPatch(before ?? '', after.toString('utf8'));
                previewBytes += item.patch?.length ?? 0;
              }
            }
            state.locations[item.id] = location;
          } catch (e) {
            delete item.sourceHash;
            item.action = 'review';
            item.reason = cleanError(e);
          }
          items.push(item);
        }
      }
      t.items = items;
      t.state = 'review';
      t.updatedAt = Date.now();
      await save();
      return t;
    } finally {
      working = false;
    }
  }
  async function run(id: string, actions: Record<string, TransferAction>) {
    await load();
    if (working) throw new Error('Another comparison or transfer is running.');
    const t = task(id);
    const resolved = new Map<string, TransferAction>();
    if (!['review', 'partial', 'failed', 'interrupted', 'cancelled'].includes(t.state))
      throw new Error('Compare the task before running it.');
    for (const item of t.items) {
      if (item.state === 'complete' || item.state === 'restored') continue;
      const action = actions[item.id] ?? item.action;
      if (action === 'review') throw new Error('Resolve every item before running.');
      if (action !== 'skip' && (!item.sourceHash || !state.locations[item.id]))
        throw new Error('Unsupported items must be skipped.');
      if (action === 'add' && item.destinationHash !== null)
        throw new Error('Existing resources require Replace or Skip.');
      resolved.set(item.id, action);
    }
    for (const dependency of t.items)
      if (
        (resolved.get(dependency.id) ?? dependency.action) === 'skip' &&
        dependency.reason !== 'Identical' &&
        dependency.requiredBy?.some((id) =>
          t.items.some(
            (i) =>
              i.deviceId === dependency.deviceId &&
              i.resourceId === id &&
              (resolved.get(i.id) ?? i.action) !== 'skip',
          ),
        )
      )
        throw new Error(
          'A required dependency is skipped. Include it or skip its dependent resources.',
        );
    for (const item of t.items) item.action = resolved.get(item.id) ?? item.action;
    working = true;
    const previous = t.state;
    t.state = 'running';
    t.updatedAt = Date.now();
    try {
      await save();
    } catch (e) {
      working = false;
      t.state = previous;
      throw e;
    }
    void execute(t).finally(() => {
      working = false;
    });
    return t;
  }
  async function execute(t: TransferTask) {
    try {
      // Dependencies first; cycles are refused rather than copied in an arbitrary order.
      const ordered: TransferItem[] = [];
      const visiting = new Set<string>(),
        visited = new Set<string>();
      const visit = (item: TransferItem) => {
        if (visited.has(item.id)) return;
        if (visiting.has(item.id))
          throw new Error('Circular package dependencies need a manual review.');
        visiting.add(item.id);
        for (const dep of t.items.filter(
          (d) => d.deviceId === item.deviceId && d.requiredBy?.includes(item.resourceId),
        ))
          visit(dep);
        visiting.delete(item.id);
        visited.add(item.id);
        ordered.push(item);
      };
      for (const item of t.items) if (item.action !== 'skip') visit(item);
      for (const item of t.items) if (!visited.has(item.id)) ordered.push(item);
      for (const item of ordered) {
        if (t.state === 'cancelled') break;
        if (item.state === 'complete' || item.state === 'restored') continue;
        if (item.action === 'skip') {
          item.state = 'skipped';
          continue;
        }
        try {
          if (
            t.items.some(
              (d) =>
                d.deviceId === item.deviceId &&
                d.requiredBy?.includes(item.resourceId) &&
                d.state !== 'complete' &&
                d.reason !== 'Identical',
            )
          )
            throw new Error('A required dependency did not complete. Retry it first.');
          const d = device(item.deviceId);
          await check(d);
          const r = deps.catalog.transferInternals().find((r) => r.summary.id === item.resourceId);
          if (!r) throw new Error('Source unavailable. Rescan and compare again.');
          const packet = await readTransferPacket(r);
          if (packet.hash !== item.sourceHash)
            throw new Error('Source changed since comparison. Create a fresh comparison.');
          for (const dependency of t.items.filter(
            (dep) => dep.deviceId === item.deviceId && dep.requiredBy?.includes(item.resourceId),
          )) {
            const actual = await remote(d, { op: 'inspect', ...state.locations[dependency.id] });
            if (
              actual.hash !== dependency.sourceHash ||
              actual.destinationPath !== dependency.destinationPath
            )
              throw new Error(
                'A required dependency changed on the destination. Create a fresh comparison.',
              );
          }
          item.state = 'copying';
          delete item.error;
          await save();
          const result = await remote(d, {
            op: 'apply',
            ...state.locations[item.id],
            operationId: item.id,
            expectedDestinationPath: item.destinationPath,
            sourceHash: item.sourceHash,
            expectedHash: item.destinationHash,
            files: packet.files,
          });
          if (result.hash !== item.sourceHash)
            throw new Error('Destination checksum was not verified.');
          item.state = 'complete';
          if (typeof result.backupId === 'string') item.backupId = result.backupId;
        } catch (e) {
          item.state = 'failed';
          item.error = cleanError(e);
        }
        t.updatedAt = Date.now();
        await save();
      }
      if (t.state !== 'cancelled')
        t.state = t.items.some((i) => i.state === 'failed')
          ? t.items.some((i) => i.state === 'complete')
            ? 'partial'
            : 'failed'
          : 'complete';
    } catch (e) {
      t.state = 'interrupted';
      for (const i of t.items)
        if (i.state === 'copying' || (i.state === 'pending' && i.action !== 'skip')) {
          i.state = 'failed';
          i.error = cleanError(e);
        }
    } finally {
      t.updatedAt = Date.now();
      await save().catch(() => {});
    }
  }
  return {
    overview: async () => {
      await load();
      return snapshot();
    },
    addDevice,
    saveDraft,
    compare,
    run,
    cancel: async (id: string) => {
      await load();
      const t = task(id);
      if (t.state !== 'running') throw new Error('Task is not running.');
      t.state = 'cancelled';
      await save();
      return t;
    },
    repeat: async (id: string) => {
      await load();
      const t = task(id);
      return saveDraft({ name: t.name, selection: t.selection, targets: t.targets });
    },
    restore: async (id: string, itemId: string) => {
      await load();
      if (working) throw new Error('Wait for the running task.');
      const t = task(id),
        item = t.items.find((i) => i.id === itemId);
      if (!item?.backupId || item.state !== 'complete')
        throw new Error('No completed replacement to restore.');
      working = true;
      try {
        const d = device(item.deviceId);
        await check(d);
        await remote(d, {
          op: 'restore',
          ...state.locations[item.id],
          operationId: item.id,
          expectedDestinationPath: item.destinationPath,
          sourceHash: item.sourceHash,
        });
        item.state = 'restored';
        await save();
        return t;
      } finally {
        working = false;
      }
    },
    removeDevice: async (id: string) => {
      await load();
      if (state.tasks.some((t) => t.targets.some((x) => x.deviceId === id)))
        throw new Error('This destination is referenced by saved tasks.');
      state.devices = state.devices.filter((d) => d.id !== id);
      await save();
    },
  };
}
