/**
 * ResourcesView — local resource catalog, restorable Uninstall, projects and machines.
 *
 * One catalog of every Claude Code and Codex resource on this machine —
 * skills, commands, rules, CLAUDE.md/AGENTS.md, memory, agents, hooks, MCP
 * servers, plugins, settings — global and per project, compared with the
 * agent-skills repo copy. Everything arrives through `/api/resources`
 * (src/lib/resourcesApi.ts). Uninstall moves resources into the local trash.
 *
 * Three tabs since Nov 13 2026: **Library** (browse; its **Checks** button shows
 * Checks + Sources in place of the list, the Health tab before), **Projects**
 * (the lazy CloudPanel, which never uses ProjectTab or `/api/files/*`) and
 * **Machines** (This Mac's remote access; scan and SSH machines come next). The
 * AASC Cloud account is a button at the end of the tab row (the Connection tab
 * before). Cloud sync (AASC-62) was removed. The cloud session
 * (CloudSessionProvider) wraps the whole tab: Projects and the account need it.
 *
 * Catalog view state lives in the URL (`section`, `type`, `agent`, `scope`,
 * `project`, `q`, `id`, `plugins`, `sort`), so every view is a link:
 * `/resources?project=<id>` opens a project's resources, and a Checks finding
 * opens the resource it is about.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigationType, useSearchParams } from 'react-router';
import type { ResourceCatalog, ResourceProject, ResourceSummary, ResourceType, UninstallResult } from '@/types/resources';
import {
  catalogSummaryLine,
  checkErrors,
  countByType,
  emptyStateMessage,
  filterResources,
  isPluginOrSystem,
  needsRootsRescan,
  readResourceParams,
  withParams,
  type ResourceFilters,
  type ResourceSection,
} from '@/lib/resourceFilters';
import {
  ResourcesUnavailableError,
  errorMessage,
  fetchCatalog,
  isAbortError,
  readExtraRoots,
  restoreResource,
  startScan,
  writeExtraRoots,
} from '@/lib/resourcesApi';
import { showToast } from '@/components/ui/ToastContainer';
import Button from '@/components/ui/Button';
import CountBadge from '@/components/ui/CountBadge';
import EmptyState from '@/components/ui/EmptyState';
import { RefreshListIcon } from '@/components/ui/icons';
import { useUiStore } from '@/stores/uiStore';
import { buildResourceShortcuts } from '@/lib/commandShortcuts';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import { isNotable, readNoteParams, resourceNoteKey, tagsInUse } from '@/lib/skillNotes';
import ResourceTypeRail from '@/components/resources/ResourceTypeRail';
import ResourceList from '@/components/resources/ResourceList';
import ResourceDetail, { type DetailTab } from '@/components/resources/ResourceDetail';
import SectionTabs from '@/components/resources/SectionTabs';
import FilterBar from '@/components/resources/FilterBar';
import HealthPanel from '@/components/resources/HealthPanel';
import CloudSessionProvider from '@/components/resources/cloud/CloudSessionProvider';
import CloudAccountButton, { CLOUD_ACCOUNT_MODAL_ID } from '@/components/resources/cloud/CloudAccountButton';
import { useResourceUsage } from '@/components/resources/useResourceUsage';
import { isUsageCounted, readResourceSort, sortByUses } from '@/lib/resourceUsage';
import { RESTORE_WINDOW_MS, UNINSTALL_MODAL_ID, UninstallDialog } from '@/components/resources/UninstallControls';
import styles from '@/styles/modules/Resources.module.css';
import lib from '@/styles/modules/ResourceLibrary.module.css';

const CloudPanel = lazy(() => import('@/components/resources/cloud/CloudPanel'));
const MachinesPanel = lazy(() => import('@/components/resources/machines/MachinesPanel'));
/** No tab carries a count yet (Machines will: machines that need you). */
const NO_BADGES: Partial<Record<ResourceSection, number>> = {};
const POLL_MS = 750;
/** How often "scanned 2m ago" is re-derived; it has minute resolution. */
const AGE_TICK_MS = 30_000;
const UNAVAILABLE_MESSAGE = 'Resources are available only on this machine — open AASC on the Mac that runs it.';
const NO_RESOURCES: ResourceSummary[] = [];
const NO_PROJECTS: ResourceProject[] = [];
/** Most tag chips the filter bar shows; the rest stay reachable by search. */
const MAX_TAG_CHOICES = 24;

