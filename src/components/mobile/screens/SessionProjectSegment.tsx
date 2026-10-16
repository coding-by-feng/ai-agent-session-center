/**
 * SessionProjectSegment — a session's Project tab on the phone (AASC-56): the
 * read-only project browser (tree with breadcrumbs, open and recent files,
 * name and text search, outline, find in the file, previews), loaded on first
 * use so none of it is in the frame's chunk. Read-only: the phone calls only
 * GET /api/files/*, inside a shared session's project.
 */
import { lazy, Suspense } from 'react';
import type { Session } from '@/types';
import { EmptyState } from '../kit';
import styles from '@/styles/modules/mobile/SessionInfo.module.css';

const PhoneProjectBrowser = lazy(() => import('../PhoneProjectBrowser'));

export default function SessionProjectSegment({ session }: { session: Session }) {
  const { sessionId, projectPath } = session;
  if (!projectPath) {
    return <EmptyState title="No project folder" message="This session didn’t say which folder it works in." />;
  }
  return (
    <div className={styles.fill}>
      <Suspense fallback={<EmptyState live title="Loading…" />}>
        {/* Keyed by folder: a re-keyed session (/clear) keeps its place, another folder starts fresh. */}
        <PhoneProjectBrowser key={projectPath} projectPath={projectPath} sessionId={sessionId} />
      </Suspense>
    </div>
  );
}
