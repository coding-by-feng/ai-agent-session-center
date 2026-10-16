/**
 * PhoneFileView — one file, read-only, filling the phone's PROJECT tab (or the
 * whole screen) (AASC-20, features 47–50).
 *
 *   Markdown   rendered, with an OUTLINE sheet; or its source
 *   TeX        rendered (latex.js); or its source
 *   PDF        PDF.js with the phone toolbar (page, zoom, find)
 *   Image      pinch to zoom, drag to pan
 *   Text/code  numbered lines, coloured where highlight.js knows the language
 *              (AASC-56); a search match opens at its line, marked
 *
 * Find in the file (AASC-56) works on the source lines and on a rendered
 * Markdown page (the page's own text, lit with the CSS Highlight API).
 *
 * Heavy viewers are lazy: none of them is in this chunk. A path the Mac
 * refuses to a phone answers 404, which reads as "not available on this phone".
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import { useFileReadingPosition } from '@/hooks/useFileReadingPosition';
import { extractHeadings } from '@/lib/markdownHeadings';
import { pdfReadingKey, readingKey } from '@/lib/fileReadingPosition';
import { scrollIntoContainer } from '@/lib/scrollWithinContainer';
import { findLineMatches } from '@/lib/codeLines';
import { readFile, streamUrl, type FileData, type FilesResult } from '@/lib/phoneFiles';
import {
  fileErrorText,
  formatSize,
  hasSourceToggle,
  viewerKindFor,
  type PhoneViewerKind,
} from '@/lib/phoneProject';
import PhoneImageViewer from './PhoneImageViewer';
import SourceLines from './project/SourceLines';
import FindBar from './project/FindBar';
import { useDomFind } from './project/useDomFind';
import { CollapseIcon, ExpandIcon, FindInFileIcon, OutlineIcon } from './projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

const PhoneMarkdown = lazy(() => import('./PhoneMarkdown'));
const TexViewer = lazy(() => import('@/components/session/TexViewer'));
const PdfViewer = lazy(() => import('@/components/session/PdfViewer'));

export interface PhoneFileViewProps {
  projectPath: string;
  path: string;
  /** 1-based line to open at (a text-search match): opens the source, marked. */
  line?: number;
  /** The searched text, marked on the target line. */
  query?: string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenFile: (path: string) => void;
}

const KIND_LABEL: Record<PhoneViewerKind, string> = {
  markdown: 'Markdown',
  tex: 'LaTeX',
  pdf: 'PDF',
  image: 'Image',
  media: 'Media',
  text: 'Text',
  none: 'File',
};

const fallback = <EmptyState busy title="Loading viewer…" fill />;