/**
 * Loads the catalog and keeps it current while a scan runs.
 *
 * One request chain per load: the next poll is scheduled only after the
 * previous response, and only while the server reports `scanning`. Two
 * independent loops (a reload plus an interval) could overlap, and whichever
 * answer landed last won — an older `scanning` could replace a newer `ready`.
 * A failed request ends the chain: an error with Retry beats hammering a
 * server that is not answering.
 *
 * Every setState runs in a promise or timer callback, never in an effect body
 * (the lint config rejects synchronous setState in effects).
 */
function useResourceCatalog(extraRoots: readonly string[]) {
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [rescanPending, setRescanPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootsRef = useRef(extraRoots);
  const scanRequested = useRef(false);
  const scanRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    rootsRef.current = extraRoots;
  }, [extraRoots]);
  useEffect(() => () => scanRequest.current?.abort(), []);

  const applyFailure = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    if (err instanceof ResourcesUnavailableError) setUnavailable(true);
    else setError(errorMessage(err));
  }, []);

  const rescan = useCallback((roots: readonly string[]) => {
    scanRequested.current = true;
    scanRequest.current?.abort();
    const controller = new AbortController();
    scanRequest.current = controller;
    setRescanPending(true);
    startScan(roots, controller.signal).then(
      (started) => {
        setRescanPending(false);
        setError(null);
        // Show the scan at once; the reload starts a fresh chain.
        setCatalog((prev) => (prev ? { ...prev, state: started.state, progress: started.progress } : prev));
        setReloadTick((n) => n + 1);
      },
      (err: unknown) => {
        if (isAbortError(err)) return;
        setRescanPending(false);
        applyFailure(err);
      },
    );
  }, [applyFailure]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = () => fetchCatalog(controller.signal).then(onCatalog, applyFailure);
    function onCatalog(next: ResourceCatalog) {
      setCatalog(next);
      setError(null);
      setNow(Date.now());
      // Once per mount: a fresh server's first scan (started by GET) cannot
      // carry the folders added in Sources, so ask for one that does.
      if (!scanRequested.current && needsRootsRescan(next, rootsRef.current)) {
        rescan(rootsRef.current);
      } else if (next.state === 'scanning') {
        timer = setTimeout(request, POLL_MS);
      }
    }
    request();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reloadTick, applyFailure, rescan]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setReloadTick((n) => n + 1);
  }, []);

  return { catalog, error, unavailable, now, reload, rescan, rescanPending };
}

export default function ResourcesView() {
  return (
    <CloudSessionProvider>
      <ResourcesScreen />
    </CloudSessionProvider>
  );
}

