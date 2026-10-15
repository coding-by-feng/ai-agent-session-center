/**
 * PhoneProjectBrowser — a session's files on a phone (AASC-20, feature 46):
 * a read-only drill-down, folder → folder → file, one screen at a time, with a
 * breadcrumb and Back, instead of the desktop's split tree and editor.
 *
 * - Read-only by construction. A paired phone may only read inside a shared
 *   session's project (server/mobile/phoneProfile.ts); there is no edit, new,
 *   rename, delete, reveal or "open on the Mac" here at all.
 * - A refused path answers a plain 404 (it must not be told from a missing
 *   one): every screen says so in words and offers a way out.
 * - Search (feature 50) finds names, or text; a text match opens the file at
 *   its line. Back returns to the results.
 * - A file can go full screen (portaled over the app, Escape or the button to
 *   leave). Viewers are lazy, in PhoneFileView's own chunks.
 *
 * Mounted by the phone app's Info → Files (InfoPageScreen), lazily: none of
 * this is in the entry chunk.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { useUiStore } from '@/stores/uiStore';
import { listDir, searchNames, searchText, type DirItem, type FilesResult, type NameHit, type TextHit } from '@/lib/phoneFiles';
import {
  ancestorsOf,
  baseName,
  breadcrumbs,
  fileErrorText,
  formatSize,
  joinRel,
  normalizeRel,
  parentRel,
  relInProject,
} from '@/lib/phoneProject';
import PhoneFileView, { Highlighted } from './PhoneFileView';
import { BackIcon, ChevronIcon, SearchIcon } from './projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

type Screen =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; line?: number; query?: string }
  | { kind: 'search' };

type SearchMode = 'names' | 'text';

interface SearchState {
  query: string;
  mode: SearchMode;
  /** What the results below answer (they stay until a new search lands). */
  ran: { query: string; mode: SearchMode } | null;
  busy: boolean;
  names: NameHit[];
  text: TextHit[];
  truncated: boolean;
  error: string | null;
}

const EMPTY_SEARCH: SearchState = { query: '', mode: 'names', ran: null, busy: false, names: [], text: [], truncated: false, error: null };

const storageKey = (sessionId: string) => `aasc:phone-project-dir:${sessionId}`;

function loadDir(sessionId: string): string {
  try {
    return normalizeRel(localStorage.getItem(storageKey(sessionId)) ?? '/');
  } catch {
    return '/';
  }
}

function saveDir(sessionId: string, dir: string): void {
  try {
    localStorage.setItem(storageKey(sessionId), dir);
  } catch {
    /* private mode: the folder is just not remembered */
  }
}

/** Dress the portal host for where it goes, and move it there (a DOM node React doesn't own). */
function placeHost(host: HTMLElement, className: string, target: HTMLElement | null): void {
  host.className = className;
  if (target && host.parentElement !== target) target.appendChild(host);
}

function isFullFor(fullscreen: boolean, top: Screen): boolean {
  return fullscreen && top.kind === 'file';
}

/** The stack that shows `dir`, so Back walks up through its parents. */
function dirStack(dir: string): Screen[] {
  return ancestorsOf(dir).map((path) => ({ kind: 'dir', path }));
}

export interface PhoneProjectBrowserProps {
  projectPath: string;
  sessionId: string;
}

