/**
 * SavedPromptsView — More → Library → Saved prompts (AASC-47): the curated
 * prompt library the queue's 🔖 saves to (promptSnippetStore, kept on the Mac),
 * on the phone.
 *
 *   [ Search saved prompts      ]
 *   Run the full test suite…        used 4×   ›
 *
 * A row opens the prompt: its whole text, Copy, Queue it for a session, Rename
 * (its label) and Delete (confirms; it leaves the library on every device).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ConfirmSheet, EmptyState, ListRow, ListSection, Sheet } from '../kit';
import { usePromptSnippetStore, type PromptSnippet } from '@/stores/promptSnippetStore';
import { useQueueStore } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import styles from '@/styles/modules/mobile/MoreScreens.module.css';

const LABEL_MAX = 80;
const DETENTS = ['medium', 'large'] as const;
const FIT = ['fit'] as const;

let nextQueueId = Date.now();

function title(s: PromptSnippet): string {
  return s.label.trim() || s.text.split('\n').map((l) => l.trim()).find(Boolean) || '(empty)';
}

function PromptSheet({ snippet, onClose }: { snippet: PromptSnippet; onClose: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const [step, setStep] = useState<'view' | 'queue' | 'rename' | 'delete'>('view');
  const [label, setLabel] = useState(snippet.label);
  const back = useCallback(() => setStep('view'), []);
  const live = useMemo(
    () => [...sessions.values()].filter((s) => s.status !== 'ended' && !s.isFloating).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
    [sessions],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet.text);
      showToast('Copied', 'success');
    } catch {
      showToast('This browser didn’t allow copying.', 'error');
    }
  };

  const queueFor = (sessionId: string) => {
    const store = useQueueStore.getState();
    const position = store.queues.get(sessionId)?.length ?? 0;
    store.add(sessionId, { id: nextQueueId++, sessionId, text: snippet.text, position, createdAt: Date.now() });
    void usePromptSnippetStore.getState().touch(snippet.id);
    const s = sessions.get(sessionId);
    showToast(`Queued for ${s ? sessionDisplayTitle(s) : 'the session'}`, 'success');
    onClose();
  };

  return (
    <>
      <Sheet open={step === 'view'} onClose={onClose} title={title(snippet)} detents={DETENTS} testId="saved-prompt-sheet">
        <pre className={styles.promptText}>{snippet.text}</pre>
        <ListSection label="Prompt actions">
          <ListRow title="Queue it for a session" chevron onClick={() => setStep('queue')} />
          <ListRow title="Copy" onClick={() => void copy()} />
          <ListRow title="Rename" value={snippet.label || undefined} chevron onClick={() => setStep('rename')} />
          <ListRow title="Delete" destructive onClick={() => setStep('delete')} />
        </ListSection>
      </Sheet>
      <Sheet open={step === 'queue'} onClose={back} title="Queue it for…" detents={DETENTS} testId="saved-prompt-queue">
        {live.length === 0 ? (
          <EmptyState title="No live sessions" message="Start a session first." />
        ) : (
          <ListSection label="Sessions" footer="It goes to the end of that session’s queue; your Mac sends it when the session is free.">
            {live.map((s) => (
              <ListRow key={s.sessionId} title={sessionDisplayTitle(s)} subtitle={s.projectName} onClick={() => queueFor(s.sessionId)} />
            ))}
          </ListSection>
        )}
      </Sheet>
      <Sheet open={step === 'rename'} onClose={back} title="Rename" detents={FIT} testId="saved-prompt-rename">
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void usePromptSnippetStore.getState().setLabel(snippet.id, label.trim());
            showToast('Renamed', 'success');
            back();
          }}
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name (leave empty to show the prompt’s first line)</span>
            <input className={styles.input} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={LABEL_MAX} enterKeyHint="done" />
          </label>
          <div className={styles.actions}>
            <Button onClick={back}>Cancel</Button>
            <Button type="submit" variant="primary" disabledReason={label.trim() === snippet.label.trim() ? 'Nothing changed yet.' : undefined}>Save</Button>
          </div>
        </form>
      </Sheet>
      <ConfirmSheet
        open={step === 'delete'}
        title="Delete this saved prompt?"
        message="It leaves your saved prompts on every device. Prompts already queued stay."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          void usePromptSnippetStore.getState().remove(snippet.id);
          showToast('Deleted', 'info');
          onClose();
        }}
        onCancel={back}
      />
    </>
  );
}

export default function SavedPromptsView() {
  const snippets = usePromptSnippetStore((s) => s.snippets);
  const loaded = usePromptSnippetStore((s) => s.loaded);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const close = useCallback(() => setOpenId(null), []);

  useEffect(() => {
    if (!usePromptSnippetStore.getState().loaded) void usePromptSnippetStore.getState().loadFromDb();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? snippets.filter((s) => `${s.label}\n${s.text}`.toLowerCase().includes(q)) : snippets;
    return [...list].sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  }, [snippets, query]);
  const open = openId !== null ? snippets.find((s) => s.id === openId) : undefined;

  return (
    <div className={styles.page}>
      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search saved prompts"
          aria-label="Search saved prompts"
          enterKeyHint="search"
        />
      </div>
      {!loaded ? (
        <EmptyState live title="Loading…" />
      ) : snippets.length === 0 ? (
        <EmptyState title="No saved prompts yet" message="Save a prompt with 🔖 in a session’s queue, on the phone or your Mac." />
      ) : shown.length === 0 ? (
        <EmptyState title={`Nothing matches “${query}”`} action={<Button onClick={() => setQuery('')}>Clear search</Button>} />
      ) : (
        <ListSection label="Saved prompts" footer={`${snippets.length} saved · kept on your Mac`}>
          {shown.map((s) => (
            <ListRow
              key={s.id}
              title={title(s)}
              subtitle={s.label ? s.text.split('\n')[0] : undefined}
              value={s.useCount > 0 ? `${s.useCount}×` : undefined}
              chevron
              onClick={() => setOpenId(s.id)}
            />
          ))}
        </ListSection>
      )}
      {open && <PromptSheet key={open.id} snippet={open} onClose={close} />}
    </div>
  );
}