function ResourcesScreen() {
  const baseId = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const params = useMemo(() => readResourceParams(searchParams), [searchParams]);
  const [extraRoots, setExtraRoots] = useState<string[]>(() => readExtraRoots());
  const [storageOk, setStorageOk] = useState(true);
  // Projects and Machines stay mounted once opened (a running job or a draft survives a switch,
  // and Remote access reads Tailscale once per visit).
  const [projectsVisited, setProjectsVisited] = useState(false);
  const [machinesVisited, setMachinesVisited] = useState(false);
  if (params.section === 'projects' && !projectsVisited) setProjectsVisited(true);
  if (params.section === 'machines' && !machinesVisited) setMachinesVisited(true);
  const [detailTab, setDetailTab] = useState<DetailTab>('preview');
  const { catalog, error, unavailable, now, reload, rescan, rescanPending } = useResourceCatalog(extraRoots);

  // The search box keeps its own draft. Navigations run inside startTransition,
  // so an <input> controlled straight from the URL drops keystrokes and jumps
  // its caret. Typing writes `q` with `replace`; any other navigation that
  // changes it (a Checks click, back/forward) is adopted into the draft here.
  const [queryDraft, setQueryDraft] = useState(params.query);
  const [syncedQuery, setSyncedQuery] = useState(params.query);
  if (params.query !== syncedQuery) {
    setSyncedQuery(params.query);
    if (navigationType !== 'REPLACE') setQueryDraft(params.query);
  }

  // Every URL write builds on the latest REQUESTED params. react-router hands
  // `setSearchParams` the params of the last render, and navigations commit in
  // a transition — so a row click landing before a keystroke's `q` had
  // committed used to rebuild from the old URL and silently drop the `q`.
  // `pending` remembers what we asked for; it is used while the committed URL
  // is still the one it was built from, and dropped on the next commit of ANY
  // URL change — ours, the NavBar's RESOURCES link, back/forward. Matching on
  // `from` alone is not enough: the URL can return to `from` (click Sources,
  // then the nav tab back to a bare /resources), and a stale `to` would then
  // resurrect the old sub-tab or a resource that Back had closed.
  const pending = useRef<{ from: string; to: URLSearchParams } | null>(null);
  useLayoutEffect(() => {
    pending.current = null;
  }, [searchParams]);
  const navigateParams = useCallback(
    (next: URLSearchParams, replace = false) => {
      pending.current = { from: searchParams.toString(), to: next };
      setSearchParams(next, { replace });
    },
    [searchParams, setSearchParams],
  );
  const updateParams = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      const request = pending.current;
      const base = request && request.from === searchParams.toString() ? request.to : searchParams;
      navigateParams(withParams(base, patch), replace);
    },
    [searchParams, navigateParams],
  );

  const resources = catalog?.resources ?? NO_RESOURCES;
  const projects = catalog?.projects ?? NO_PROJECTS;
  const byId = useMemo(() => new Map(resources.map((r) => [r.id, r] as const)), [resources]);
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p] as const)), [projects]);
  // Shortcut commands ("Shortcut for /x") ↔ their targets, once per catalog.
  const shortcuts = useMemo(() => buildResourceShortcuts(resources), [resources]);
  const { agent, scope, projectId, query, showPluginSystem } = params;
  // The user's notes (favourite / tags / abbreviation) join the filter; they live in this browser.
  const notes = useSkillNotesStore((s) => s.notes);
  const { favOnly, tags } = useMemo(() => readNoteParams(searchParams), [searchParams]);
  const tagKey = tags.join(',');
  const filters = useMemo<ResourceFilters>(
    () => ({ agent, scope, projectId, query, showPluginSystem, notes, favOnly, tags: tagKey ? tagKey.split(',') : [] }),
    [agent, scope, projectId, query, showPluginSystem, notes, favOnly, tagKey],
  );
  const tagChoices = useMemo(() => tagsInUse(notes).slice(0, MAX_TAG_CHOICES), [notes]);
  const realNames = useMemo(
    () => new Set(resources.filter(isNotable).map((r) => resourceNoteKey(r))),
    [resources],
  );
  const toggleTag = useCallback((tag: string) => {
    const next = tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag];
    updateParams({ tags: next.length > 0 ? next.join(',') : null }, true);
  }, [tags, updateParams]);
  const counts = useMemo(() => countByType(resources, filters), [resources, filters]);
  // A bare deep link (no `type`) opens the first type that has anything in it.
  const type: ResourceType = searchParams.has('type')
    ? params.type
    : (counts.find((c) => c.count > 0)?.type ?? params.type);
  // Skill/command uses over the last 90 days (Oct 23 2026); `?sort=uses` lists the most used first.
  const usage = useResourceUsage(catalog?.scannedAt ?? null);
  const sort = readResourceSort(searchParams);
  const list = useMemo(() => {
    const named = filterResources(resources, filters, type);
    return sort === 'uses' && usage && isUsageCounted(type) ? sortByUses(named, usage.byId) : named;
  }, [resources, filters, type, sort, usage]);

  const selectResource = useCallback((id: string) => updateParams({ id }), [updateParams]);
  const closeDetail = useCallback(() => updateParams({ id: null }), [updateParams]);

  // Open a finding's resource with every filter that could hide it cleared.
  const showResource = useCallback((r: ResourceSummary) => {
    navigateParams(withParams(new URLSearchParams(), {
      section: 'library', type: r.type, id: r.id, plugins: isPluginOrSystem(r) ? '1' : null,
    }));
  }, [navigateParams]);

  const saveExtraRoots = useCallback((next: string[]) => {
    setExtraRoots(next);
    setStorageOk(writeExtraRoots(next));
  }, []);

  // The uninstall dialog lives HERE, not in the detail pane: the pane is keyed by
  // `scannedAt` and remounts whenever a scan lands, which destroyed a dialog
  // inside it mid-typing (UninstallControls.tsx).
  const [uninstallTarget, setUninstallTarget] = useState<{ summary: ResourceSummary; otherCopies: string[] } | null>(null);
  const activeModal = useUiStore((s) => s.activeModal);
  const openModal = useUiStore((s) => s.openModal);
  const requestUninstall = useCallback((summary: ResourceSummary, otherCopies: string[]) => {
    setUninstallTarget({ summary, otherCopies });
    openModal(UNINSTALL_MODAL_ID);
  }, [openModal]);
  // Leaving the tab must not strand the modal id with no dialog behind it.
  useEffect(() => () => {
    const ui = useUiStore.getState();
    if (ui.activeModal === UNINSTALL_MODAL_ID || ui.activeModal === CLOUD_ACCOUNT_MODAL_ID) ui.closeModal();
  }, []);

  // The server already dropped it from the catalog; the rescan refreshes the
  // counts, findings and variants around it, with the folders added in Sources.
  // A failed Restore offers Restore again: the first toast — and its button —
  // is gone by then, and the usual fix (move the new file away) is the user's.
  const afterUninstall = useCallback((result: UninstallResult) => {
    closeDetail();
    rescan(extraRoots);
    const restore = (): void => {
      restoreResource(result.trashId).then(
        (restored) => {
          showToast(`Restored ${restored.name}`, 'success');
          rescan(extraRoots);
        },
        (err: unknown) => showToast(
          err instanceof ResourcesUnavailableError ? 'Nothing to restore — that trash entry is gone.' : errorMessage(err),
          'error',
          RESTORE_WINDOW_MS,
          err instanceof ResourcesUnavailableError ? undefined : { label: 'Restore', onClick: restore },
        ),
      );
    };
    showToast(`Uninstalled ${result.name}`, 'success', RESTORE_WINDOW_MS, { label: 'Restore', onClick: restore });
  }, [closeDetail, rescan, extraRoots]);

  // ---- Tabs, Checks and the cloud account (Nov 13 2026) ----
  const errors = catalog ? checkErrors(catalog.findings) : 0;
  const goSection = useCallback(
    (section: ResourceSection) =>
      updateParams({ section: section === 'library' ? null : section, cloudTab: null, checks: null }),
    [updateParams],
  );
  const toggleChecks = useCallback(
    () => updateParams({ section: null, cloudTab: null, checks: params.checks ? null : '1', id: null }),
    [updateParams, params.checks],
  );
  const openAccount = useCallback(() => openModal(CLOUD_ACCOUNT_MODAL_ID), [openModal]);
  // An old Connection link (or `account=1`) opens the account dialog once; closing it spends the link.
  // Not where RESOURCES is unavailable: that screen has no account button to draw the dialog, and a
  // modal id with no dialog blocks every "no modal open" check (the interrupted-sessions prompt …).
  useEffect(() => {
    if (params.account && !unavailable) openModal(CLOUD_ACCOUNT_MODAL_ID);
    if (unavailable && useUiStore.getState().activeModal === CLOUD_ACCOUNT_MODAL_ID) useUiStore.getState().closeModal();
  }, [params.account, unavailable, openModal]);
  // Rewrites the URL from what it resolved to (readResourceParams), so an old link keeps its tab
  // and Checks with no second copy of the old-link table here.
  const closeAccount = useCallback(() => {
    if (!params.account) return;
    updateParams(
      {
        account: null,
        cloudTab: null,
        section: params.section === 'library' ? null : params.section,
        checks: params.checks ? '1' : null,
      },
      true,
    );
  }, [params.account, params.section, params.checks, updateParams]);

  if (unavailable) {
    return (
      <div className={styles.view}>
        <header className={styles.header}>
          <h1 className={styles.title}>Resources</h1>
        </header>
        <EmptyState fill title={UNAVAILABLE_MESSAGE} />
      </div>
    );
  }

  const scanning = catalog?.state === 'scanning';
  const busy = scanning || rescanPending;
  const inLibrary = params.section === 'library';
  const inList = inLibrary && !params.checks;
  // On a phone an open resource takes the whole body; the filters above it
  // cannot change what it shows, so the stylesheet folds them away.
  const detailOpen = inList && params.id !== null;
  return (
    <div className={detailOpen ? `${styles.view} ${styles.viewDetailOpen}` : styles.view}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Resources</h1>
          <SectionTabs baseId={baseId} section={params.section} badges={NO_BADGES} onSelect={goSection} />
          <div className={styles.titleActions}>
            <CloudAccountButton onClose={closeAccount} />
            <Button
              icon={<RefreshListIcon />}
              disabled={!catalog || busy}
              aria-busy={busy || undefined}
              onClick={() => rescan(extraRoots)}
            >
              Rescan
            </Button>
          </div>
        </div>
        {inList && resources.length > 0 && (
          <FilterBar
            params={params}
            queryDraft={queryDraft}
            projects={projects}
            onQuery={(value) => {
              setQueryDraft(value);
              updateParams({ q: value || null }, true);
            }}
            onAgent={(value) => updateParams({ agent: value === 'all' ? null : value }, true)}
            onScope={(value) => updateParams({ scope: value === 'all' ? null : value, project: null }, true)}
            onProject={(value) => updateParams({ scope: 'project', project: value || null }, true)}
            onTogglePlugins={() => updateParams({ plugins: showPluginSystem ? null : '1' }, true)}
            favOnly={favOnly}
            tags={tags}
            tagChoices={tagChoices}
            onFav={() => updateParams({ fav: favOnly ? null : '1' }, true)}
            onTag={toggleTag}
            onClearMore={() => updateParams({ plugins: null, tags: null }, true)}
          />
        )}
        {catalog && (
          <div className={lib.summaryRow}>
            <p className={styles.countsLine}>{catalogSummaryLine(catalog, showPluginSystem, now)}</p>
            {inLibrary && (
              // Checks + Sources (the Health tab until Nov 13 2026). The badge counts errors only.
              <Button size="sm" pressed={params.checks} onClick={toggleChecks}>
                Checks
                {errors > 0 && (
                  <>
                    {' '}
                    <CountBadge count={errors} max={99} tone="accent" label={`${errors} ${errors === 1 ? 'error' : 'errors'}`} />
                  </>
                )}
              </Button>
            )}
          </div>
        )}
      </header>

      {catalog && error && (
        <div className={styles.banner} role="alert">
          <span>{error}</span>
          <Button onClick={reload}>Retry</Button>
        </div>
      )}
      {catalog?.state === 'error' && (
        <div className={styles.banner} role="alert">
          Last scan failed: {catalog.error ?? 'unknown error'}.
          {resources.length > 0 && ' Showing the previous results.'}
        </div>
      )}

      <div
        className={styles.body}
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${params.section}`}
      >
        {/* Machines needs no catalog; its loading and failure belong to the other tabs. */}
        {!catalog && !error && params.section !== 'machines' && <EmptyState fill busy title="Loading resources…" />}
        {!catalog && error && params.section !== 'machines' && (
          <EmptyState fill tone="error" title={error} action={<Button onClick={reload}>Retry</Button>} />
        )}
        {catalog && projectsVisited && (
          // Kept mounted once opened (hidden, not unmounted) so a running job and its draft survive a tab switch.
          <div hidden={params.section !== 'projects'} className={styles.cloudSection}>
            <Suspense fallback={<EmptyState busy title="Loading Projects…" />}>
              <CloudPanel catalog={catalog} open={params.section === 'projects'} />
            </Suspense>
          </div>
        )}
        {machinesVisited && (
          <div hidden={params.section !== 'machines'} className={styles.cloudSection}>
            <Suspense fallback={<EmptyState busy title="Loading Machines…" />}>
              <MachinesPanel open={params.section === 'machines'} onAccount={openAccount} />
            </Suspense>
          </div>
        )}
        {catalog && inLibrary && params.checks && (
          <HealthPanel
            catalog={catalog}
            byId={byId}
            projectsById={projectsById}
            onSelect={showResource}
            extraRoots={extraRoots}
            storageOk={storageOk}
            onAddRoot={(path) => saveExtraRoots([...extraRoots, path])}
            onRemoveRoot={(path) => saveExtraRoots(extraRoots.filter((p) => p !== path))}
          />
        )}
        {catalog && inList && resources.length === 0 && (
          catalog.state === 'error' ? (
            <EmptyState fill title="Nothing to show — the last scan failed before it found anything. Rescan to try again." />
          ) : scanning ? (
            <EmptyState fill busy title="The first scan is running — results appear here as soon as it finishes." />
          ) : (
            <EmptyState
              fill
              title="No agent resources were found on this machine."
              hint="Checks → Sources lists every root and what was scanned there."
              action={<Button onClick={toggleChecks}>Open Checks</Button>}
            />
          )
        )}
        {inList && resources.length > 0 && (
          <div className={params.id ? `${styles.library} ${styles.libraryDetailOpen}` : styles.library}>
            <ResourceTypeRail counts={counts} selected={type} onSelect={(t) => updateParams({ type: t, id: null })} />
            <ResourceList
              type={type}
              resources={list}
              selectedId={params.id}
              projectsById={projectsById}
              emptyMessage={emptyStateMessage(type, filters, projectId ? projectsById.get(projectId)?.name : undefined)}
              scrollResetKey={`${type}|${agent}|${scope}|${projectId ?? ''}|${query}|${showPluginSystem}|${favOnly}|${tagKey}`}
              shortcuts={shortcuts}
              onSelect={selectResource}
              usage={usage}
              sort={sort}
              onSort={(next) => updateParams({ sort: next === 'uses' ? 'uses' : null }, true)}
            />
            {params.id ? (
              <ResourceDetail
                // Remount per resource AND per completed scan: a Rescan re-reads
                // the open resource once, when `scannedAt` moves — not on polls.
                key={`${params.id}:${catalog?.scannedAt ?? ''}`}
                id={params.id}
                summary={byId.get(params.id)}
                byId={byId}
                projectsById={projectsById}
                shortcuts={shortcuts}
                onSelect={selectResource}
                onBack={closeDetail}
                onRequestUninstall={requestUninstall}
                realNames={realNames}
                tab={detailTab}
                onTab={setDetailTab}
                usage={usage}
                now={now}
              />
            ) : (
              <div className={styles.detailPlaceholder}>
                <p className={styles.muted}>Select a resource to see what is inside it.</p>
              </div>
            )}
          </div>
        )}
      </div>
      {uninstallTarget && activeModal === UNINSTALL_MODAL_ID && (
        <UninstallDialog
          // A fresh dialog (empty name field) for every resource it is opened for.
          key={uninstallTarget.summary.id}
          summary={uninstallTarget.summary}
          otherCopies={uninstallTarget.otherCopies}
          trashPath={catalog?.roots.trash}
          onUninstalled={afterUninstall}
        />
      )}
    </div>
  );
}
