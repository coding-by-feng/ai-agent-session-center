/**
 * ResourcesView — the RESOURCES tab (Phase B: read-only, plus Uninstall).
 *
 * One catalog of every Claude Code and Codex resource on this machine —
 * skills, commands, rules, CLAUDE.md/AGENTS.md, memory, agents, hooks, MCP
 * servers, plugins, settings — global and per project, compared with the
 * agent-skills repo copy. Everything arrives through `/api/resources`
 * (src/lib/resourcesApi.ts). Its only write is Uninstall, which MOVES one
 * resource into the AASC trash (Restore moves it back); it never edits a file
 * in place, which is why it still never touches ProjectTab or `/api/files/*`.
 *
 * All view state lives in the URL (`section`, `type`, `agent`, `scope`,
 * `project`, `q`, `id`, `plugins`), so every view is a link:
 * `/resources?project=<id>` opens a project's resources, and a Checks finding
 * opens the resource it is about.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigationType, useSearchParams } from 'react-router';
import type { ResourceCatalog, ResourceProject, ResourceSummary, ResourceType, UninstallResult } from '@/types/resources';
import {
  RESOURCE_SECTIONS,
  catalogSummaryLine,
  countByType,
  emptyStateMessage,
  filterResources,
  isPluginOrSystem,
  needsRootsRescan,
  readResourceParams,
  withParams,
  type AgentFilter,
  type ResourceFilters,
  type ResourceSection,
  type ResourceViewParams,
  type ScopeFilter,
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
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import { useUiStore } from '@/stores/uiStore';
import { buildResourceShortcuts } from '@/lib/commandShortcuts';
import ResourceTypeRail from '@/components/resources/ResourceTypeRail';
import ResourceList from '@/components/resources/ResourceList';
import ResourceDetail from '@/components/resources/ResourceDetail';
import SourcesPanel from '@/components/resources/SourcesPanel';
import ChecksPanel from '@/components/resources/ChecksPanel';
import { RESTORE_WINDOW_MS, UNINSTALL_MODAL_ID, UninstallDialog } from '@/components/resources/UninstallControls';
import styles from '@/styles/modules/Resources.module.css';

const POLL_MS = 750;
/** How often "scanned 2m ago" is re-derived; it has minute resolution. */
const AGE_TICK_MS = 30_000;
const UNAVAILABLE_MESSAGE = 'Resources are available only on this machine — open AASC on the Mac that runs it.';
const SECTION_LABELS: Record<ResourceSection, string> = { library: 'Library', sources: 'Sources', checks: 'Checks' };
const NO_RESOURCES: ResourceSummary[] = [];
const NO_PROJECTS: ResourceProject[] = [];
const AGENT_OPTIONS: readonly NativeSelectOption<AgentFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'shared', label: 'Shared' },
];
const SCOPE_OPTIONS: readonly NativeSelectOption<ScopeFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'global', label: 'Global' },
  { value: 'project', label: 'Project' },
];

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