export default function PhoneFileView({
  projectPath,
  path,
  line,
  query,
  fullscreen,
  onToggleFullscreen,
  onOpenFile,
}: PhoneFileViewProps) {
  const [attempt, setAttempt] = useState(0);
  const key = `${projectPath}\n${path}\n${attempt}`;
  const [loaded, setLoaded] = useState<{ key: string; result: FilesResult<FileData> } | null>(null);
  const [source, setSource] = useState(line !== undefined);
  const [wrap, setWrap] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [domCount, setDomCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    readFile(projectPath, path, ac.signal).then(
      (result) => setLoaded({ key, result }),
      () => { /* aborted */ },
    );
    return () => ac.abort();
  }, [projectPath, path, key]);

  const result = loaded?.key === key ? loaded.result : null;
  const data = result?.ok ? result.data : null;
  const kind = data ? viewerKindFor(data) : null;
  const showSource = !!kind && (kind === 'text' || (hasSourceToggle(kind) && source));
  const headings = useMemo(
    () => (kind === 'markdown' && data?.content ? extractHeadings(data.content) : []),
    [kind, data],
  );
  // Where this file was left, per face (a rendered page and its source scroll differently).
  // Opening at a search match goes to the match instead.
  const positionKey =
    data && line === undefined && (kind === 'markdown' || kind === 'text')
      ? readingKey(projectPath, `phone:${showSource ? 'source' : 'rendered'}:${path}`)
      : undefined;
  useFileReadingPosition(scrollRef, positionKey, !!data);

  // Find: over the lines in the source view, over the page's text on a rendered Markdown page.
  const findable = showSource || kind === 'markdown';
  const findActive = findOpen && findable;
  const lineMatches = useMemo(
    () => (findActive && showSource ? findLineMatches((data?.content ?? '').split('\n'), findQuery) : []),
    [findActive, showSource, data, findQuery],
  );
  useDomFind(scrollRef, findQuery, findIndex, findActive && !showSource, setDomCount);
  const findCount = showSource ? lineMatches.length : domCount;
  const findAt = findCount > 0 ? ((findIndex % findCount) + findCount) % findCount : 0;
  const onFindQuery = useCallback((q: string) => {
    setFindQuery(q);
    setFindIndex(0);
  }, []);
  const stepFind = useCallback((direction: 1 | -1) => setFindIndex((i) => i + direction), []);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
  }, []);

  if (!result) return <EmptyState busy title="Opening…" fill />;
  if (!result.ok || streamFailed) {
    const text = fileErrorText(result.ok ? 404 : result.status, 'file');
    return (
      <EmptyState
        tone="error"
        fill
        title={text.title}
        hint={text.hint}
        action={<Button onClick={() => { setStreamFailed(false); setAttempt((n) => n + 1); }}>Try again</Button>}
      />
    );
  }

  const file = result.data;
  const toolbar = (
    <div className={styles.fileBar} role="toolbar" aria-label="File view">
      <span className={styles.fileMeta}>
        {KIND_LABEL[kind ?? 'none']}
        {/* Room for the size only where there is no Rendered / Source switch. */}
        {file.size && !(kind && hasSourceToggle(kind)) ? ` · ${formatSize(file.size)}` : ''}
      </span>
      {findable && (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
          aria-label="Find in file"
          aria-pressed={findOpen}
        >
          <FindInFileIcon />
        </button>
      )}
      {kind === 'markdown' && !showSource && headings.length > 0 && (
        <button type="button" className={styles.iconBtn} onClick={() => setOutlineOpen(true)} aria-label="Outline" aria-haspopup="dialog">
          <OutlineIcon />
        </button>
      )}
      {kind && hasSourceToggle(kind) && (
        <div className={styles.segment} role="group" aria-label="Show as">
          <button type="button" className={styles.segmentBtn} aria-pressed={!source} onClick={() => setSource(false)}>
            Rendered
          </button>
          <button type="button" className={styles.segmentBtn} aria-pressed={source} onClick={() => setSource(true)}>
            Source
          </button>
        </div>
      )}
      {showSource && (
        <button type="button" className={styles.textBtn} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
          Wrap
        </button>
      )}
      <button
        type="button"
        className={styles.iconBtn}
        onClick={onToggleFullscreen}
        aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
        aria-pressed={fullscreen}
      >
        {fullscreen ? <CollapseIcon /> : <ExpandIcon />}
      </button>
    </div>
  );

  let body: ReactNode;
  if (showSource) {
    body = (
      <SourceLines
        scrollRef={scrollRef}
        content={file.content ?? ''}
        fileName={file.name || path}
        wrap={wrap}
        line={line ?? null}
        query={query ?? ''}
        find={findActive ? { matches: lineMatches, index: lineMatches.length > 0 ? findAt : -1 } : null}
      />
    );
  } else if (kind === 'markdown') {
    body = (
      <div ref={scrollRef} className={styles.scroll} data-phone-scroll="">
        <Suspense fallback={fallback}>
          <PhoneMarkdown content={file.content ?? ''} projectPath={projectPath} filePath={path} onOpenFile={onOpenFile} />
        </Suspense>
      </div>
    );
  } else if (kind === 'tex') {
    body = (
      <Suspense fallback={fallback}>
        <TexViewer compact source={file.content ?? ''} fileKey={path} positionKey={readingKey(projectPath, `phone:rendered:${path}`)} />
      </Suspense>
    );
  } else if (kind === 'pdf') {
    body = (
      <Suspense fallback={fallback}>
        <PdfViewer compact src={streamUrl(projectPath, path)} name={file.name} positionKey={pdfReadingKey(projectPath, `phone:${path}`)} />
      </Suspense>
    );
  } else if (kind === 'image') {
    body = <PhoneImageViewer src={streamUrl(projectPath, path)} alt={file.name} onError={() => setStreamFailed(true)} />;
  } else if (kind === 'media') {
    const audio = /\.(mp3|wav|flac|aac|m4a)$/i.test(file.name);
    body = (
      <div className={styles.media}>
        {audio
          ? <audio controls preload="metadata" src={streamUrl(projectPath, path)} onError={() => setStreamFailed(true)} />
          : <video controls playsInline preload="metadata" src={streamUrl(projectPath, path)} onError={() => setStreamFailed(true)} />}
      </div>
    );
  } else {
    body = (
      <EmptyState
        fill
        title="No preview on a phone"
        hint={`${file.name}${file.size ? ` (${formatSize(file.size)})` : ''} can be opened on the Mac.`}
      />
    );
  }

  return (
    <div className={styles.fileView}>
      {toolbar}
      {findActive && (
        <FindBar query={findQuery} onQuery={onFindQuery} count={findCount} index={findAt} onStep={stepFind} onClose={closeFind} />
      )}
      <div className={styles.fileBody}>{body}</div>
      <BottomSheet open={outlineOpen} onClose={() => setOutlineOpen(false)} title="Outline">
        <ul className={styles.outline}>
          {headings.map((h, i) => (
            <li key={`${i}-${h.slug}`}>
              <button
                type="button"
                className={styles.outlineItem}
                data-level={Math.min(h.level, 4)}
                onClick={() => {
                  setOutlineOpen(false);
                  const scroller = scrollRef.current;
                  scrollIntoContainer(scroller, scroller?.querySelector(`[id="${h.slug}"]`), { block: 'start', padding: 8 });
                }}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      </BottomSheet>
    </div>
  );
}
