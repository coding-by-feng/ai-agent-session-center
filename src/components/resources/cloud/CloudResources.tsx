/**
 * CloudResources — RESOURCES → Cloud sync (AASC-62; regrouped Oct 23 2026). Every resource saved to
 * cloud, filed by what it needs from you — **Needs you** (a choice, a memory OK, can't sync),
 * **Waiting** (Sync now moves it), **Synced**, **Stopped on this Mac**, **Removed from cloud** — and
 * one Sync now. Nothing syncs in the background. Resources join from Library (a resource's Save to
 * cloud, or the bulk bar); each row's menu opens it in Library, stops or resumes it here, or
 * removes it from the cloud. Download ZIP, Restore and past syncs sit under a collapsed Activity.
 *
 * The list is the shared one (syncStatusStore): the Library's glyphs, this list and the tab's
 * count always agree.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ResourceCatalog } from '@/types/resources';
import type { CloudJob as Job, SyncItem, SyncResult } from '@/types/cloudResources';
import { cloudApi } from '@/lib/cloudApi';
import { cloudCount, resourceKindLabel } from '@/lib/cloudFormat';
import {
  MOVING_STATES,
  SYNC_GROUPS,
  SYNC_STATE_INFO,
  syncGroup,
  syncVersionText,
  type SyncGroup,
} from '@/lib/cloudSyncStates';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import Menu, { type MenuItem } from '@/components/ui/Menu';
import NativeSelect from '@/components/ui/NativeSelect';
import SectionHeader from '@/components/ui/SectionHeader';
import StaleNote from '@/components/ui/StaleNote';
import { MoreActionsIcon } from '@/components/ui/icons';
import CloudJob from './CloudJob';
import { useCloudAction, useCloudSession } from './cloudSession';
import { cacheKey, readCache, rememberJob, type SavedJob } from './cloudCache';
import { openCloudDialog, useCloudSyncActions } from './cloudActions';
import { loadSyncStatus, reloadSyncStatus, useSyncStatus } from './syncStatusStore';
import RefusalReason from './RefusalReason';
import styles from '@/styles/modules/CloudResources.module.css';

const ACTIVE: Job['state'][] = ['queued', 'running'];
type Choice = 'mine' | 'cloud';
/** Groups open at first: what needs you and what is waiting. The rest is there when you look. */
const OPEN_AT_FIRST: Readonly<Record<SyncGroup, boolean>> = {
  'needs-you': true,
  waiting: true,
  synced: false,
  stopped: false,
  removed: false,
};

