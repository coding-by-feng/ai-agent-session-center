/**
 * ResourceItemScreen — one Library resource on the phone (plan 16), as the desktop's detail
 * pane shows it:
 *
 *   ‹  rar
 *   DETAILS     Kind Skill · For Claude · Where Global · Size · Changed · Path
 *   NOTES       ♥ Favourite · Abbreviation r · Tags #retouch          (when it has notes)
 *   USES        Used 181× in the last 90 days                          (skills, commands)
 *               120 typed by you · 61 by the agent · last used 4m ago
 *   ALSO IN     Codex · Global                              12 uses ›
 *   PREVIEW     the text, or the masked fields of a config
 *   FILES       SKILL.md · references/x.md …                           (a tap previews it)
 *
 * Read-only in P1: notes and Uninstall come in P2 and P3.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, EmptyState, ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useClock } from '@/lib/chat/clock';
import { fetchPhoneLibrary, fetchPhoneResource, fetchPhoneResourceFile } from '@/lib/chat/phoneResourcesApi';
import { resourceItemPath } from '@/lib/chat/phoneRoutes';
import {
  noCountWords, resourceFacts, rowUses, usageScopeNote, whereWords, type PhoneProjectRef,
} from '@/lib/chat/phoneResourcesModel';
import { AGENT_LABELS, formatBytes, formatFieldValue } from '@/lib/resourceFilters';
import { isUsageCounted, usageFacts } from '@/lib/resourceUsage';
import { noteForResource } from '@/lib/skillNotes';
import type { PhoneLibrary, PhoneResourceDetail, PhoneResourceFile } from '@/types/phoneResources';
import type { ResourceSummary } from '@/types/resources';
import { useCloudRead } from './useCloudRead';
import { usePhoneSkillNotes } from './resources/usePhoneSkillNotes';
import styles from '@/styles/modules/mobile/Resources.module.css';

const ChatMarkdown = lazy(() => import('../chat/items/ChatMarkdown'));

const readLibrary = ({ signal }: { refresh: boolean; signal: AbortSignal }) => fetchPhoneLibrary(signal);

function UsesSection({ summary, library, now }: { summary: ResourceSummary; library: PhoneLibrary | null; now: number }) {
  if (!isUsageCounted(summary.type)) {
    const words = noCountWords(summary.type);
    return words ? <p className={styles.note}>{words}</p> : null;
  }
  if (!library?.usage) return null;
  const facts = usageFacts(summary, library.usage.byId[summary.id], library.usage.windowDays, now);
  const scope = usageScopeNote(library.usage.scope);
  return (
    <ListSection header="Uses" footer={[facts.note, scope].filter(Boolean).join(' · ') || undefined}>
      <ListRow title={facts.headline} subtitle={facts.parts.length > 0 ? facts.parts.join(' · ') : undefined} tall={facts.parts.length > 0} testId="resource-uses" />
    </ListSection>
  );
}

function VariantsSection({ summary, library }: { summary: ResourceSummary; library: PhoneLibrary | null }) {
  const push = usePhoneNavStore((s) => s.push);
  const projects = useMemo(() => new Map<string, PhoneProjectRef>((library?.projects ?? []).map((p) => [p.id, p])), [library]);
  const variants = (library?.resources ?? []).filter((r) => summary.variantIds.includes(r.id));
  if (variants.length === 0) return null;
  return (
    <ListSection header="Also in">
      {variants.map((v) => (
        <ListRow
          key={v.id}
          title={`${AGENT_LABELS[v.agent]} · ${whereWords(v, projects)}`}
          value={rowUses(v, library?.usage ?? null)?.text}
          chevron
          onClick={() => push(resourceItemPath(v.id))}
        />
      ))}
    </ListSection>
  );
}

/** The resource's own text (or masked fields), or one of its files once tapped. */
function Preview({ detail, file, onBack }: { detail: PhoneResourceDetail; file: PhoneResourceFile | null; onBack: () => void }) {
  if (detail.fields && !file) {
    return (
      <ListSection header="Fields" footer="Secret values are hidden by your Mac.">
        {detail.fields.map((f) => (
          <ListRow key={f.key} title={f.key} subtitle={<span className={styles.fieldValue}>{formatFieldValue(f)}</span>} tall />
        ))}
      </ListSection>
    );
  }
  const text = file ? file.content : detail.body;
  const markdown = file ? /\.md$/i.test(file.path) : detail.summary.format === 'markdown';
  const truncated = file ? file.truncated : detail.bodyTruncated;
  let body: ReactNode;
  if (file?.binary) body = <p className={styles.code}>A binary file ({formatBytes(file.bytes)}): nothing to show.</p>;
  else if (!text) body = <p className={styles.code}>Empty.</p>;
  else if (markdown) body = <Suspense fallback={<pre className={styles.code}>{text}</pre>}><ChatMarkdown text={text} /></Suspense>;
  else body = <pre className={styles.code}>{text}</pre>;
  return (
    <section aria-label="Preview">
      <div className={styles.previewHead}>
        <span className={styles.previewName}>{file ? file.path : 'Preview'}{truncated ? ' · cut short' : ''}</span>
        {file && <Button variant="secondary" onClick={onBack}>Main file</Button>}
      </div>
      <div className={styles.preview} data-testid="resource-preview">{body}</div>
    </section>
  );
}

