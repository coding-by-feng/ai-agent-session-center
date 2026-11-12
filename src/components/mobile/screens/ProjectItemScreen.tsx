/**
 * ProjectItemScreen — Resources → Projects → a project (Nov 2 2026): everything the Mac read about
 * one saved project, unclipped. The list row cuts the repository and folder to one line each; here
 * they wrap.
 *
 *   ‹  agent-manager
 *   STATUS        [2 commits to push]
 *                 (the desktop's hint, when the state has one)
 *   REPOSITORY    github.com/kason/agent-manager · Branch main
 *   ON YOUR MAC   Folder ~/Documents/claude/agent-manager · Branch here main
 *                 To push 2 commits · To pull Nothing · GitHub account kason
 *
 * It reads the same answer as the Projects tab (the Mac keeps it), so opening one costs no new
 * check. Read-only, like the tab.
 */
import type { ReactNode } from 'react';
import { Button, EmptyState, ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useClock } from '@/lib/chat/clock';
import { fetchPhoneProjects } from '@/lib/chat/phoneResourcesApi';
import { checkoutFacts, projectStateWords } from '@/lib/chat/phoneResourcesModel';
import { CLOUD_CONNECT_HINT, CLOUD_RECONNECT_HINT, agoWords } from '@/lib/chat/cloudBrowseModel';
import type { PhoneProject, PhoneProjects } from '@/types/phoneResources';
import { PROJECTS_READ_ONLY_NOTE } from './resources/ProjectsPanel';
import { useCloudRead } from './useCloudRead';
import styles from '@/styles/modules/mobile/Resources.module.css';
import cloudStyles from '@/styles/modules/mobile/Cloud.module.css';

const readProjects = ({ refresh, signal }: { refresh: boolean; signal: AbortSignal }) => fetchPhoneProjects({ refresh, signal });

function ProjectBody({ project }: { project: PhoneProject }) {
  const state = projectStateWords(project);
  const local = project.local;
  const facts = checkoutFacts(project);
  return (
    <>
      <ListSection header="Status">
        <ListRow
          title={<span className={styles.tag} data-tone={state.tone}>{state.label}</span>}
          subtitle={state.hint}
          tall={!!state.hint}
          testId="project-state"
        />
      </ListSection>
      <ListSection header="Repository">
        <ListRow title="GitHub" subtitle={<span className={styles.fieldValue}>github.com/{project.owner}/{project.repo}</span>} tall />
        <ListRow title="Branch" value={project.branch} />
      </ListSection>
      <ListSection header="On your Mac">
        {local?.path ? (
          <>
            <ListRow title="Folder" subtitle={<span className={styles.fieldValue}>{local.path}</span>} tall testId="project-folder" />
            {facts.map((f) => <ListRow key={f.title} title={f.title} value={f.value} />)}
          </>
        ) : (
          <ListRow
            title={local ? 'Not on this Mac' : 'Couldn’t check'}
            subtitle={local ? 'Clone it on your Mac: RESOURCES → Projects.' : 'Your Mac couldn’t read this checkout just now.'}
            tall
            testId="project-folder"
          />
        )}
      </ListSection>
    </>
  );
}

export default function ProjectItemScreen({ id }: { id: string }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const now = useClock();
  const answer = useCloudRead<PhoneProjects>(readProjects);
  const data = answer.data;
  const project = data?.projects.find((p) => p.id === id) ?? null;
  const tryAgain = <Button variant="primary" onClick={() => void answer.refresh()}>Try again</Button>;

  let body: ReactNode;
  if (!answer.loaded) {
    body = <EmptyState live title="Loading project…" message="Your Mac is reading it, and checking its folder." />;
  } else if (!data) {
    body = <EmptyState title="Couldn’t load this project" message={answer.error?.message} action={tryAgain} />;
  } else if (!data.connected) {
    body = (
      <EmptyState
        title={data.state === 'revoked' ? 'This Mac’s cloud device was revoked' : 'This Mac isn’t connected to AASC Cloud'}
        message={data.state === 'revoked' ? CLOUD_RECONNECT_HINT : CLOUD_CONNECT_HINT}
      />
    );
  } else if (!project) {
    body = data.problem
      ? <EmptyState title="Couldn’t read this project" message={data.problem} action={tryAgain} />
      : <EmptyState title="This project isn’t saved to cloud any more" message="It may have been removed since the list was read." />;
  } else {
    body = (
      <>
        <ProjectBody project={project} />
        <p className={styles.note}>
          {data.readAt ? `Read ${agoWords(data.readAt, now)}. ` : ''}{PROJECTS_READ_ONLY_NOTE}
        </p>
      </>
    );
  }

  return (
    <Screen title={project?.name ?? 'Project'} onBack={pop} backLabel="Back to Projects" testId="phone-project-item">
      <div className={cloudStyles.pullHost}>{body}</div>
    </Screen>
  );
}