export default function PhoneProjectBrowser({ projectPath, sessionId }: PhoneProjectBrowserProps) {
  const projectName = baseName(projectPath) || 'project';
  const [stack, setStack] = useState<Screen[]>(() => dirStack(loadDir(sessionId)));
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const top = stack[stack.length - 1];
  const folder = [...stack].reverse().find((s): s is Extract<Screen, { kind: 'dir' }> => s.kind === 'dir')?.path ?? '/';

  useEffect(() => saveDir(sessionId, folder), [sessionId, folder]);

  const push = useCallback((screen: Screen) => {
    setNotice(null);
    // Full screen belongs to a file: a folder or the search opens in the tab.
    if (screen.kind !== 'file') setFullscreen(false);
    setStack((s) => [...s, screen]);
  }, []);
  const back = useCallback(() => {
    setNotice(null);
    setFullscreen(false);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);
  const goToDir = useCallback((dir: string) => {
    setNotice(null);
    setFullscreen(false);
    setStack(dirStack(dir));
  }, []);
  const openFile = useCallback((path: string, line?: number, query?: string) => {
    push({ kind: 'file', path, ...(line ? { line } : {}), ...(query ? { query } : {}) });
  }, [push]);

  // A file path tapped in the terminal opens here (DetailPanel brings this tab forward).
  useEffect(() => {
    const handle = (request: ReturnType<typeof useUiStore.getState>['pendingFileOpen']) => {
      if (!request || (request.projectPath && request.projectPath !== projectPath)) return;
      useUiStore.getState().clearPendingFileOpen();
      const rel = relInProject(request.filePath, projectPath);
      setFullscreen(false);
      if (!rel) {
        setNotice(`${request.filePath} is outside this project.`);
        return;
      }
      setNotice(null);
      setStack([...dirStack(parentRel(rel)), { kind: 'file', path: rel }]);
    };
    // One that arrived before this tab mounted, then every later one.
    const first = setTimeout(() => handle(useUiStore.getState().pendingFileOpen), 0);
    const unsubscribe = useUiStore.subscribe((s, prev) => {
      if (s.pendingFileOpen !== prev.pendingFileOpen) handle(s.pendingFileOpen);
    });
    return () => {
      clearTimeout(first);
      unsubscribe();
    };
  }, [projectPath]);

  const [host] = useState(() => document.createElement('div'));
  const slotRef = useRef<HTMLDivElement | null>(null);
  const attachSlot = useCallback((slot: HTMLDivElement | null) => {
    slotRef.current = slot;
    if (slot && !host.isConnected) slot.appendChild(host);
  }, [host]);
  useLayoutEffect(() => {
    const full = isFullFor(fullscreen, top);
    placeHost(host, full ? styles.fullscreenHost : styles.inlineHost, full ? document.body : slotRef.current);
  }, [host, fullscreen, top]);
  useEffect(() => () => host.remove(), [host]);

  // Escape leaves full screen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const header = (
    <div className={styles.header}>
      {stack.length > 1 ? (
        <button type="button" className={styles.iconBtn} onClick={back} aria-label="Back">
          <BackIcon />
        </button>
      ) : (
        <span className={styles.headerPad} aria-hidden="true" />
      )}
      <Crumbs top={top} projectName={projectName} onGo={goToDir} />
      {top.kind !== 'search' && (
        <button type="button" className={styles.iconBtn} onClick={() => push({ kind: 'search' })} aria-label="Search the project">
          <SearchIcon />
        </button>
      )}
    </div>
  );

  let body;
  if (top.kind === 'dir') {
    body = (
      <FolderScreen
        key={top.path}
        projectPath={projectPath}
        path={top.path}
        onOpenDir={(path) => push({ kind: 'dir', path })}
        onOpenFile={(path) => openFile(path)}
        onGoRoot={() => goToDir('/')}
      />
    );
  } else if (top.kind === 'search') {
    body = (
      <SearchScreen
        projectPath={projectPath}
        state={search}
        setState={setSearch}
        onOpenDir={(path) => push({ kind: 'dir', path })}
        onOpenFile={openFile}
      />
    );
  } else {
    body = (
      <PhoneFileView
        key={`${top.path}:${top.line ?? ''}`}
        projectPath={projectPath}
        path={top.path}
        line={top.line}
        query={top.query}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((f) => !f)}
        onOpenFile={(path) => openFile(path)}
      />
    );
  }

  const isFull = fullscreen && top.kind === 'file';
  const screen = (
    <div
      className={styles.root}
      data-phone-project=""
      role={isFull ? 'dialog' : undefined}
      aria-modal={isFull ? true : undefined}
      aria-label={isFull ? baseName(top.path) : undefined}
    >
      {header}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div className={styles.body}>{body}</div>
    </div>
  );
  // One stable portal target, moved between the tab and <body>: going full screen
  // must not remount the file (a PDF would reload, Source / Wrap would reset).
  // The slot comes first so its ref places the host before the screen's own
  // layout effects measure anything.
  return (
    <>
      <div ref={attachSlot} className={styles.slot} />
      {createPortal(screen, host)}
    </>
  );
}

// ── Breadcrumb ───────────────────────────────────────────────────────────────

