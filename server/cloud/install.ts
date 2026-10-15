/** Per-owned-resource staged replacement. Unrelated files are copied intact, never mirror-deleted. */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import log from '../logger.js';
import { excludeInstallWorkspaces } from './gitExclude.js';
import type { PackageManifest } from '../../src/types/cloudResources.js';
import type { ResourceDestination } from '../resourcePackages/adapters.js';
import type { CloudBinding } from './binding.js';
import type { JobStore } from './jobStore.js';
import type { InstallReceipt } from './receipts.js';
import {
  snapshot,
  directoryAnchor,
  assertAnchors,
  type DirectoryAnchor,
  assertDestination,
  readSafeFile,
  writeVerified,
  safeParents,
  syncDirectory,
  changed,
  type DestinationSnapshot,
} from './installFs.js';
import { redactText } from '../resourceMask.js';
import { CloudError } from './types.js';
export interface ReviewedInstall {
  id: string;
  manifest: PackageManifest;
  version: number;
  destination: ResourceDestination;
  before: DestinationSnapshot | null;
  anchors: DirectoryAnchor[];
}
export function createInstaller(store: JobStore) {
  const save = (r: InstallReceipt) => store.put('receipt', r.id, r);
  async function flushMove(from: string, to: string) {
    await syncDirectory(dirname(from));
    if (dirname(from) !== dirname(to)) await syncDirectory(dirname(to));
  }
  async function move(from: string, to: string) {
    await rename(from, to);
    await flushMove(from, to);
  }

  async function review(
    manifest: PackageManifest,
    version: number,
    destination: ResourceDestination,
  ): Promise<ReviewedInstall> {
    await safeParents(destination.root);
    const before = await snapshot(destination.path);
    if (before && before.directory !== destination.package) throw changed();
    const main = destination.package ? join(destination.path, 'SKILL.md') : destination.path;
    if (before && (await readSafeFile(main)).includes(Buffer.from('aasc-alias:v1')))
      throw new CloudError(
        'managed_alias',
        'This destination is a generated alias. Install the real target and reconcile its notes instead.',
        409,
      );
    return {
      id: randomUUID(),
      manifest,
      version,
      destination,
      before,
      anchors: [
        await directoryAnchor(destination.root),
        await directoryAnchor(dirname(destination.path)),
      ],
    };
  }
  async function recover(r: InstallReceipt): Promise<InstallReceipt> {
    await assertAnchors(r.anchors);
    await safeParents(dirname(r.destination.path));
    const current = await snapshot(r.destination.path),
      backup = await snapshot(r.backup);
    if (current?.digest === r.after.digest && backup?.digest === r.before?.digest) {
      await flushMove(r.stage, r.destination.path);
      r.state = 'installed';
      save(r);
      return r;
    }
    if (!current && r.before && backup?.digest === r.before.digest) {
      await move(r.backup, r.destination.path);
      r.state = 'restored';
      save(r);
      return r;
    }
    if (current?.digest === r.before?.digest && !backup) {
      await flushMove(r.backup, r.destination.path);
      r.state = 'restored';
      save(r);
      return r;
    }
    r.state = 'attention';
    save(r);
    throw changed();
  }
  async function install(
    plan: ReviewedInstall,
    binding: CloudBinding,
    read: (sha: string) => Promise<Buffer>,
    check: () => void,
  ): Promise<InstallReceipt> {
    const prior = store.get<InstallReceipt>('receipt', plan.id);
    if (prior) {
      if (prior.state === 'installed') {
        await assertAnchors(prior.anchors);
        await assertDestination(prior.destination.root, prior.destination.path, prior.after);
        return prior;
      }
      if (['prepared', 'backed-up', 'attention'].includes(prior.state)) {
        const recovered = await recover(prior);
        if (recovered.state === 'installed') return recovered;
      }
    }
    check();
    await assertAnchors(plan.anchors);
    const d = plan.destination;
    await assertDestination(d.root, d.path, plan.before);
    await safeParents(dirname(d.path), true);
    // A workspace inside a checkout (project resources) must not make the next Pull "dirty".
    await excludeInstallWorkspaces(d.root).catch((error) =>
      log.warn('cloud', `Could not exclude install backups from git: ${(error as Error).message}`),
    );
    const workspace = join(dirname(d.path), `.aasc-install-${randomUUID()}`);
    await mkdir(workspace, { mode: 0o700 });
    const stage = join(workspace, basename(d.path)),
      backup = join(workspace, 'original'),
      displaced = join(workspace, 'installed');
    let receipt: InstallReceipt | undefined;
    try {
      await syncDirectory(dirname(workspace));
      if (d.package) {
        await mkdir(stage, { mode: 0o700 });
        for (const dir of plan.before?.directories ?? [])
          await safeParents(join(stage, dir.path), true);
      }
      const incoming = new Set(d.files.map((f) => f.localPath));
      for (const old of d.package ? (plan.before?.files ?? []) : []) {
        if (incoming.has(old.path)) continue;
        check();
        await writeVerified(join(stage, old.path), await readSafeFile(join(d.path, old.path)), old);
      }
      for (const file of plan.manifest.files) {
        check();
        const local = d.files.find((f) => f.manifestPath === file.path)!.localPath;
        const bytes = await read(file.sha256);
        if (bytes.includes(Buffer.from('aasc-alias:v1')))
          throw new CloudError(
            'managed_alias',
            'Managed alias content must be materialized from reviewed notes intent.',
            409,
          );
        if (!bytes.includes(0) && redactText(bytes.toString('utf8')) !== bytes.toString('utf8'))
          throw new CloudError(
            'secret_detected',
            'Possible secret detected in the package. Installation was blocked.',
            409,
          );
        await writeVerified(d.package ? join(stage, local) : stage, bytes, {
          ...file,
          path: local,
        });
      }
      if (d.package) {
        for (const dir of [...(plan.before?.directories ?? [])].sort(
          (a, b) => b.path.length - a.path.length,
        ))
          await chmod(join(stage, dir.path), dir.mode);
        for (const dir of [...(await snapshot(stage))!.directories].sort(
          (a, b) => b.path.length - a.path.length,
        ))
          await syncDirectory(join(stage, dir.path));
        await syncDirectory(stage);
      }
      await syncDirectory(workspace);
      const after = await snapshot(stage);
      if (!after) throw changed();
      check();
      await assertAnchors(plan.anchors);
      await assertDestination(d.root, d.path, plan.before);
      receipt = {
        id: plan.id,
        resourceId: plan.manifest.resourceId,
        version: plan.version,
        binding,
        anchors: plan.anchors,
        destination: d,
        before: plan.before,
        after,
        workspace,
        stage,
        backup,
        displaced,
        state: 'prepared',
      };
      save(receipt); // FULL SQLite commit precedes the first move of originals.
      if (plan.before) {
        await move(d.path, backup);
        receipt.state = 'backed-up';
        save(receipt);
        if ((await snapshot(backup))?.digest !== plan.before.digest) throw changed();
      }
      // A connection switch after backup restores at this boundary instead of installing under new intent.
      check();
      await assertAnchors(plan.anchors);
      await safeParents(dirname(d.path));
      if (await snapshot(d.path)) throw changed();
      await move(stage, d.path);
      await assertDestination(d.root, d.path, after);
      receipt.state = 'installed';
      save(receipt);
      // A new installation keeps no backup: its emptied workspace goes (rmdir refuses anything else).
      if (!plan.before) await rmdir(workspace).catch(() => {});
      return receipt;
    } catch (error) {
      if (receipt) {
        try {
          await recover(receipt);
        } catch {
          /* durable attention and original backup remain */
        }
      } else await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  }
  async function restore(id: string) {
    const r = store.get<InstallReceipt>('receipt', id);
    if (!r || !r.before || !['installed', 'restoring'].includes(r.state))
      throw new CloudError(
        'restore_unavailable',
        'Only an unchanged replacement with an original backup can be restored. New installations are retained.',
        409,
      );
    await assertAnchors(r.anchors);
    if (r.state === 'restoring') {
      const current = await snapshot(r.destination.path),
        displaced = await snapshot(r.displaced),
        backup = await snapshot(r.backup);
      if (current?.digest === r.before.digest && displaced?.digest === r.after.digest && !backup) {
        await flushMove(r.backup, r.destination.path);
        r.state = 'restored';
        save(r);
        return r;
      }
      if (!current && displaced?.digest === r.after.digest && backup?.digest === r.before.digest) {
        await move(r.backup, r.destination.path);
        r.state = 'restored';
        save(r);
        return r;
      }
      if (current?.digest !== r.after.digest || displaced) throw changed();
    }
    await assertDestination(r.destination.root, r.destination.path, r.after);
    if ((await snapshot(r.backup))?.digest !== r.before.digest || (await snapshot(r.displaced)))
      throw changed();
    r.state = 'restoring';
    save(r);
    // The receipt records restore intent before either move, and retains both copies.
    await move(r.destination.path, r.displaced);
    if ((await snapshot(r.displaced))?.digest !== r.after.digest) throw changed();
    try {
      await rename(r.backup, r.destination.path);
    } catch (error) {
      await move(r.displaced, r.destination.path);
      r.state = 'installed';
      save(r);
      throw error;
    }
    await flushMove(r.backup, r.destination.path);
    r.state = 'restored';
    save(r);
    return r;
  }

  return { review, install, restore, recover };
}
