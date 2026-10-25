/**
 * ProjectBrowserView — standalone full-page project file browser.
 * Opens via /project-browser?path=<projectPath> (e.g. from the "open in new tab" button).
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import ProjectTab from '@/components/session/ProjectTab';
import { useSessionStore } from '@/stores/sessionStore';
import { onOpenFile } from '@/lib/projectPopoutFile';
import styles from '@/styles/modules/ProjectTab.module.css';

export default function ProjectBrowserView() {
  const [params] = useSearchParams();
  const projectPath = params.get('path');
  // Pick an active session in this project so the translate/explain popup
  // has an origin to fork from. Prefer non-ended sessions; fall back to any.
  const originSessionId = useSessionStore((s) => {
    if (!projectPath) return undefined;
    const norm = projectPath.replace(/\/$/, '');
    let live: string | undefined;
    let any: string | undefined;
    for (const [id, sess] of s.sessions) {
      if ((sess.projectPath ?? '').replace(/\/$/, '') !== norm) continue;
      if (!any) any = id;
      if (sess.status !== 'ended' && !live) live = id;
    }
    return live ?? any;
  });

  // An already-open window gets "show this file" from the docked tab's Detach
  // button. ProjectTab reacts to a change of navigateToFile, so it resets
  // after a tick to let the same file be sent again.
  const [navigateToFile, setNavigateToFile] = useState<string | null>(null);
  useEffect(() => {
    if (!projectPath) return;
    let resetId: ReturnType<typeof setTimeout> | undefined;
    const off = onOpenFile(projectPath, (file) => {
      setNavigateToFile(file);
      clearTimeout(resetId);
      resetId = setTimeout(() => setNavigateToFile(null), 100);
    });
    return () => { off(); clearTimeout(resetId); };
  }, [projectPath]);

  if (!projectPath) {
    return (
      <div className={styles.standalone}>
        <div className={styles.standaloneEmpty}>
          No project path specified. Use <code>?path=/your/project</code> to open a project.
        </div>
      </div>
    );
  }

  const projectName = projectPath.split('/').filter(Boolean).pop() || projectPath;

  const initialFile = params.get('file') || undefined;

  return (
    <div className={styles.standalone}>
      <div className={styles.standaloneHeader}>
        <span className={styles.standaloneTitle}>{projectName}</span>
        <span className={styles.standalonePath}>{projectPath}</span>
      </div>
      <div className={styles.standaloneContent}>
        <ProjectTab
          projectPath={projectPath}
          initialPath={initialFile}
          initialIsFile={!!initialFile}
          preferInitialFile
          navigateToFile={navigateToFile}
          persistId={`browser-${projectPath}`}
          originSessionId={originSessionId}
        />
      </div>
    </div>
  );
}
