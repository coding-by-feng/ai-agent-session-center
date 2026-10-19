/**
 * PhoneProjectBrowser — a session's files on a phone: the session's Project tab
 * (AASC-56; before it, Info → Files, AASC-20). A read-only drill-down, folder →
 * folder → file, one screen at a time, with a breadcrumb and Back, instead of the
 * desktop's split tree and editor.
 *
 * - Read-only by construction. A paired phone may only read inside a shared
 *   session's project (server/mobile/phoneProfile.ts); there is no edit, new,
 *   rename, delete, reveal or "open on the Mac" here at all.
 * - A refused path answers a plain 404 (it must not be told from a missing
 *   one): every screen says so in words and offers a way out.
 * - Search finds names, or text; a text match opens the file at its line. Back
 *   returns to the results.
 * - Open and recent files (AASC-56): every file opened joins the open files (the
 *   desktop's tabs) and the recent ones, one tap away from the header. The tab
 *   remembers, per project, the folder and the file you were reading, so leaving
 *   it (for Chat, the terminal) and coming back lands on the same file; where in
 *   the file is the viewer's reading position.
 * - A file can go full screen (portaled over the app, Escape or the button to
 *   leave). Viewers are lazy, in PhoneFileView's own chunks.
 *
 * Mounted lazily by the session's Project tab: none of this is in the entry chunk.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '@/stores/uiStore';
import { baseName, parentRel, relInProject } from '@/lib/phoneProject';
import {
  closedAllFiles,
  closedFile,
  loadProjectFiles,
  openedFile,
  recentNotOpen,
  saveProjectFiles,
  type ProjectFilesState,
} from '@/lib/phoneProjectFiles';
import PhoneFileView from './PhoneFileView';
import ProjectCrumbs from './project/ProjectCrumbs';
import ProjectFolder from './project/ProjectFolder';
import ProjectSearch from './project/ProjectSearch';
import { EMPTY_SEARCH, type SearchState } from './project/searchState';
import OpenFilesSheet from './project/OpenFilesSheet';
import { dirStack, fileStack, folderOf, type ProjectScreen } from './project/projectScreens';
import { BackIcon, FilesIcon, SearchIcon } from './projectIcons';
import { SparkIcon } from './phoneIcons';
import { captureSelectionIn } from '@/hooks/useSelectionIn';
import { usePhoneAiScopeOn, usePhoneAiStore } from '@/stores/phoneAiStore';
import { phoneFileAiScope } from '@/lib/phoneAiScopes';
import { openBackLayer } from '@/lib/backLayers';
import { useScreenSlot } from './kit/screenSlot';
import styles from '@/styles/modules/PhoneProject.module.css';

/** Dress the portal host for where it goes, and move it there (a DOM node React doesn't own). */
function placeHost(host: HTMLElement, className: string, target: HTMLElement | null): void {
  host.className = className;
  if (target && host.parentElement !== target) target.appendChild(host);
}

function initialStack(files: ProjectFilesState): ProjectScreen[] {
  return files.current ? fileStack(files.current) : dirStack(files.dir);
}

export interface PhoneProjectBrowserProps {
  projectPath: string;
  sessionId: string;
}