export default function CloudResources({
  catalog,
  onLibrary,
  onShowResource,
  visible = true,
}: {
  catalog: ResourceCatalog;
  onLibrary: () => void;
  /** Open the Library resource a row syncs with. */
  onShowResource: (catalogId: string) => void;
  visible?: boolean;
}) {
  const session = useCloudSession(),
    action = useCloudAction(),
    rowActions = useCloudSyncActions(),
    binding = session.status.connection,
    key = cacheKey(binding),
    activityId = useId();
  const sync = useSyncStatus(key);
  const [choices, setChoices] = useState<Record<string, Choice>>({}),
    [okMemory, setOkMemory] = useState<string[]>([]),
    [running, setRunning] = useState<string[]>([]),
    [skipped, setSkipped] = useState<SyncResult['skipped']>([]),
    [open, setOpen] = useState<Readonly<Record<SyncGroup, boolean>>>(OPEN_AT_FIRST),
    [activityOpen, setActivityOpen] = useState(false),
    [zip, setZip] = useState(''),
    [jobsTick, setJobsTick] = useState(0),
    // The jobs this tab's Sync now started, also kept here: when the browser refuses to store
    // them, they would otherwise show nowhere, nothing would poll them and "Syncing…" never clear.
    [started, setStarted] = useState<readonly SavedJob[]>([]);
  const watching = useRef(new Set<string>());
  const items = useMemo(
    () => [...(sync.value?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [sync.value],
  );
  const grouped = useMemo(() => {
    const by = new Map<SyncGroup, SyncItem[]>(SYNC_GROUPS.map((g) => [g.id, []]));
    for (const i of items) by.get(syncGroup(i))!.push(i);
    return by;
  }, [items]);
  // The browser's job history: jobs started here, from Library, or before a reload.
  const savedJobs = useMemo(
    () => (key ? readCache(key).jobs.filter((j) => !j.projectId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when a job moved or the tab came back
    [key, visible, sync.jobs, jobsTick],
  );
  const known = useMemo(() => new Set(catalog.resources.map((r) => r.id)), [catalog.resources]);

  // An account change clears this tab's own decisions; the list itself is the store's.
  const [epochSeen, setEpochSeen] = useState(session.epoch);
  if (epochSeen !== session.epoch) {
    setEpochSeen(session.epoch);
    setChoices({});
    setOkMemory([]);
    setSkipped([]);
    setRunning([]);
  }
  useEffect(() => {
    watching.current.clear();
  }, [session.epoch]);

  const reload = () => {
    if (binding) void loadSyncStatus(binding);
  };
  /** After this tab's jobs ended: a read already running may predate them. */
  const reread = () => {
    if (binding) void reloadSyncStatus(binding);
  };
  /**
   * Watch the jobs a Sync now started; when the last one ends, read the list again. The set lives
   * in a ref: a sync's two jobs can end in one render, and each handler must see the other's
   * removal, or the list waits on a job that already finished.
   */
  function follow(started: Job[]) {
    watching.current = new Set(started.filter((j) => ACTIVE.includes(j.state)).map((j) => j.id));
    setRunning([...watching.current]);
    if (!watching.current.size) reread();
  }
  function jobChanged(next: Job, generation: number) {
    rememberJob(key, next, generation);
    setStarted((list) => list.map((j) => (j.job.id === next.id ? { ...j, job: next } : j)));
    setJobsTick((n) => n + 1);
    if (!ACTIVE.includes(next.state) && watching.current.delete(next.id)) {
      setRunning([...watching.current]);
      if (!watching.current.size) reread();
    }
  }

  const needsMove = (i: SyncItem) => MOVING_STATES.includes(i.state);
  const moving = items.filter(
    (i) =>
      (i.state === 'local-changed' ||
        i.state === 'cloud-newer' ||
        i.state === 'cloud-only' ||
        (i.state === 'conflict' && choices[i.resourceId])) &&
      (!i.memory || okMemory.includes(i.resourceId)),
  ).length;
  const needChoice = items.filter((i) => i.state === 'conflict' && !choices[i.resourceId]).length,
    needOk = items.filter(
      (i) => i.memory && needsMove(i) && !okMemory.includes(i.resourceId),
    ).length;
  const syncing = running.length > 0;
  const summary = [
    `${moving} waiting`,
    needChoice ? `${needChoice} need${needChoice === 1 ? 's' : ''} your choice` : '',
    needOk ? `${cloudCount(needOk, 'memory file')} need${needOk === 1 ? 's' : ''} your OK` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  function syncNow() {
    const conflicts = new Set(items.filter((i) => i.state === 'conflict').map((i) => i.resourceId));
    const request = {
      choices: Object.fromEntries(Object.entries(choices).filter(([id]) => conflicts.has(id))),
      memory: okMemory,
    };
    action.run(
      (b, s) => cloudApi.syncNow(request, b, s),
      (result) => {
        setSkipped(result.skipped);
        setChoices({});
        setOkMemory([]);
        const generation = session.status.connection!.generation;
        for (const job of result.jobs) rememberJob(key, job, generation);
        setStarted(result.jobs.map((job) => ({ job, generation })));
        setJobsTick((n) => n + 1);
        follow(result.jobs);
      },
    );
  }

  // A blocked row already says why the sync left it alone; the note above names only the rest.
  const leftAlone = skipped.filter(
    (s) =>
      !items.some(
        (i) => i.resourceId === s.resourceId && i.state === 'blocked' && i.reason === s.reason,
      ),
  );
  const history = savedJobs.filter((j) => !running.includes(j.job.id));
  const runningJobs = running
    .map((id) => savedJobs.find((j) => j.job.id === id) ?? started.find((j) => j.job.id === id))
    .filter((j): j is SavedJob => !!j);
  const rowDisabled = !rowActions.enabled || rowActions.busy || syncing || sync.stale;

  function rowMenu(i: SyncItem): MenuItem[] {
    const menu: MenuItem[] = [];
    if (i.catalogId && known.has(i.catalogId))
      menu.push({
        kind: 'action',
        id: 'open',
        label: 'Open in Library',
        onSelect: () => onShowResource(i.catalogId!),
      });
    if (i.state === 'stopped')
      menu.push({
        kind: 'action',
        id: 'resume',
        label: 'Sync again',
        disabled: rowDisabled,
        onSelect: () => rowActions.control(i, 'resume'),
      });
    else if (i.state === 'removed')
      menu.push({
        kind: 'action',
        id: 'forget',
        label: 'Forget it on this Mac',
        hint: 'Keeps the files; it no longer shows as synced.',
        disabled: rowDisabled,
        onSelect: () => rowActions.control(i, 'stop'),
      });
    else
      menu.push({
        kind: 'action',
        id: 'stop',
        label: 'Stop syncing on this Mac',
        hint: 'Keeps the files and the cloud copy; nothing moves here until Sync again.',
        disabled: rowDisabled,
        onSelect: () => rowActions.control(i, 'stop'),
      });
    if (i.state !== 'removed')
      menu.push({
        kind: 'action',
        id: 'remove',
        label: 'Remove from cloud…',
        disabled: rowDisabled,
        onSelect: () => openCloudDialog({ kind: 'remove', item: i }),
      });
    return menu;
  }

  return (
    <>
      <SectionHeader
        label="Saved to cloud"
        count={items.length}
        countLabel={cloudCount(items.length, 'saved resource')}
      />
      <div className={styles.toolbar}>
        <Button
          variant="primary"
          disabled={!action.enabled || action.busy || syncing || !moving || sync.stale}
          onClick={syncNow}
        >
          {syncing ? 'Syncing…' : moving ? `Sync now (${moving})` : 'Sync now'}
        </Button>
        <Button disabled={!action.enabled || sync.loading || syncing} onClick={reload}>
          {sync.loading ? 'Checking…' : 'Check again'}
        </Button>
        {items.length > 0 && (
          <span role="status" className={styles.hint}>
            {summary}
          </span>
        )}
      </div>
      {items.length > 0 &&
        !sync.loading &&
        (sync.stale || session.status.state !== 'connected') && (
          <StaleNote>
            Showing the list saved in this browser. Check again while connected before syncing.
          </StaleNote>
        )}
      {needChoice > 0 && (
        <p className={`${styles.hint} ${styles.choiceHint}`}>
          Keep mine saves this Mac’s copy as the cloud’s next version. Use cloud’s replaces this
          Mac’s copy and keeps a backup you can restore from Activity.
        </p>
      )}
      {runningJobs.map((j) => (
        <CloudJob
          key={j.job.id}
          job={j.job}
          owned={j.generation === session.status.connection?.generation}
          onChange={(next) => jobChanged(next, j.generation)}
        />
      ))}
      {leftAlone.length > 0 && !syncing && (
        <div className={styles.banner}>
          <p className={styles.hint}>Left as they were in the last sync:</p>
          <ul className={styles.skipped}>
            {leftAlone.map((s) => (
              <li key={s.resourceId}>
                <strong>{s.name}</strong>: <RefusalReason reason={s.reason} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {!items.length &&
        (sync.loading && !sync.value ? (
          <EmptyState compact busy title="Checking cloud resources…" />
        ) : (
          <EmptyState
            compact
            title="Nothing saved to cloud yet."
            hint="In Library, open a resource and press Save to cloud, or select several with Select and use the bar under the list. They then stay in step on every Mac you sync."
            action={<Button onClick={onLibrary}>Open Library</Button>}
          />
        ))}
      {SYNC_GROUPS.map((g) => {
        const rows = grouped.get(g.id) ?? [];
        if (!rows.length) return null;
        const listId = `${activityId}-${g.id}`;
        return (
          <section key={g.id} aria-label={g.label}>
            <SectionHeader
              label={g.label}
              count={rows.length}
              countLabel={cloudCount(rows.length, 'resource')}
              collapsed={!open[g.id]}
              onToggle={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
              controls={listId}
              level={3}
            />
            <ul id={listId} hidden={!open[g.id]} className={styles.syncList} aria-label={g.label}>
              {rows.map((i) => (
                <SyncRow
                  key={i.resourceId}
                  item={i}
                  choice={choices[i.resourceId]}
                  ok={okMemory.includes(i.resourceId)}
                  disabled={syncing}
                  menu={rowMenu(i)}
                  onChoice={(value) => setChoices((c) => ({ ...c, [i.resourceId]: value }))}
                  onOk={(on) =>
                    setOkMemory((ids) =>
                      on ? [...ids, i.resourceId] : ids.filter((id) => id !== i.resourceId),
                    )
                  }
                />
              ))}
            </ul>
          </section>
        );
      })}
      {sync.cacheError && (
        <StaleNote>
          Browser history could not be saved. Keep this window open to keep the activity list.
        </StaleNote>
      )}
      {(action.error || rowActions.error || sync.error) && (
        <div role="alert" className={styles.error}>
          {action.error ?? rowActions.error ?? sync.error}
        </div>
      )}
      <SectionHeader
        label="Activity"
        count={history.length}
        countLabel={cloudCount(history.length, 'past job')}
        collapsed={!activityOpen}
        onToggle={() => setActivityOpen((o) => !o)}
        controls={activityId}
      />
      <div id={activityId} hidden={!activityOpen}>
        <p className={styles.hint}>
          Past syncs and saves, with Restore for anything a sync replaced. A ZIP is a portable copy
          of one saved resource; it never installs anything.
        </p>
        <div className={styles.toolbar}>
          <Field className={`${styles.selectField} ${styles.zipField}`} label="Download as ZIP">
            <NativeSelect
              value={zip}
              onChange={setZip}
              options={[
                { value: '', label: 'Choose a saved resource' },
                ...items
                  .filter((i) => i.cloudVersion)
                  .map((i) => ({
                    value: i.resourceId,
                    label: `${i.name} · ${resourceKindLabel(i.agent, i.kind)} · v${i.cloudVersion}`,
                  })),
              ]}
            />
          </Field>
          <Button
            disabled={!action.enabled || action.busy || !zip}
            onClick={() => {
              const item = items.find((i) => i.resourceId === zip);
              if (!item?.cloudVersion) return;
              action.run(
                (b, s) =>
                  cloudApi.download(
                    { resourceId: item.resourceId, version: item.cloudVersion! },
                    b,
                    s,
                  ),
                (job) => {
                  rememberJob(key, job, session.status.connection!.generation);
                  setJobsTick((n) => n + 1);
                },
              );
            }}
          >
            Download ZIP
          </Button>
        </div>
        {!history.length && <p className={styles.hint}>No past syncs in this browser yet.</p>}
        {history.map((j) => (
          <CloudJob
            key={j.job.id}
            job={j.job}
            owned={j.generation === session.status.connection?.generation}
            onChange={(next) => jobChanged(next, j.generation)}
          />
        ))}
      </div>
    </>
  );
}

function SyncRow({
  item: i,
  choice,
  ok,
  disabled,
  menu,
  onChoice,
  onOk,
}: {
  item: SyncItem;
  choice?: Choice;
  ok: boolean;
  disabled: boolean;
  menu: MenuItem[];
  onChoice: (value: Choice) => void;
  onOk: (on: boolean) => void;
}) {
  const info = SYNC_STATE_INFO[i.state];
  const version = syncVersionText(i);
  const moves = MOVING_STATES.includes(i.state);
  return (
    <li className={styles.syncRow}>
      <div className={styles.syncMain}>
        <span className={styles.syncName}>{i.name}</span>
        <span className={styles.hint}>
          {resourceKindLabel(i.agent, i.kind)}
          {i.scope === 'project' ? ' · project' : ''}
          {version ? ` · ${version}` : ''}
        </span>
        {i.reason && <span className={styles.hint}><RefusalReason reason={i.reason} /></span>}
        {i.state === 'cloud-only' && (
          <span className={styles.hint}>Not on this Mac yet: Sync now installs it here.</span>
        )}
      </div>
      <div className={styles.syncSide}>
        <Chip tone={info.tone}>{info.label}</Chip>
        {i.state === 'conflict' && (
          <div
            className={styles.choice}
            role="group"
            aria-label={`Which copy of ${i.name} to keep`}
          >
            {(
              [
                ['mine', 'Keep mine'],
                ['cloud', 'Use cloud’s'],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                pressed={choice === value}
                disabled={disabled}
                onClick={() => onChoice(value)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        {i.memory && moves && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={ok}
              disabled={disabled}
              onChange={(e) => onOk(e.target.checked)}
            />
            OK to sync this memory file
          </label>
        )}
        <Menu
          label={`Actions for ${i.name}`}
          triggerLabel={`More actions for ${i.name}`}
          triggerIcon={<MoreActionsIcon />}
          align="end"
          sections={[{ id: 'row', items: menu }]}
        />
      </div>
    </li>
  );
}