function Crumbs({ top, projectName, onGo }: { top: Screen; projectName: string; onGo: (dir: string) => void }) {
  const navRef = useRef<HTMLElement>(null);
  const last = top.kind === 'search' ? 'search' : top.path;
  // Keep the deepest crumb in view: a long path scrolls, its tail stays visible.
  useEffect(() => {
    const nav = navRef.current;
    if (nav) nav.scrollLeft = nav.scrollWidth;
  }, [last]);

  if (top.kind === 'search') {
    return (
      <h2 className={styles.screenTitle}>
        Search <span className={styles.screenTitleSub}>{projectName}</span>
      </h2>
    );
  }
  const trail = breadcrumbs(top.kind === 'dir' ? top.path : parentRel(top.path), projectName);
  const current = top.kind === 'file' ? baseName(top.path) : trail.pop()?.label ?? projectName;
  return (
    <nav ref={navRef} className={styles.crumbs} aria-label="Path">
      <ol className={styles.crumbList}>
        {trail.map((c) => (
          <li key={c.path} className={styles.crumbItem}>
            <button type="button" className={styles.crumb} onClick={() => onGo(c.path)}>
              {c.label}
            </button>
            <span className={styles.crumbSep} aria-hidden="true">/</span>
          </li>
        ))}
        <li className={styles.crumbItem}>
          <span className={styles.crumbCurrent} aria-current="page">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}

// ── A folder ─────────────────────────────────────────────────────────────────

function FolderScreen({
  projectPath,
  path,
  onOpenDir,
  onOpenFile,
  onGoRoot,
}: {
  projectPath: string;
  path: string;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onGoRoot: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ attempt: number; result: FilesResult<{ items: DirItem[] }> } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    listDir(projectPath, path, ac.signal).then(
      (result) => setLoaded({ attempt, result }),
      () => { /* aborted */ },
    );
    return () => ac.abort();
  }, [projectPath, path, attempt]);

  const result = loaded?.attempt === attempt ? loaded.result : null;
  if (!result) return <EmptyState busy title="Loading…" fill />;
  if (!result.ok) {
    const text = fileErrorText(result.status, 'folder');
    return (
      <EmptyState
        tone="error"
        fill
        title={text.title}
        hint={text.hint}
        action={
          <>
            <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            {path !== '/' && <Button onClick={onGoRoot}>Project folder</Button>}
          </>
        }
      />
    );
  }
  const items = result.data.items ?? [];
  if (items.length === 0) return <EmptyState fill title="This folder is empty" />;
  return (
    <ul className={styles.list} aria-label={`Files in ${path === '/' ? 'the project' : baseName(path)}`}>
      {items.map((item) => {
        const target = joinRel(path, item.name);
        const isDir = item.type === 'dir';
        return (
          <li key={item.name}>
            <button
              type="button"
              className={styles.row}
              onClick={() => (isDir ? onOpenDir(target) : onOpenFile(target))}
              aria-label={isDir ? `Folder ${item.name}` : item.name}
            >
              <span className={`${styles.rowIcon}${isDir ? ` ${styles.rowIconDir}` : ''}`} aria-hidden="true">
                <FileTypeIcon name={item.name} isDir={isDir} />
              </span>
              <span className={styles.rowText}>
                <span className={styles.rowName}>{item.name}</span>
                <span className={styles.rowMeta}>{isDir ? 'Folder' : formatSize(item.size)}</span>
              </span>
              {isDir && <ChevronIcon className={styles.rowChevron} />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Search ───────────────────────────────────────────────────────────────────

const NAME_DEBOUNCE_MS = 350;
const INDEX_RETRIES = 5;

function SearchScreen({
  projectPath,
  state,
  setState,
  onOpenDir,
  onOpenFile,
}: {
  projectPath: string;
  state: SearchState;
  setState: Dispatch<SetStateAction<SearchState>>;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string, line?: number, query?: string) => void;
}) {
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    // A search cut short by leaving the screen must not leave Search disabled on return.
    setState((s) => (s.busy ? { ...s, busy: false } : s));
  }, [setState]);

  const run = useCallback(async (query: string, mode: SearchMode) => {
    const q = query.trim();
    if (timer.current) clearTimeout(timer.current);
    if (!q || (mode === 'text' && q.length < 2)) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, busy: true, error: null }));
    for (let attempt = 0; ; attempt++) {
      const result = mode === 'names' ? await searchNames(projectPath, q) : await searchText(projectPath, q);
      if (id !== seq.current) return;
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, ran: { query: q, mode }, names: [], text: [], truncated: false, error: fileErrorText(result.status, 'folder').title }));
        return;
      }
      if (mode === 'text') {
        const data = result.data as { matches?: TextHit[]; truncated?: boolean };
        setState((s) => ({ ...s, busy: false, ran: { query: q, mode }, text: data.matches ?? [], names: [], truncated: !!data.truncated }));
        return;
      }
      const data = result.data as { results?: NameHit[]; indexing?: boolean };
      // A cold index answers empty while it builds: ask again shortly.
      if ((data.results ?? []).length === 0 && data.indexing && attempt < INDEX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (id !== seq.current) return;
        continue;
      }
      setState((s) => ({ ...s, busy: false, ran: { query: q, mode }, names: (data.results ?? []).slice(0, 100), text: [], truncated: false }));
      return;
    }
  }, [projectPath, setState]);

  const onQuery = (query: string) => {
    setState((s) => ({ ...s, query }));
    if (timer.current) clearTimeout(timer.current);
    // Names follow the typing; a text search waits for Search (it reads every file).
    if (state.mode === 'names' && query.trim()) {
      timer.current = setTimeout(() => void run(query, 'names'), NAME_DEBOUNCE_MS);
    }
  };

  const setMode = (mode: SearchMode) => {
    setState((s) => ({ ...s, mode }));
    if (state.query.trim()) void run(state.query, mode);
    inputRef.current?.focus();
  };

  const ran = state.ran;
  const grouped = groupByFile(state.text);

  return (
    <div className={styles.search}>
      <form
        className={styles.searchForm}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run(state.query, state.mode);
          inputRef.current?.blur();
        }}
      >
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="search"
          value={state.query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={state.mode === 'names' ? 'File or folder name' : 'Text in files'}
          aria-label={state.mode === 'names' ? 'Search file and folder names' : 'Search text in files'}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          // The user tapped Search: the keyboard is what they came for.
          autoFocus={!state.ran}
        />
        <Button type="submit" variant="primary" disabled={!state.query.trim() || state.busy}>
          Search
        </Button>
      </form>
      <div className={styles.segment} role="group" aria-label="Search in">
        <button type="button" className={styles.segmentBtn} aria-pressed={state.mode === 'names'} onClick={() => setMode('names')}>
          Names
        </button>
        <button type="button" className={styles.segmentBtn} aria-pressed={state.mode === 'text'} onClick={() => setMode('text')}>
          Text
        </button>
      </div>
      <div className={styles.searchResults} aria-live="polite" aria-busy={state.busy || undefined}>
        {state.error ? (
          <EmptyState tone="error" compact title={state.error} action={<Button onClick={() => void run(state.query, state.mode)}>Try again</Button>} />
        ) : !ran ? (
          <p className={styles.searchHint}>
            {state.mode === 'names' ? 'Type part of a file or folder name.' : 'Type at least two characters, then Search. A match opens the file at its line.'}
          </p>
        ) : ran.mode === 'names' ? (
          state.names.length === 0 ? (
            <EmptyState compact title={`No names match “${ran.query}”`} />
          ) : (
            <ul className={styles.list} aria-label="Matching names">
              {state.names.map((hit) => {
                const isDir = hit.type === 'dir';
                const path = normalizeRel(hit.path);
                return (
                  <li key={hit.path}>
                    <button type="button" className={styles.row} onClick={() => (isDir ? onOpenDir(path) : onOpenFile(path))}>
                      <span className={`${styles.rowIcon}${isDir ? ` ${styles.rowIconDir}` : ''}`} aria-hidden="true">
                        <FileTypeIcon name={hit.name} isDir={isDir} />
                      </span>
                      <span className={styles.rowText}>
                        <span className={styles.rowName}>{hit.name}</span>
                        <span className={styles.rowMeta}>{parentRel(path) === '/' ? 'Project folder' : parentRel(path).slice(1)}</span>
                      </span>
                      {isDir && <ChevronIcon className={styles.rowChevron} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : grouped.length === 0 ? (
          <EmptyState compact title={`No text matches “${ran.query}”`} />
        ) : (
          <>
            <p className={styles.searchHint}>
              {state.text.length} match{state.text.length === 1 ? '' : 'es'} in {grouped.length} file{grouped.length === 1 ? '' : 's'}
              {state.truncated ? ' (the first 500)' : ''}
            </p>
            <ul className={styles.hitGroups} aria-label="Matching lines">
              {grouped.map(([file, hits]) => (
                <li key={file} className={styles.hitGroup}>
                  <p className={styles.hitFile}>{file.replace(/^\//, '')}</p>
                  <ul className={styles.hitLines}>
                    {hits.map((hit) => (
                      <li key={`${hit.file}:${hit.line}`}>
                        <button
                          type="button"
                          className={styles.hitLine}
                          onClick={() => onOpenFile(normalizeRel(hit.file), hit.line, ran.query)}
                          aria-label={`${file.replace(/^\//, '')} line ${hit.line}: ${hit.text.trim()}`}
                        >
                          <span className={styles.hitNum}>{hit.line}</span>
                          <span className={styles.hitText}><Highlighted text={hit.text.trim()} query={ran.query} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function groupByFile(hits: readonly TextHit[]): Array<[string, TextHit[]]> {
  const groups = new Map<string, TextHit[]>();
  for (const hit of hits) groups.set(hit.file, [...(groups.get(hit.file) ?? []), hit]);
  return [...groups.entries()];
}