export default function PhoneProjectBrowser({ projectPath, sessionId }: PhoneProjectBrowserProps) {
  const projectName = baseName(projectPath) || 'project';
  const [files, setFiles] = useState<ProjectFilesState>(() => loadProjectFiles(projectPath));
  const [stack, setStack] = useState<ProjectScreen[]>(() => initialStack(files));
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const [filesOpen, setFilesOpen] = useState(false);
  const top = stack[stack.length - 1];
  const folder = folderOf(stack);
  const reading = top.kind === 'file' ? top.path : null;
  // Ask AI about the open file (AASC-57): its view hosts the sheet and registers the scope.
  const aiScope = phoneFileAiScope(sessionId);
  const aiOn = usePhoneAiScopeOn(aiScope) && reading !== null;

  // The folder and the file on screen are where the tab comes back to.
  useEffect(() => {
    saveProjectFiles(projectPath, { ...files, dir: folder, current: reading });
  }, [projectPath, files, folder, reading]);

  const push = useCallback((screen: ProjectScreen) => {
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
  // The phone's Back walks the tab's own steps (file → folder → …) before the frame pops the screen, as the
  // ‹ above does (e2e run 5, F5). One layer per step: a press releases it, the shorter stack registers the
  // next. Only while this screen is on show: a screen pushed over the session takes the Back itself.
  const { isTop } = useScreenSlot();
  const depth = stack.length;
  useEffect(() => (isTop && depth > 1 ? openBackLayer(back) : undefined), [isTop, depth, back]);
  const goToDir = useCallback((dir: string) => {
    setNotice(null);
    setFullscreen(false);
    setStack(dirStack(dir));
  }, []);
  const openFile = useCallback((path: string, line?: number, query?: string) => {
    setFiles((f) => openedFile(f, path));
    push({ kind: 'file', path, ...(line ? { line } : {}), ...(query ? { query } : {}) });
  }, [push]);
  /** From the open / recent list: the file over its own folders, as a link would. */
  const showFile = useCallback((path: string) => {
    setNotice(null);
    setFiles((f) => openedFile(f, path));
    setStack(fileStack(path));
  }, []);
  const closeFile = useCallback((path: string) => {
    setFiles((f) => closedFile(f, path));
    if (reading === path) goToDir(parentRel(path));
  }, [reading, goToDir]);
  const closeAll = useCallback(() => {
    setFiles((f) => closedAllFiles(f));
    if (reading) goToDir(parentRel(reading));
  }, [reading, goToDir]);
  const closeFilesSheet = useCallback(() => setFilesOpen(false), []);

  // A file path tapped in a terminal opens here.
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
      setFiles((f) => openedFile(f, rel));
      setStack(fileStack(rel));
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
  const isFull = fullscreen && top.kind === 'file';
  useLayoutEffect(() => {
    placeHost(host, isFull ? styles.fullscreenHost : styles.inlineHost, isFull ? document.body : slotRef.current);
  }, [host, isFull]);
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

  const openCount = files.open.length;
  const header = (
    <div className={styles.header}>
      {stack.length > 1 ? (
        <button type="button" className={styles.iconBtn} onClick={back} aria-label="Back">
          <BackIcon />
        </button>
      ) : (
        <span className={styles.headerPad} aria-hidden="true" />
      )}
      <ProjectCrumbs top={top} projectName={projectName} onGo={goToDir} />
      {aiOn && (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => usePhoneAiStore.getState().ask(aiScope, captureSelectionIn(aiScope))}
          aria-label="Ask AI about this file"
          aria-haspopup="dialog"
        >
          <SparkIcon />
        </button>
      )}
      <button
        type="button"
        className={`${styles.iconBtn} ${styles.badgeHost}`}
        onClick={() => setFilesOpen(true)}
        aria-label={openCount > 0 ? `Open and recent files, ${openCount} open` : 'Open and recent files'}
        aria-haspopup="dialog"
      >
        <FilesIcon />
        {openCount > 0 && <span className={styles.countBadge} aria-hidden="true">{openCount}</span>}
      </button>
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
      <ProjectFolder
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
      <ProjectSearch
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
        aiSessionId={sessionId}
      />
    );
  }

  const screen = (
    <div
      className={styles.root}
      data-phone-project=""
      role={isFull ? 'dialog' : undefined}
      aria-modal={isFull ? true : undefined}
      aria-label={isFull && top.kind === 'file' ? baseName(top.path) : undefined}
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
      <OpenFilesSheet
        open={filesOpen}
        onClose={closeFilesSheet}
        openFiles={files.open}
        recentFiles={recentNotOpen(files)}
        current={reading}
        onOpenFile={showFile}
        onCloseFile={closeFile}
        onCloseAll={closeAll}
      />
    </>
  );
}
