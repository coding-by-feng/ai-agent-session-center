/**
 * ProjectBrowserView — standalone full-page project file browser.
 * Opens via /project-browser?path=<projectPath> (e.g. from the "open in new tab" button).
 */
import { useSearchParams } from 'react-router';
import ProjectTab from '@/components/session/ProjectTab';
import styles from '@/styles/modules/ProjectTab.module.css';

export default function ProjectBrowserView() {
  const [params] = useSearchParams();
  const projectPath = params.get('path');

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

  return (
    <div className={styles.standalone}>
      <div className={styles.standaloneHeader}>
        <span className={styles.standaloneTitle}>{projectName}</span>
        <span className={styles.standalonePath}>{projectPath}</span>
      </div>
      <div className={styles.standaloneContent}>
        <ProjectTab projectPath={projectPath} />
      </div>
    </div>
  );
}