function SectionTabs({ baseId, section, onSelect }: {
  baseId: string;
  section: ResourceSection;
  onSelect: (section: ResourceSection) => void;
}) {
  return (
    <div className={styles.sectionTabs} role="tablist" aria-label="Resource sections">
      {RESOURCE_SECTIONS.map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          id={`${baseId}-tab-${s}`}
          aria-selected={s === section}
          aria-controls={`${baseId}-panel`}
          className={s === section ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => onSelect(s)}
        >
          {SECTION_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

interface FilterBarProps {
  params: ResourceViewParams;
  queryDraft: string;
  projects: readonly ResourceProject[];
  onQuery: (query: string) => void;
  onAgent: (agent: AgentFilter) => void;
  onScope: (scope: ScopeFilter) => void;
  onProject: (projectId: string) => void;
  onTogglePlugins: () => void;
}

function FilterBar({ params, queryDraft, projects, onQuery, onAgent, onScope, onProject, onTogglePlugins }: FilterBarProps) {
  const projectOptions = useMemo<NativeSelectOption[]>(
    () => [
      { value: '', label: 'All projects' },
      ...[...projects]
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
        .map((p) => ({ value: p.id, label: p.duplicateName ? `${p.name} — ${p.path}` : p.name })),
    ],
    [projects],
  );
  return (
    <div className={styles.filters}>
      <TextInput
        type="search"
        className={styles.search}
        aria-label="Search resources"
        placeholder="Search name, description, path…"
        value={queryDraft}
        onChange={(e) => onQuery(e.target.value)}
      />
      <Field label="Agent" className={styles.filterField}>
        <NativeSelect className={styles.filterSelect} value={params.agent} onChange={onAgent} options={AGENT_OPTIONS} />
      </Field>
      <Field label="Scope" className={styles.filterField}>
        <NativeSelect className={styles.filterSelect} value={params.scope} onChange={onScope} options={SCOPE_OPTIONS} />
      </Field>
      {params.scope === 'project' && (
        <Field label="Project" className={styles.filterField}>
          <NativeSelect className={styles.filterSelect} value={params.projectId ?? ''} onChange={onProject} options={projectOptions} />
        </Field>
      )}
      <Button pressed={params.showPluginSystem} onClick={onTogglePlugins}>
        {'Show plugin & system'}
      </Button>
    </div>
  );
}

export default function ResourcesView() {
  const baseId = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const params = useMemo(() => readResourceParams(searchParams), [searchParams]);
  const [extraRoots, setExtraRoots] = useState<string[]>(() => readExtraRoots());
  const [storageOk, setStorageOk] = useState(true);
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
  const filters = useMemo<ResourceFilters>(
    () => ({ agent, scope, projectId, query, showPluginSystem }),
    [agent, scope, projectId, query, showPluginSystem],
  );
  const counts = useMemo(() => countByType(resources, filters), [resources, filters]);
  // A bare deep link (no `type`) opens the first type that has anything in it.
  const type: ResourceType = searchParams.has('type')
    ? params.type
    : (counts.find((c) => c.count > 0)?.type ?? params.type);
  const list = useMemo(() => filterResources(resources, filters, type), [resources, filters, type]);

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
    if (ui.activeModal === UNINSTALL_MODAL_ID) ui.closeModal();
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

  if (unavailable) {
    return (
      <div className={styles.view}>
        <header className={styles.header}>
          <h1 className={styles.title}>Agent resources</h1>
        </header>
        <EmptyState fill title={UNAVAILABLE_MESSAGE} />
      </div>
    );
  }

  const scanning = catalog?.state === 'scanning';
  const busy = scanning || rescanPending;
  const inLibrary = params.section === 'library';
  // On a phone an open resource takes the whole body; the filters above it
  // cannot change what it shows, so the stylesheet folds them away.
  const detailOpen = inLibrary && params.id !== null;
  return (
    <div className={detailOpen ? `${styles.view} ${styles.viewDetailOpen}` : styles.view}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>Agent resources</h1>
          <SectionTabs
            baseId={baseId}
            section={params.section}
            onSelect={(s) => updateParams({ section: s === 'library' ? null : s })}
          />
          <Button
            className={styles.rescanButton}
            disabled={!catalog || busy}
            aria-busy={busy || undefined}
            onClick={() => rescan(extraRoots)}
          >
            Rescan
          </Button>
        </div>
        {inLibrary && resources.length > 0 && (
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
          />
        )}
        {catalog && <p className={styles.countsLine}>{catalogSummaryLine(catalog, showPluginSystem, now)}</p>}
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
        {!catalog && !error && <EmptyState fill busy title="Loading resources…" />}
        {!catalog && error && (
          <EmptyState fill tone="error" title={error} action={<Button onClick={reload}>Retry</Button>} />
        )}
        {catalog && params.section === 'sources' && (
          <SourcesPanel
            catalog={catalog}
            extraRoots={extraRoots}
            storageOk={storageOk}
            onAddRoot={(path) => saveExtraRoots([...extraRoots, path])}
            onRemoveRoot={(path) => saveExtraRoots(extraRoots.filter((p) => p !== path))}
          />
        )}
        {catalog && params.section === 'checks' && (
          <ChecksPanel findings={catalog.findings} byId={byId} projectsById={projectsById} onSelect={showResource} />
        )}
        {catalog && inLibrary && resources.length === 0 && (
          catalog.state === 'error' ? (
            <EmptyState fill title="Nothing to show — the last scan failed before it found anything. Rescan to try again." />
          ) : scanning ? (
            <EmptyState fill busy title="The first scan is running — results appear here as soon as it finishes." />
          ) : (
            <EmptyState
              fill
              title="No agent resources were found on this machine."
              hint="Sources lists every root and what was scanned there."
              action={<Button onClick={() => updateParams({ section: 'sources' })}>Open Sources</Button>}
            />
          )
        )}
        {inLibrary && resources.length > 0 && (
          <div className={params.id ? `${styles.library} ${styles.libraryDetailOpen}` : styles.library}>
            <ResourceTypeRail counts={counts} selected={type} onSelect={(t) => updateParams({ type: t, id: null })} />
            <ResourceList
              type={type}
              resources={list}
              selectedId={params.id}
              projectsById={projectsById}
              emptyMessage={emptyStateMessage(type, filters, projectId ? projectsById.get(projectId)?.name : undefined)}
              scrollResetKey={`${type}|${agent}|${scope}|${projectId ?? ''}|${query}|${showPluginSystem}`}
              shortcuts={shortcuts}
              onSelect={selectResource}
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
