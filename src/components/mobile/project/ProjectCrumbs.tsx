/**
 * ProjectCrumbs — the Project tab's path (AASC-20): the project's name first,
 * each folder a 44px button that jumps up, the deepest crumb kept in view. On a
 * search it is the screen's title instead.
 */
import { useRef } from 'react';
import { useKeepEndInView } from '@/hooks/useKeepEndInView';
import { baseName, breadcrumbs, parentRel } from '@/lib/phoneProject';
import type { ProjectScreen } from './projectScreens';
import styles from '@/styles/modules/PhoneProject.module.css';

export default function ProjectCrumbs({ top, projectName, onGo }: { top: ProjectScreen; projectName: string; onGo: (dir: string) => void }) {
  const navRef = useRef<HTMLElement>(null);
  const last = top.kind === 'search' ? 'search' : top.path;
  // Keep the deepest crumb in view: a long path scrolls, its tail stays visible.
  useKeepEndInView(navRef, last);

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
