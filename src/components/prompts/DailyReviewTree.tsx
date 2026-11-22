/**
 * DailyReviewTree — one day's prompts grouped project › room › session (Nov 20 2026).
 * Projects open, sessions folded: the day reads as a list of sessions first, and a session opens
 * to the prompts typed in it that day, oldest first. A room heading appears only where it says
 * something (not for a project whose sessions are all in no room).
 */
import { useCallback, useId, useMemo, useState } from 'react';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import IconButton from '@/components/ui/IconButton';
import SectionHeader from '@/components/ui/SectionHeader';
import UnfoldIcon from '@/components/ui/UnfoldIcon';
import { NO_ROOM } from '@/lib/dailyReview';
import type { DailyReview, DailyReviewProject, DailyReviewPrompt, DailyReviewSession } from '@/types/dailyReview';
import styles from '@/styles/modules/DailyReview.module.css';

/** Prompts longer than this fold to their start until "Show all". */
const CLAMP_CHARS = 280;

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function PromptItem({ prompt }: { prompt: DailyReviewPrompt }) {
  const [expanded, setExpanded] = useState(false);
  const total = prompt.fullLength ?? prompt.text.length;
  const long = total > CLAMP_CHARS;
  return (
    <li className={styles.prompt}>
      <time className={styles.promptTime}>{clock(prompt.timestamp)}</time>
      <div className={styles.promptBody}>
        <p className={styles.promptText}>{long && !expanded ? `${prompt.text.slice(0, CLAMP_CHARS)}…` : prompt.text}</p>
        {/* Right under the text it explains, before the button. */}
        {expanded && prompt.fullLength !== undefined && (
          <p className={styles.promptClipped}>Clipped here at {prompt.text.length.toLocaleString()} characters. List shows the whole prompt.</p>
        )}
        {long && (
          <Button variant="quiet" size="sm" className={styles.promptExpand}
            icon={<UnfoldIcon expanded={expanded} />} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : `Show all (${total.toLocaleString()} chars)`}
          </Button>
        )}
      </div>
    </li>
  );
}

const OpenGlyph = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="7 7 17 7 17 17" />
  </svg>
);

function SessionRow({
  session, open, live, onToggle, onOpen,
}: {
  session: DailyReviewSession;
  open: boolean;
  live: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const listId = useId();
  const span = session.firstAt === session.lastAt ? clock(session.firstAt) : `${clock(session.firstAt)}–${clock(session.lastAt)}`;
  return (
    <li className={styles.session}>
      <div className={styles.sessionLine}>
        <button type="button" className={styles.sessionToggle} aria-expanded={open} aria-controls={listId}
          onClick={() => onToggle(session.sessionId)}>
          <UnfoldIcon expanded={open} />
          <span className={styles.sessionTitle}>{session.title}</span>
          <span className={styles.sessionMeta}>{plural(session.promptCount, 'prompt')} · {span}</span>
        </button>
        {live && <Chip tone="success" title="On your dashboard">live</Chip>}
        {live && (
          <IconButton size="sm" label="Open this session" onClick={() => onOpen(session.sessionId)}>
            <OpenGlyph />
          </IconButton>
        )}
      </div>
      {open && (
        <ol id={listId} className={styles.prompts} aria-label={`Prompts in ${session.title}`}>
          {session.prompts.map((p) => <PromptItem key={p.id} prompt={p} />)}
        </ol>
      )}
    </li>
  );
}

function ProjectGroup({
  project, openSessions, liveIds, onToggleSession, onOpen,
}: {
  project: DailyReviewProject;
  openSessions: ReadonlySet<string>;
  liveIds: ReadonlySet<string>;
  onToggleSession: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  const roomHeads = !(project.rooms.length === 1 && project.rooms[0].name === NO_ROOM);
  return (
    // Named by the project alone: the header's counts would make every region's name differ by the day.
    <section className={styles.project} aria-label={project.name}>
      <SectionHeader
        level={3}
        label={project.name}
        aside={`${plural(project.promptCount, 'prompt')} · ${plural(project.sessionCount, 'session')}`}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        controls={bodyId}
      />
      {!collapsed && (
        <div id={bodyId}>
          {project.rooms.map((room) => (
            <div key={room.name} className={styles.room}>
              {roomHeads && (
                <h4 className={styles.roomName}>
                  {room.name}
                  <span className={styles.roomCount}>{plural(room.promptCount, 'prompt')}</span>
                </h4>
              )}
              <ul className={styles.sessions}>
                {room.sessions.map((s) => (
                  <SessionRow key={s.sessionId} session={s} open={openSessions.has(s.sessionId)}
                    live={liveIds.has(s.sessionId)} onToggle={onToggleSession} onOpen={onOpen} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function DailyReviewTree({
  review, liveIds, onOpen,
}: {
  review: DailyReview;
  liveIds: ReadonlySet<string>;
  onOpen: (sessionId: string) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const projects = useMemo(() => review.projects, [review]);
  return (
    <div className={styles.tree}>
      {projects.map((p) => (
        <ProjectGroup key={p.path ?? p.name} project={p} openSessions={open} liveIds={liveIds}
          onToggleSession={toggle} onOpen={onOpen} />
      ))}
    </div>
  );
}