export default function ResourceItemScreen({ id }: { id: string }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const now = useClock();
  const readItem = useCallback(({ signal }: { refresh: boolean; signal: AbortSignal }) => fetchPhoneResource(id, signal), [id]);
  const item = useCloudRead<PhoneResourceDetail>(readItem);
  const library = useCloudRead<PhoneLibrary>(readLibrary);
  const notes = usePhoneSkillNotes();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [file, setFile] = useState<PhoneResourceFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) return;
    const controller = new AbortController();
    fetchPhoneResourceFile(id, filePath, controller.signal)
      .then((f) => { setFile(f); setFileError(null); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setFileError(err instanceof Error ? err.message : 'Couldn’t read this file.'); });
    return () => controller.abort();
  }, [id, filePath]);

  const detail = item.data;
  const summary = detail?.summary;
  const projects = useMemo(() => new Map<string, PhoneProjectRef>((library.data?.projects ?? []).map((p) => [p.id, p])), [library.data]);

  let body: ReactNode;
  if (!item.loaded) body = <EmptyState live title="Loading…" message="Your Mac is reading this resource." />;
  else if (!detail || !summary) {
    body = item.error?.problem === 'missing'
      ? <EmptyState title="This resource isn’t here" message={item.error.message} />
      : <EmptyState title="Couldn’t load this resource" message={item.error?.message} action={<Button variant="primary" onClick={() => void item.refresh()}>Try again</Button>} />;
  } else {
    const note = noteForResource(notes, summary);
    const files = (detail.files ?? []).filter((f) => f.isText);
    body = (
      <>
        <ListSection header="Details">
          {resourceFacts(summary, projects, now).map((f) => <ListRow key={f.title} title={f.title} value={f.value} />)}
          <ListRow title="Path" subtitle={<span className={styles.fieldValue}>{summary.path}</span>} tall />
        </ListSection>
        {note && (note.fav || note.abbr || note.tags.length > 0) && (
          <ListSection header="Notes" footer="Edit notes on your Mac for now: RESOURCES → Library → Notes.">
            {note.fav && <ListRow title={<><span className={styles.fav} aria-hidden="true">♥</span>Favourite</>} />}
            {note.abbr && <ListRow title="Abbreviation" value={note.abbr} />}
            {note.tags.length > 0 && <ListRow title="Tags" value={note.tags.map((t) => `#${t}`).join(' ')} />}
          </ListSection>
        )}
        <UsesSection summary={summary} library={library.data} now={now} />
        <VariantsSection summary={summary} library={library.data} />
        {fileError && <p className={styles.note} role="alert">{fileError}</p>}
        <Preview detail={detail} file={filePath && file?.path === filePath ? file : null} onBack={() => { setFilePath(null); setFile(null); setFileError(null); }} />
        {files.length > 1 && (
          <ListSection header={`Files · ${files.length}`}>
            {files.map((f) => (
              <ListRow key={f.path} title={f.path} value={formatBytes(f.bytes)} onClick={() => { setFileError(null); setFilePath(f.path); }} />
            ))}
          </ListSection>
        )}
      </>
    );
  }

  return (
    <Screen title={summary?.name ?? 'Resource'} onBack={pop} backLabel="Back to Resources" testId="phone-resource-item">
      {body}
    </Screen>
  );
}
