/**
 * ProjectsPanel — Resources → Projects (plan 16): the projects saved to AASC Cloud and their
 * checkout on the Mac, in the desktop's words (projectState.ts).
 *
 *   GITHUB ACCOUNTS ON YOUR MAC
 *   kason (active), coding-by-feng
 *   SAVED PROJECTS · 2
 *   agent-manager
 *   [2 commits to push]
 *   github.com/kason/agent-manager · main
 *   ~/Documents/claude/agent-manager
 *   (the desktop's hint, when the state has one)
 *
 * P1 reads only: Clone, Pull, Push and Check run on the Mac for now.
 */
import { useEffect } from 'react';
import { Banner, Button, EmptyState, ListRow, ListSection } from '../../kit';
import { useClock } from '@/lib/chat/clock';
import { fetchPhoneProjects } from '@/lib/chat/phoneResourcesApi';
import { accountsWords, projectStateWords, repoWords } from '@/lib/chat/phoneResourcesModel';
import { CLOUD_CONNECT_HINT, CLOUD_RECONNECT_HINT, agoWords } from '@/lib/chat/cloudBrowseModel';
import type { PhoneProjects } from '@/types/phoneResources';
import type { RegisterRefresh } from '../ResourcesScreen';
import { useCloudRead } from '../useCloudRead';
import styles from '@/styles/modules/mobile/Resources.module.css';

const readProjects = ({ refresh, signal }: { refresh: boolean; signal: AbortSignal }) => fetchPhoneProjects({ refresh, signal });

export const PROJECTS_READ_ONLY_NOTE = 'Clone, Pull, Push and Check run on your Mac: RESOURCES → Projects.';

export default function ProjectsPanel({ register }: { register: RegisterRefresh }) {
  const now = useClock();
  const read = useCloudRead<PhoneProjects>(readProjects);
  const { refresh } = read;
  useEffect(() => {
    register(refresh);
    return () => register(null);
  }, [register, refresh]);

  const data = read.data;
  if (!read.loaded) return <EmptyState live title="Loading projects…" message="Your Mac is reading them, and checking each folder." />;
  if (!data) {
    return (
      <EmptyState
        title="Couldn’t load projects"
        message={read.error?.message}
        action={<Button variant="primary" onClick={() => void refresh()}>Try again</Button>}
      />
    );
  }
  if (!data.connected) {
    return (
      <EmptyState
        title={data.state === 'revoked' ? 'This Mac’s cloud device was revoked' : 'This Mac isn’t connected to AASC Cloud'}
        message={data.state === 'revoked' ? CLOUD_RECONNECT_HINT : CLOUD_CONNECT_HINT}
      />
    );
  }

  const banner = read.error
    ? <Banner tone="error" title="Couldn’t refresh">{read.error.message}</Banner>
    : data.problem ? <Banner tone="warning" title="Couldn’t read projects just now">{data.problem}</Banner> : null;
  return (
    <>
      {banner && <div className={styles.note}>{banner}</div>}
      <ListSection header="GitHub accounts on your Mac">
        <ListRow title={accountsWords(data.accounts)} testId="github-accounts" />
      </ListSection>
      {data.projects.length === 0 ? (
        <EmptyState title="No projects saved to cloud yet" message="Save a project from your Mac: RESOURCES → Projects." />
      ) : (
        <ListSection
          header={`Saved projects · ${data.projects.length}`}
          footer={data.truncated ? `Showing the first ${data.projects.length}. Your Mac lists them all: RESOURCES → Projects.` : undefined}
        >
          {data.projects.map((p) => {
            const state = projectStateWords(p);
            return (
              <ListRow
                key={p.id}
                tall
                title={p.name}
                subtitle={
                  <>
                    <span className={styles.line}><span className={styles.tag} data-tone={state.tone}>{state.label}</span></span>
                    <span className={styles.line}>{repoWords(p)}</span>
                    {p.local?.path && <span className={styles.line}>{p.local.path}</span>}
                    {state.hint && <span className={styles.hint}>{state.hint}</span>}
                  </>
                }
                testId="project-row"
              />
            );
          })}
        </ListSection>
      )}
      <p className={styles.note}>
        {data.readAt ? `Read ${agoWords(data.readAt, now)}. ` : ''}{PROJECTS_READ_ONLY_NOTE}
      </p>
    </>
  );
}
